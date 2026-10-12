import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@whiskeysockets/baileys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whiskeysockets/baileys")>()),
  // Baileys hands the media back in the form it is asked for.
  downloadMediaMessage: vi.fn(async (_message: unknown, type: string) =>
    type === "stream" ? Readable.from([Buffer.from("image-"), Buffer.from("bytes")]) : Buffer.from("image-bytes")),
}));

import { WhatsAppConnector } from "../index.js";
import { ATTACHMENTS_DIR } from "../../../shared/attachments.js";
import { JINN_HOME, TMP_DIR } from "../../../shared/paths.js";
import type { IncomingMessage } from "../../../shared/types.js";

/* The media of a WhatsApp message was saved as tmp/wa-attachment-<message id>.<ext>.
 * The message id is chosen by the sender's client, not by the gateway. */

const SENDER = "447700900000@s.whatsapp.net";

async function deliver(messageId: string): Promise<IncomingMessage> {
  const received: IncomingMessage[] = [];
  const connector = Object.create(WhatsAppConnector.prototype) as WhatsAppConnector;
  Object.assign(connector, {
    sock: { user: { id: "999:1@s.whatsapp.net" }, updateMediaMessage: vi.fn() },
    config: { ignoreOldMessagesOnBoot: false },
    allowedJids: new Set([SENDER]),
    bootTimeMs: 0,
    handler: (msg: IncomingMessage) => { received.push(msg); },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleMessage({
    key: { id: messageId, remoteJid: SENDER, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { imageMessage: { caption: "look at this" } },
  });
  expect(received).toHaveLength(1);
  return received[0];
}

let escaped: string;

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  escaped = `escaped-${randomUUID()}`;
});

afterEach(() => {
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(JINN_HOME, `${escaped}.jpg`), { force: true });
});

describe("where the WhatsApp connector saves media", () => {
  it("saves it in a directory of the message's own under tmp/attachments", async () => {
    const msg = await deliver("3EB0C0FFEE");
    const [attachment] = msg.attachments;
    expect(attachment.localPath!.startsWith(ATTACHMENTS_DIR + path.sep)).toBe(true);
    expect(fs.readFileSync(attachment.localPath!, "utf-8")).toBe("image-bytes");
    expect(attachment.mimeType).toBe("image/jpeg");
    expect(fs.readdirSync(TMP_DIR).filter((name) => name.startsWith("wa-attachment"))).toEqual([]);
  });

  it("does not build the file's path from the message id", async () => {
    const msg = await deliver(`x/../../${escaped}`);
    expect(fs.existsSync(path.join(JINN_HOME, `${escaped}.jpg`))).toBe(false);
    expect(msg.attachments[0].localPath!.startsWith(ATTACHMENTS_DIR + path.sep)).toBe(true);
  });

  it("gives two messages two directories", async () => {
    const first = await deliver("3EB0AAAA");
    const second = await deliver("3EB0BBBB");
    expect(path.dirname(first.attachments[0].localPath!)).not.toBe(path.dirname(second.attachments[0].localPath!));
  });
});
