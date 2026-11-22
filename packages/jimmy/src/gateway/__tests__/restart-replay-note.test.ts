import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// A queue item that was already running when the gateway went down is put
// back to pending and run again from the start. The engine may have done part
// of the work, or posted part of its answer, before the process died. The
// replayed turn is told so, and asked to check before it acts or posts.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "restart-replay-note-home-"));

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

const STARTED_WAKE = '✅ Detached job "report" completed successfully (exit 0).';
const NEVER_STARTED_WAKE = '✅ Detached job "pdf" completed successfully (exit 0).';

describe("resumePendingWebQueueItems — items a restart cut off mid-run", () => {
  let engineRun: ReturnType<typeof vi.fn>;
  let recovered: string[] = [];
  let startedItemId = "";
  let RESTART_REPLAY_NOTE = "";

  beforeAll(async () => {
    const { resumePendingWebQueueItems } = await import("../api.js");
    const registry = await import("../../sessions/registry.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    ({ RESTART_REPLAY_NOTE } = await import("../../sessions/restart-resume.js"));

    engineRun = vi.fn(async () => ({ result: "done", sessionId: "es-1", numTurns: 1 }));
    const engines = new Map<string, Engine>([["claude", { run: engineRun } as unknown as Engine]]);
    const sessionManager = new SessionManager(STUB_CONFIG, engines, ["slack"]);

    const fakeSlack = {
      name: "slack",
      replyMessage: vi.fn(async () => "ts"),
      addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({
        channel: typeof rc.channel === "string" ? rc.channel : "",
        thread: typeof rc.thread === "string" ? rc.thread : undefined,
      }),
    } as unknown as Connector;

    const wakeSession = (channel: string, text: string) => {
      const session = registry.createSession({
        engine: "claude",
        source: "slack",
        sourceRef: channel,
        connector: "slack",
        sessionKey: `slack:${channel}:1.2`,
        replyContext: { channel, thread: "1.2" },
        prompt: "資料を作って",
      });
      registry.insertMessage(session.id, "notification", text);
      return registry.enqueueQueueItem(session.id, session.sessionKey, text);
    };

    // One wake-up was mid-run when the process died, the other never started.
    startedItemId = wakeSession("C_STARTED", STARTED_WAKE);
    wakeSession("C_WAITING", NEVER_STARTED_WAKE);
    expect(registry.markQueueItemRunning(startedItemId)).toBe(true);

    recovered = registry.recoverStaleQueueItems();

    const context = {
      config: STUB_CONFIG,
      getConfig: () => STUB_CONFIG,
      sessionManager,
      startTime: 0,
      emit: () => {},
      connectors: new Map([["slack", fakeSlack]]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resumePendingWebQueueItems(context as any, { restartInterruptedItemIds: new Set(recovered) });
  });

  afterAll(() => {
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("reports which items were running when the gateway went down", () => {
    expect(recovered).toEqual([startedItemId]);
  });

  it("tells a replayed turn to check before it redoes or reposts anything", async () => {
    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    const prompts = engineRun.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);

    const started = prompts.find((p) => p.includes(STARTED_WAKE));
    expect(started).toContain(RESTART_REPLAY_NOTE);
    expect(started!.indexOf(RESTART_REPLAY_NOTE)).toBeLessThan(started!.indexOf(STARTED_WAKE));

    const waiting = prompts.find((p) => p.includes(NEVER_STARTED_WAKE));
    expect(waiting).toBeDefined();
    expect(waiting).not.toContain(RESTART_REPLAY_NOTE);
  });
});
