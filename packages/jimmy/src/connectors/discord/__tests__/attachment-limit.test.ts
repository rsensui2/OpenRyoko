import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { DiscordConnector } from "../index.js";
import { ATTACHMENTS_DIR } from "../../../shared/attachments.js";
import { TMP_DIR } from "../../../shared/paths.js";
import type { DiscordConnectorConfig, IncomingMessage } from "../../../shared/types.js";

/* An attachment the connector does not fetch used to vanish: the session got
 * the message as if nothing had been attached, and nobody told the sender.
 * With a size limit in force that is no longer a rare network failure but
 * what happens to every large video. The limit is the connector's own
 * setting (`maxAttachmentMb`, 200 MB unless set), and a file that is not
 * fetched is reported to the session — which one, and why. */

const MB = 1024 * 1024;
const outbound = vi.fn<typeof fetch>();

interface Sent { name: string; url: string; contentType?: string; size?: number }
const file = (n: number, size?: number): Sent => ({ name: `clip-${n}.mp4`, url: `https://cdn.discordapp.com/attachments/1/${n}/clip-${n}.mp4`, contentType: "video/mp4", size });

function fakeMessage(content: string, attachments: Sent[]) {
  return {
    id: "M1",
    type: MessageType.Default,
    content,
    author: { id: "U1", username: "user", bot: false },
    system: false,
    webhookId: undefined,
    createdTimestamp: Date.now() + 60_000,
    guild: undefined,
    channel: { id: "C1", name: "general", isDMBased: () => false, isThread: () => false, isTextBased: () => true },
    mentions: { users: new Map(), repliedUser: null },
    reference: undefined,
    fetchReference: vi.fn().mockRejectedValue(new Error("no reference")),
    attachments: new Map(attachments.map((attachment, index) => [`A${index}`, attachment])),
  };
}

async function deliver(content: string, attachments: Sent[], config: Partial<DiscordConnectorConfig> = {}): Promise<IncomingMessage> {
  const connector = new DiscordConnector({ botToken: "test-token", ...config });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = { user: { id: "999000999" } };
  const received: IncomingMessage[] = [];
  connector.onMessage((msg) => received.push(msg));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleMessage(fakeMessage(content, attachments));
  expect(received).toHaveLength(1);
  return received[0];
}

/** A response that announces `bytes` and would never be read that far. */
const announcing = (bytes: number) => ({
  ok: true, status: 200, headers: new Headers({ "content-length": String(bytes) }), body: { cancel: vi.fn(async () => {}) },
}) as unknown as Response;
const requested = () => outbound.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  outbound.mockReset().mockImplementation(async (url) => new Response(`contents of ${String(url)}`));
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
});

describe("Discord attachments and the size limit", () => {
  it("tells the session which attachment was too large and what the limit is, and hands over the others", async () => {
    outbound.mockImplementation(async (url) => (String(url).includes("/2/") ? announcing(201 * MB) : new Response("bytes")));

    const msg = await deliver("see attached", [file(1), file(2), file(3)]);

    expect(msg.attachments.map((attachment) => attachment.name)).toEqual(["clip-1.mp4", "clip-3.mp4"]);
    expect(msg.text.startsWith("see attached\n\n[System attachment notice: ")).toBe(true);
    expect(msg.text).toContain("Discord attachment(s) could not be retrieved: attachment 2 of 3 (larger than the 200 MB attachment limit).");
    expect(msg.text).not.toContain("clip-2.mp4"); // the name is the sender's text; the notice is the connector's
  });

  it("keeps a 120 MB video: the limit is 200 MB unless the connector sets one", async () => {
    outbound.mockImplementation(async () => new Response("a-video", { headers: { "content-length": String(120 * MB) } }));
    const msg = await deliver("see attached", [file(1, 120 * MB)]);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.text).toBe("see attached");
  });

  it("does not ask for a file Discord itself says is over the limit", async () => {
    const msg = await deliver("see attached", [file(1, 300 * MB), file(2, 1024)]);

    expect(requested()).toEqual([file(2).url]);
    expect(msg.attachments.map((attachment) => attachment.name)).toEqual(["clip-2.mp4"]);
    expect(msg.text).toContain("attachment 1 of 2 (larger than the 200 MB attachment limit)");
  });

  it("uses the connector's maxAttachmentMb", async () => {
    const small = await deliver("see attached", [file(1, 2 * MB)], { maxAttachmentMb: 1 });
    expect(small.attachments).toEqual([]);
    expect(small.text).toContain("attachment 1 of 1 (larger than the 1 MB attachment limit)");

    const large = await deliver("see attached", [file(1, 300 * MB)], { maxAttachmentMb: 500 });
    expect(large.attachments).toHaveLength(1);
    expect(large.text).toBe("see attached");
  });

  it("says so, too, when a file could not be fetched for any other reason", async () => {
    outbound.mockImplementation(async () => new Response("gone", { status: 404 }));
    const msg = await deliver("see attached", [file(1)]);
    expect(msg.attachments).toEqual([]);
    expect(msg.text).toContain("could not be retrieved: attachment 1 of 1.");
  });

  it("adds nothing to a message whose attachments all arrived, or that has none", async () => {
    expect((await deliver("see attached", [file(1), file(2)])).text).toBe("see attached");
    expect((await deliver("no files", [])).text).toBe("no files");
  });

  it("leaves a slash command exactly as it was typed", async () => {
    const msg = await deliver("/status", [file(1, 300 * MB)]);
    expect(msg.text).toBe("/status");
  });
});
