import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "discord.js";
import { DiscordConnector } from "../index.js";
import { ATTACHMENTS_DIR } from "../../../shared/attachments.js";
import { TMP_DIR } from "../../../shared/paths.js";
import type { IncomingMessage } from "../../../shared/types.js";

/* Anybody who may message the bot chooses the file names of what they attach.
 * The connector used to save each attachment as tmp/<that name>. */

const stateFile = path.join(TMP_DIR, "engine-health.json");
const STATE = '{"engines":{"claude":{"healthy":true}}}';

function fakeMessage(id: string, attachments: Array<{ name: string; url: string; contentType?: string }>) {
  return {
    id,
    type: MessageType.Default,
    content: "see attached",
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

async function deliver(message: ReturnType<typeof fakeMessage>): Promise<IncomingMessage> {
  const connector = new DiscordConnector({ botToken: "test-token" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = { user: { id: "999000999" } };
  const received: IncomingMessage[] = [];
  connector.onMessage((msg) => received.push(msg));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleMessage(message);
  expect(received).toHaveLength(1);
  return received[0];
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(stateFile, STATE);
  // Every URL answers with its own address, so each saved file says where it came from.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(`contents of ${url}`)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  fs.rmSync(stateFile, { force: true });
});

describe("where the Discord connector saves attachments", () => {
  it("does not let an attachment named like a state file replace that file", async () => {
    const msg = await deliver(fakeMessage("M1", [{ name: "engine-health.json", url: "https://cdn.discordapp.com/a/1/engine-health.json" }]));

    expect(fs.readFileSync(stateFile, "utf-8")).toBe(STATE);
    const [attachment] = msg.attachments;
    expect(attachment.name).toBe("engine-health.json");
    expect(path.basename(attachment.localPath!)).toBe("engine-health.json"); // the engine still sees the name it was given
    expect(attachment.localPath!.startsWith(ATTACHMENTS_DIR + path.sep)).toBe(true);
    expect(fs.readFileSync(attachment.localPath!, "utf-8")).toContain("engine-health.json");
  });

  it("keeps two attachments of one message apart even when they share a name", async () => {
    const msg = await deliver(fakeMessage("M1", [
      { name: "image.png", url: "https://cdn.discordapp.com/a/1/first.png" },
      { name: "image.png", url: "https://cdn.discordapp.com/a/2/second.png" },
    ]));

    const [first, second] = msg.attachments.map((attachment) => attachment.localPath!);
    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, "utf-8")).toContain("first.png");
    expect(fs.readFileSync(second, "utf-8")).toContain("second.png");
  });

  it("gives every message one directory of its own", async () => {
    const one = await deliver(fakeMessage("M1", [
      { name: "a.txt", url: "https://cdn.discordapp.com/a/1/a.txt" },
      { name: "b.txt", url: "https://cdn.discordapp.com/a/1/b.txt" },
    ]));
    const two = await deliver(fakeMessage("M2", [{ name: "a.txt", url: "https://cdn.discordapp.com/a/2/a.txt" }]));

    const messageDir = (file: string) => path.relative(ATTACHMENTS_DIR, file).split(path.sep)[0];
    const [a, b] = one.attachments.map((attachment) => attachment.localPath!);
    expect(messageDir(a)).toBe(messageDir(b));
    expect(messageDir(two.attachments[0].localPath!)).not.toBe(messageDir(a));
    expect(fs.readFileSync(a, "utf-8")).toContain("/a/1/a.txt"); // the second message did not overwrite it
  });

  it("creates no directory for a message without attachments", async () => {
    await deliver(fakeMessage("M1", []));
    expect(fs.existsSync(ATTACHMENTS_DIR) ? fs.readdirSync(ATTACHMENTS_DIR) : []).toEqual([]);
  });
});
