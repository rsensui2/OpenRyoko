import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (args: { event: Record<string, unknown> }) => Promise<void>;

const world = vi.hoisted(() => ({ apps: [] as Array<{ onMessage?: Listener }> }));

// No test here reaches Slack: Bolt's App is a stand-in that records the
// listeners the connector registers.
vi.mock("@slack/bolt", () => ({
  App: class {
    client = {
      token: "xoxb-test",
      auth: { test: vi.fn(async () => ({ user_id: "URYOKO" })) },
      chat: { postMessage: vi.fn(async () => ({ ts: "900.000" })) },
      users: { info: vi.fn(async () => ({ user: { name: "Taro" } })) },
      conversations: {
        info: vi.fn(async () => ({ channel: { name: "general" } })),
        replies: vi.fn(async () => ({ messages: [] })),
        history: vi.fn(async () => ({ messages: [] })),
      },
      reactions: { add: vi.fn(async () => ({})) },
      files: { info: vi.fn() },
    };
    onMessage?: Listener;
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    constructor() { world.apps.push(this); }
    action() {}
    view() {}
    message(listener: Listener) { this.onMessage = listener; }
    event() {}
  },
}));
vi.mock("../format.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../format.js")>(),
  downloadAttachment: vi.fn(async (_url: string, _token: string, destDir: string) => path.join(destDir, "saved.bin")),
}));

const { connectorConfig } = await import("../../../gateway/connector-config.js");
const { downloadAttachment } = await import("../format.js");
const { SlackConnector } = await import("../index.js");

/* The two settings that were written in config.yaml, documented, and ignored
 * for the top-level Slack connector: `respondTo` (when the bot may answer at
 * all) and `maxAttachmentMb`. Checked here on a real connector, made from what
 * the gateway hands it for a top-level block and for an instance alike. */

const MB = 1024 * 1024;
const TOKENS = { appToken: "xapp-test", botToken: "xoxb-test" };

async function connect(settings: Record<string, unknown>, where: "top-level" | "instance") {
  const config = where === "top-level" ? connectorConfig({ ...TOKENS, ...settings }) : connectorConfig({ id: "slack-sales", type: "slack", ...TOKENS, ...settings });
  const connector = new SlackConnector(config as never, {});
  const routed = vi.fn();
  connector.onMessage(routed);
  await connector.start();
  const app = world.apps.at(-1)!;
  let sequence = 0;
  const post = (text: string, extra: Record<string, unknown> = {}) => {
    sequence += 1;
    return app.onMessage!({ event: {
      user: "U1", channel: "C1", channel_type: "channel", text,
      ts: `${Math.floor(Date.now() / 1000) + 60}.${String(sequence).padStart(6, "0")}`, ...extra,
    } });
  };
  return { routed, post };
}

beforeEach(() => {
  world.apps.length = 0;
  vi.mocked(downloadAttachment).mockClear();
});

describe.each([["top-level"], ["instance"]] as const)("a Slack connector made from a %s block", (where) => {
  it("answers only when mentioned in a channel, once respondTo says so", async () => {
    const f = await connect({ respondTo: { im: "always", channel: "mention" } }, where);

    await f.post("誰か知ってる？");
    expect(f.routed).not.toHaveBeenCalled();

    await f.post("<@URYOKO> 教えて");
    expect(f.routed).toHaveBeenCalledTimes(1);

    await f.post("DM です", { channel: "D1", channel_type: "im" });
    expect(f.routed).toHaveBeenCalledTimes(2);
  });

  it("answers everything it sees when respondTo is not written, as it always has", async () => {
    const f = await connect({}, where);
    await f.post("誰か知ってる？");
    expect(f.routed).toHaveBeenCalledTimes(1);
  });

  it("downloads attachments up to its own maxAttachmentMb", async () => {
    const f = await connect({ maxAttachmentMb: 500 }, where);
    await f.post("これ見て", { files: [{ id: "F1", name: "clip.mp4", mimetype: "video/mp4", url_private_download: "https://files.slack.com/files-pri/T1-F1/download/clip.mp4" }] });
    expect(vi.mocked(downloadAttachment).mock.calls.map((call) => call[3])).toEqual([500 * MB]);
  });

  it("downloads up to 200 MB when maxAttachmentMb is not written", async () => {
    const f = await connect({}, where);
    await f.post("これ見て", { files: [{ id: "F1", name: "clip.mp4", mimetype: "video/mp4", url_private_download: "https://files.slack.com/files-pri/T1-F1/download/clip.mp4" }] });
    expect(vi.mocked(downloadAttachment).mock.calls.map((call) => call[3])).toEqual([200 * MB]);
  });
});
