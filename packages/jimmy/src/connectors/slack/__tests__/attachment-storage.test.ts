import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../index.js";
import { ConversationTracker } from "../conversation-tracker.js";
import { runTriage } from "../triage.js";
import { downloadAttachment } from "../format.js";
import { ATTACHMENTS_DIR } from "../../../shared/attachments.js";

vi.mock("../triage.js", () => ({ runTriage: vi.fn() }));
vi.mock("../format.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../format.js")>(),
  downloadAttachment: vi.fn(async (_url: string, _token: string, destDir: string) => path.join(destDir, "saved.bin")),
}));
afterEach(() => { vi.clearAllMocks(); });

/* Slack files are saved under generated names, so they cannot replace a state
 * file in tmp/. They still belong in a directory of the message's own: that is
 * what the end-of-turn cleanup removes, and all it is allowed to remove. */

async function fixture() {
  let receive: (args: { event: Record<string, unknown> }) => Promise<void>;
  const handler = vi.fn();
  const connector = Object.create(SlackConnector.prototype) as SlackConnector;
  Object.assign(connector, {
    app: {
      message: (callback: typeof receive) => { receive = callback; },
      event: () => {}, start: vi.fn(),
      client: {
        token: "xoxb-test",
        auth: { test: vi.fn().mockResolvedValue({ user_id: "URYOKO" }) },
        conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }), history: vi.fn().mockResolvedValue({ messages: [] }), info: vi.fn().mockResolvedValue({ channel: { name: "test" } }) },
        users: { info: vi.fn().mockResolvedValue({ user: { name: "Taro" } }) },
        reactions: { add: vi.fn().mockResolvedValue({ ok: true }) }, chat: { postMessage: vi.fn().mockResolvedValue({ ts: "3.000" }) },
      },
    },
    conversations: new ConversationTracker({ now: () => 0, idleTimeoutMs: 1000 }), triageConfig: { enabled: true, backend: "jev" },
    respondTo: undefined, handler, allowedUsers: null, ignoreOldMessagesOnBoot: false,
    userInfoCache: new Map(), channelNameCache: new Map(), agentsCanvas: null,
  });
  vi.mocked(runTriage).mockResolvedValue({ action: "reply" });
  await connector.start();
  const upload = (ts: string, names: string[]) => receive!({ event: {
    channel: "D1", user: "U1", ts, channel_type: "im", text: "",
    files: names.map((name, index) => ({ id: `F${ts}-${index}`, name, mimetype: "text/plain", url_private_download: `https://files.slack.com/${name}` })),
  } });
  return { handler, upload };
}

const directoriesUsed = () => vi.mocked(downloadAttachment).mock.calls.map(([, , destDir]) => destDir);

describe("where the Slack connector saves attachments", () => {
  it("saves a message's files into one directory of that message's own under tmp/attachments", async () => {
    const f = await fixture();
    await f.upload("4.000", ["report.txt", "notes.txt"]);

    const [first, second] = directoriesUsed();
    expect(path.dirname(first)).toBe(ATTACHMENTS_DIR);
    expect(second).toBe(first);
    expect(f.handler.mock.calls[0][0].attachments.map((attachment: { localPath: string }) => attachment.localPath))
      .toEqual([path.join(first, "saved.bin"), path.join(first, "saved.bin")]);
  });

  it("uses a different directory for the next message", async () => {
    const f = await fixture();
    await f.upload("4.000", ["report.txt"]);
    await f.upload("5.000", ["report.txt"]);

    const [first, second] = directoriesUsed();
    expect(path.dirname(second)).toBe(ATTACHMENTS_DIR);
    expect(second).not.toBe(first);
  });
});
