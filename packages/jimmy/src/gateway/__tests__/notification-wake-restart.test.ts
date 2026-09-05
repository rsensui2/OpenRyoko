import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// Gateway-restart recovery for notification wake-ups (issue #38 follow-up):
// the job monitor got its 200 (message persisted + queue item enqueued) and
// will never re-send. If the gateway dies before running the turn, the resume
// pass must replay the queue item FOR CONNECTOR-ORIGIN SESSIONS TOO — and
// with origin-connector delivery, or the customer thread stays silent.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wake-restart-home-"));

const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  sessions: {},
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

describe("resumePendingWebQueueItems — connector-origin notification wake-ups", () => {
  let replyMessage: ReturnType<typeof vi.fn>;
  let engineRun: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const { resumePendingWebQueueItems } = await import("../api.js");
    const { createSession, insertMessage, enqueueQueueItem } = await import("../../sessions/registry.js");
    const { SessionManager } = await import("../../sessions/manager.js");

    engineRun = vi.fn(async () => ({ result: "遅れましたが完成しました", sessionId: "es-1", numTurns: 1 }));
    const engines = new Map<string, Engine>([["claude", { run: engineRun } as unknown as Engine]]);
    const sessionManager = new SessionManager(STUB_CONFIG, engines, ["slack"]);

    replyMessage = vi.fn(async () => "ts");
    const fakeSlack = {
      name: "slack",
      replyMessage,
      addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({
        channel: typeof rc.channel === "string" ? rc.channel : "",
        thread: typeof rc.thread === "string" ? rc.thread : undefined,
      }),
    } as unknown as Connector;

    // Simulate the pre-restart state the monitor left behind: notification
    // message persisted + queue item pending, but no turn ever ran.
    const wakeText = '✅ Detached job "pdf" completed successfully (exit 0).';
    const slackSession = createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_CUST",
      connector: "slack",
      sessionKey: "slack:C_CUST:1.2",
      replyContext: { channel: "C_CUST", thread: "1.2" },
      transportMeta: { channelExternal: true },
      prompt: "資料を作って",
    });
    insertMessage(slackSession.id, "notification", wakeText);
    enqueueQueueItem(slackSession.id, slackSession.sessionKey, wakeText);

    // Control: a connector session with a pending USER prompt must stay
    // untouched (pre-existing behavior — the connector route owns it).
    const userSession = createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_OTHER",
      connector: "slack",
      sessionKey: "slack:C_OTHER:9.9",
      replyContext: { channel: "C_OTHER", thread: "9.9" },
      prompt: "こんにちは",
    });
    insertMessage(userSession.id, "user", "続きをやって");
    enqueueQueueItem(userSession.id, userSession.sessionKey, "続きをやって");

    const context = {
      config: STUB_CONFIG,
      getConfig: () => STUB_CONFIG,
      sessionManager,
      startTime: 0,
      emit: () => {},
      connectors: new Map([["slack", fakeSlack]]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resumePendingWebQueueItems(context as any);
  });

  afterAll(() => {
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("replays the notification wake-up and delivers to the original thread", async () => {
    await vi.waitFor(() => {
      expect(replyMessage).toHaveBeenCalledTimes(1);
    }, { timeout: 10_000 });

    const [target, text] = replyMessage.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toMatchObject({ channel: "C_CUST", thread: "1.2" });
    expect(text).toBe("遅れましたが完成しました");
    // Only the notification item ran — the user-prompt item was left alone.
    expect(engineRun).toHaveBeenCalledTimes(1);
  });
});
