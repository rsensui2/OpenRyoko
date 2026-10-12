import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../index.js";
import { ConversationTracker } from "../conversation-tracker.js";
import { runTriage } from "../triage.js";
import { downloadAttachment } from "../format.js";

vi.mock("../triage.js", () => ({ runTriage: vi.fn() }));
vi.mock("../format.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../format.js")>(),
  downloadAttachment: vi.fn(async (_url: string, _token: string, destDir: string) => path.join(destDir, "saved.bin")),
}));
afterEach(() => { vi.clearAllMocks(); });

/* In a channel the bot reads, most messages are not for it: the triage says
 * "silent" or "react", and no turn runs. The connector used to download every
 * file of every such message first — up to the size limit each — and then
 * leave the files where they were, since only a turn cleans up after itself.
 * Files are now fetched once the message is going to be answered. */

async function fixture() {
  let receive: (args: { event: Record<string, unknown> }) => Promise<void>;
  const handler = vi.fn();
  const reactions = vi.fn().mockResolvedValue({ ok: true });
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
        reactions: { add: reactions }, chat: { postMessage: vi.fn().mockResolvedValue({ ts: "3.000" }) },
        files: { info: vi.fn() },
      },
    },
    conversations: new ConversationTracker({ now: () => 0, idleTimeoutMs: 1000 }), triageConfig: { enabled: true, backend: "jev" },
    respondTo: undefined, handler, allowedUsers: null, ignoreOldMessagesOnBoot: false,
    userInfoCache: new Map(), channelNameCache: new Map(), agentsCanvas: null,
  });
  await connector.start();
  /** A message in a public channel, not addressed to the bot, with files attached. */
  const post = (text: string, names: string[], extra: Record<string, unknown> = {}) => receive!({ event: {
    channel: "C1", user: "U1", ts: "4.000", channel_type: "channel", text,
    files: names.map((name, index) => ({ id: `F${index}`, name, mimetype: "text/plain", url_private_download: `https://files.slack.com/${name}` })),
    ...extra,
  } });
  return { handler, reactions, post };
}

const downloads = vi.mocked(downloadAttachment);

describe("Slack attachments and the triage", () => {
  it("does not download the files of a message it stays silent on", async () => {
    vi.mocked(runTriage).mockResolvedValue({ action: "silent", reason: "not for the bot" });
    const f = await fixture();

    await f.post("昨日の議事録です", ["minutes.pdf", "slides.pdf"]);

    expect(runTriage).toHaveBeenCalledTimes(1);
    expect(f.handler).not.toHaveBeenCalled();
    expect(downloads).not.toHaveBeenCalled();
  });

  it("does not download the files of a message it only reacts to", async () => {
    vi.mocked(runTriage).mockResolvedValue({ action: "react", emoji: "+1" });
    const f = await fixture();

    await f.post("共有ありがとう！", ["photo.png"]);

    expect(f.reactions).toHaveBeenCalledWith(expect.objectContaining({ name: "+1" }));
    expect(f.handler).not.toHaveBeenCalled();
    expect(downloads).not.toHaveBeenCalled();
  });

  it("downloads them once it has decided to answer, and hands them to the session with the message", async () => {
    vi.mocked(runTriage).mockResolvedValue({ action: "reply" });
    const f = await fixture();

    await f.post("この資料を要約して", ["report.txt", "notes.txt"]);

    expect(downloads).toHaveBeenCalledTimes(2);
    const [msg] = f.handler.mock.calls[0];
    expect(msg.attachments.map((attachment: { name: string }) => attachment.name)).toEqual(["report.txt", "notes.txt"]);
    expect(msg.attachments.every((attachment: { localPath?: string }) => attachment.localPath?.endsWith("saved.bin"))).toBe(true);
    expect(msg.text).toBe("この資料を要約して");
  });

  it("shows it has seen the message before it starts downloading", async () => {
    vi.mocked(runTriage).mockResolvedValue({ action: "reply" });
    const f = await fixture();

    await f.post("この資料を要約して", ["large.zip"]);

    const eyes = f.reactions.mock.calls.findIndex(([args]) => args.name === "eyes");
    expect(eyes).toBeGreaterThanOrEqual(0);
    expect(f.reactions.mock.invocationCallOrder[eyes]).toBeLessThan(downloads.mock.invocationCallOrder[0]);
  });

  it("tells the session which files could not be fetched, after whatever else it was told", async () => {
    vi.mocked(runTriage).mockResolvedValue({ action: "reply", reason: "jev_proactive_contribution" });
    downloads.mockImplementationOnce(async () => { throw new Error("Attachment is too large (limit 52428800 bytes)"); });
    const f = await fixture();

    await f.post("毎月この集計に3時間かかる", ["huge.bin", "small.txt"]);

    const [msg] = f.handler.mock.calls[0];
    expect(msg.attachments.map((attachment: { name: string }) => attachment.name)).toEqual(["small.txt"]);
    expect(msg.text.startsWith("[Application routing context:")).toBe(true);
    expect(msg.text).toContain("毎月この集計に3時間かかる");
    expect(msg.text).toContain("Slack file F0");
    expect(msg.text.indexOf("Slack file F0")).toBeGreaterThan(msg.text.indexOf("毎月この集計に3時間かかる"));
  });

  it("counts a message with a file as more than a bare thanks, whether or not the file can be fetched", async () => {
    downloads.mockImplementationOnce(async () => { throw new Error("unavailable"); });
    const f = await fixture();

    await f.post("ありがとう", ["receipt.pdf"], { channel: "D1", channel_type: "im" });

    expect(runTriage).not.toHaveBeenCalled(); // a DM with a file is answered, not sent to the react-only triage
    expect(f.handler).toHaveBeenCalledTimes(1);
  });
});
