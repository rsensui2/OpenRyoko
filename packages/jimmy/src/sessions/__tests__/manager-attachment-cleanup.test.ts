import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { ATTACHMENTS_DIR, attachmentSlot, newAttachmentDir } from "../../shared/attachments.js";
import { TMP_DIR } from "../../shared/paths.js";
import { confineRemovals, type ConfinedRemovals } from "../../shared/test-support/confined-removals.js";
import type { Attachment, Connector, Engine, EngineRunOpts, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../goal-execution.js", () => ({
  sessionGoalOptions: () => ({}),
  runWithSessionGoal: (engine: Engine, opts: EngineRunOpts) => engine.run(opts),
}));

/* When a turn ends, the session removes the attachments that were downloaded
 * for it. It used to delete each `localPath` it was given, whatever that path
 * was. It now removes the message's own directory under tmp/attachments/ and
 * nothing else.
 *
 * This drives code that deletes, so fs.rmSync is confined to tmp/attachments/
 * of the test home for every test: a removal asked for anywhere else is
 * recorded and dropped, and shows up as a failed assertion. */

const stateFile = path.join(TMP_DIR, "engine-health.json");
let removals: ConfinedRemovals;
let sequence = 0;

function setup(attachments: Attachment[]) {
  const config = {
    engines: { default: "codex", codex: { bin: "codex" } },
    connectors: { discord: {} }, sessions: {}, logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;
  const seen: Array<{ paths: string[]; existed: boolean[] }> = [];
  const run = vi.fn<Engine["run"]>().mockImplementation(async (opts) => {
    const paths = opts.attachments ?? [];
    seen.push({ paths, existed: paths.map((file) => fs.existsSync(file)) });
    return { sessionId: "native-test", result: "done" };
  });
  const manager = new SessionManager(config, new Map<string, Engine>([["codex", { name: "codex", run } as Engine]]));
  const sessionKey = `discord:attachment-cleanup-${++sequence}`;
  const msg = {
    connector: "discord", source: "discord", sessionKey, channel: "C-attachments",
    messageId: `M${sequence}`, user: "Test", userId: "U-test", text: "see attached", attachments, raw: {},
    replyContext: { channel: "C-attachments" }, transportMeta: {},
  } as unknown as IncomingMessage;
  const reply = vi.fn(async () => undefined);
  const connector = {
    name: "discord", replyMessage: reply, sendMessage: reply,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: false, messageEdits: false, reactions: false, attachments: true }),
    reconstructTarget: () => ({ channel: "C-attachments" }),
  } as unknown as Connector;
  return { manager, connector, msg, seen };
}

function saved(dir: string, slot: number, name: string): string {
  const file = path.join(attachmentSlot(dir, slot), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "bytes");
  return file;
}

beforeEach(() => {
  removals = confineRemovals(ATTACHMENTS_DIR);
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  fs.writeFileSync(stateFile, '{"engines":{}}');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const entry of fs.readdirSync(ATTACHMENTS_DIR)) removals.remove(path.join(ATTACHMENTS_DIR, entry), { recursive: true, force: true });
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
});

describe("attachment cleanup at the end of a turn", () => {
  it("gives the engine the files, then removes the message's whole attachment directory", async () => {
    const dir = newAttachmentDir();
    const files = [saved(dir, 0, "image.png"), saved(dir, 1, "image.png")];
    const other = saved(newAttachmentDir(), 0, "someone-elses.png");
    const { manager, connector, msg, seen } = setup(files.map((localPath) => ({ name: "image.png", url: "", mimeType: "image/png", localPath })));

    await manager.route(msg, connector);

    expect(seen).toEqual([{ paths: files, existed: [true, true] }]);
    expect(removals.requests).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("removes the directory of a message that was dropped from the queue before its turn started", async () => {
    const dir = newAttachmentDir();
    const file = saved(dir, 0, "image.png");
    const { manager, connector, msg, seen } = setup([{ name: "image.png", url: "", mimeType: "image/png", localPath: file }]);
    vi.spyOn(manager.getQueue(), "enqueue").mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(manager.route(msg, connector)).rejects.toThrow("queue unavailable");

    expect(seen).toEqual([]); // no turn ran, so no turn cleaned up after itself
    expect(removals.requests).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does not delete a file outside tmp/attachments because a message pointed at it", async () => {
    const { manager, connector, msg } = setup([{ name: "engine-health.json", url: "", mimeType: "application/json", localPath: stateFile }]);

    await manager.route(msg, connector);

    expect(removals.requests).toEqual([]);
    expect(fs.readFileSync(stateFile, "utf-8")).toBe('{"engines":{}}');
  });
});
