import fs from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@whiskeysockets/baileys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whiskeysockets/baileys")>()),
  downloadMediaMessage: vi.fn(),
}));
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { WhatsAppConnector } from "../index.js";
import { ATTACHMENTS_DIR } from "../../../shared/attachments.js";
import { TMP_DIR } from "../../../shared/paths.js";
import type { IncomingMessage } from "../../../shared/types.js";

/* WhatsApp media is the sender's choice of size. It used to be taken whole
 * into memory, whatever its size, and then written out. It is now read as a
 * stream that stops at the connector's limit (`maxAttachmentMb`, 200 MB
 * unless set), and media announced as larger is not asked for at all. Either
 * way the message itself is still delivered — and says what is missing. */

const SENDER = "447700900000@s.whatsapp.net";
const MB = 1024 * 1024;
const media = vi.mocked(downloadMediaMessage);
/** A limit of sixteen bytes, written the way the setting is: in megabytes. */
const SIXTEEN_BYTES = { maxAttachmentMb: 16 / MB };

async function deliver(imageMessage: Record<string, unknown>, settings: Record<string, unknown> = SIXTEEN_BYTES): Promise<IncomingMessage> {
  const received: IncomingMessage[] = [];
  const connector = Object.create(WhatsAppConnector.prototype) as WhatsAppConnector;
  Object.assign(connector, {
    sock: { user: { id: "999:1@s.whatsapp.net" }, updateMediaMessage: vi.fn() },
    config: { ignoreOldMessagesOnBoot: false, ...settings },
    allowedJids: new Set([SENDER]),
    bootTimeMs: 0,
    handler: (msg: IncomingMessage) => { received.push(msg); },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleMessage({
    key: { id: "3EB0C0FFEE", remoteJid: SENDER, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { imageMessage: { caption: "look at this", ...imageMessage } },
  });
  expect(received).toHaveLength(1);
  return received[0];
}

const savedFiles = () =>
  fs.existsSync(ATTACHMENTS_DIR)
    ? fs.readdirSync(ATTACHMENTS_DIR, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
const streamOf = (...sizes: number[]) => Readable.from(sizes.map((size) => Buffer.alloc(size, "x")));

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  media.mockReset();
});

afterEach(() => {
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
});

describe("WhatsApp media and the size limit", () => {
  it("asks for the media as a stream, and saves it as it arrives", async () => {
    media.mockResolvedValue(streamOf(6, 10) as never);

    const msg = await deliver({});

    expect(media.mock.calls[0][1]).toBe("stream");
    expect(fs.statSync(msg.attachments[0].localPath!).size).toBe(16); // exactly the limit is fine
  });

  it("stops media that runs past the limit, leaves none of it on disk, and still delivers the message", async () => {
    const stream = streamOf(10, 10, 10, 10);
    media.mockResolvedValue(stream as never);

    const msg = await deliver({});

    expect(msg.text.startsWith("look at this\n\n[System attachment notice: ")).toBe(true);
    expect(msg.attachments).toEqual([]);
    expect(stream.destroyed).toBe(true);
    expect(savedFiles()).toEqual([]);
    expect(fs.existsSync(ATTACHMENTS_DIR) ? fs.readdirSync(ATTACHMENTS_DIR) : []).toEqual([]); // not even its directory
  });

  it.each([
    ["a number", 17],
    ["a 64-bit value the way the protocol library carries it", { low: 17, high: 0, unsigned: true, toString: () => "17" }],
    ["text", "4294967296"],
  ])("does not ask for media announced as larger than the limit (%s)", async (_form, fileLength) => {
    const msg = await deliver({ fileLength });

    expect(media).not.toHaveBeenCalled();
    expect(msg.text.startsWith("look at this\n\n[System attachment notice: ")).toBe(true);
    expect(msg.attachments).toEqual([]);
  });

  it("asks for media announced as within the limit, or not announced at all", async () => {
    media.mockImplementation(async () => streamOf(4) as never);
    expect((await deliver({ fileLength: 16 })).attachments).toHaveLength(1);
    expect((await deliver({ fileLength: null })).attachments).toHaveLength(1);
    expect(media).toHaveBeenCalledTimes(2);
  });
});

describe("WhatsApp media: the limit is the connector's, and a miss is reported", () => {
  it("asks for a 120 MB video when no limit is set: the default is 200 MB", async () => {
    media.mockImplementation(async () => streamOf(4) as never);
    const msg = await deliver({ fileLength: 120 * MB }, {});
    expect(media).toHaveBeenCalledTimes(1);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.text).toBe("look at this");
  });

  it("tells the session the media was larger than the limit, and what the limit is", async () => {
    const byDefault = await deliver({ fileLength: 201 * MB }, {});
    expect(media).not.toHaveBeenCalled();
    expect(byDefault.text).toContain("WhatsApp attachment(s) could not be retrieved: the media attachment (larger than the 200 MB attachment limit).");

    const configured = await deliver({ fileLength: 2 * MB }, { maxAttachmentMb: 1 });
    expect(configured.text).toContain("the media attachment (larger than the 1 MB attachment limit)");
  });

  it("says so, too, when the media could not be fetched for any other reason", async () => {
    media.mockRejectedValue(new Error("media key expired"));
    const msg = await deliver({}, {});
    expect(msg.attachments).toEqual([]);
    expect(msg.text).toContain("could not be retrieved: the media attachment.");
    expect(msg.text).not.toContain("media key expired");
  });

  it("leaves a slash command exactly as it was typed", async () => {
    const msg = await deliver({ caption: "/status", fileLength: 300 * MB }, {});
    expect(msg.text).toBe("/status");
  });
});
