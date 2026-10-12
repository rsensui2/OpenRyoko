import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../../gateway/api.js";
import type { Connector, CronJob, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

// The run log used to say "success" the moment route() resolved, whatever the
// turn did: runSession settles a failed turn as `status: "error"` and returns
// normally, so an expired login, an exhausted fallback chain or a failed
// delivery was recorded green and the cron alert never fired. These tests drive
// the real SessionManager with fake engines and read the run log off disk.
vi.mock("../../sessions/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/context.js")>()),
  buildContext: () => "context",
}));
vi.mock("../../sessions/callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/callbacks.js")>()),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));

import { handleApiRequest } from "../../gateway/api.js";
import { SessionManager } from "../../sessions/manager.js";
import { recordFailedOriginDelivery } from "../../sessions/origin-delivery.js";
import { createSession, getSession } from "../../sessions/registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { CRON_RUNS } from "../../shared/paths.js";
import { runCronJob } from "../runner.js";

type RunEntry = Record<string, unknown> & { sessionId?: string };

let sequence = 0;
let server: http.Server;
let baseUrl: string;
let apiContext: ApiContext;

function setup(sessions: Record<string, unknown> = {}, fallback: { claude?: string[]; codex?: string[] } = {}) {
  const job: CronJob = {
    id: `run-log-status-${++sequence}`, name: "Morning briefing", enabled: true, schedule: "0 7 * * *",
    prompt: "Write the morning briefing", delivery: { connector: "slack", channel: "C-briefing" },
  };
  const config = {
    gateway: { host: "127.0.0.1", port: 0 },
    engines: {
      default: "claude",
      claude: { bin: "claude-bin", model: "claude-model", fallback: fallback.claude ?? [] },
      codex: { bin: "codex-bin", model: "codex-model", fallback: fallback.codex ?? [] },
    },
    sessions: { transientRetryDelaysMs: [], ...sessions },
    connectors: {},
    logging: { level: "error", stdout: false, file: false },
    cron: { alertConnector: "ops", alertChannel: "C-alerts" },
  } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "claude-1", result: "Briefing is ready.", cost: 0.01, numTurns: 1 });
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-1", result: "Briefing is ready (Codex).", cost: 0.01, numTurns: 1 });
  const manager = new SessionManager(config, new Map<string, Engine>([
    ["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }],
  ]));
  // Results are delivered through "slack"; failure alerts go out through "ops".
  const alert = vi.fn<Connector["sendMessage"]>(async () => "alert-ts");
  const deliver = vi.fn<Connector["replyMessage"]>(async () => "delivery-ts");
  const getCapabilities = () => ({ threading: true, messageEdits: false, reactions: true, attachments: false });
  const slack = { name: "slack", sendMessage: vi.fn(async () => "sent-ts"), replyMessage: deliver, getCapabilities } as unknown as Connector;
  const ops = { name: "ops", sendMessage: alert, replyMessage: vi.fn(async () => "reply-ts"), getCapabilities } as unknown as Connector;
  const connectors = new Map<string, Connector>([["slack", slack], ["ops", ops]]);
  apiContext = { config, getConfig: () => config, sessionManager: manager, startTime: 0, emit: () => {}, connectors } as unknown as ApiContext;
  const run = () => runCronJob(job, manager, config, connectors);
  return { job, config, manager, connectors, claudeRun, codexRun, alert, deliver, run };
}

function runs(jobId: string): RunEntry[] {
  const file = path.join(CRON_RUNS, `${jobId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEntry);
}

const failed = (error: string): EngineResult => ({ sessionId: "engine-1", result: "", error, cost: 0.01, numTurns: 1 });

beforeAll(async () => {
  server = http.createServer((req, res) => { void handleApiRequest(req, res, apiContext); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => { invalidateModelRegistry(); });
afterEach(() => { vi.useRealTimers(); });

describe("cron run log reflects how the session actually ended", () => {
  it("keeps a successful run green, silent and in its existing shape", async () => {
    const f = setup();
    await f.run();

    const [entry, ...rest] = runs(f.job.id);
    expect(rest).toEqual([]);
    expect(entry).toEqual({
      timestamp: expect.any(String), sessionKey: expect.stringMatching(new RegExp(`^cron:${f.job.id}:\\d+$`)),
      sessionId: expect.any(String), status: "success", durationMs: expect.any(Number), error: null, resultPreview: null,
    });
    expect(getSession(entry!.sessionId!)?.status).toBe("idle");
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: "C-briefing" }), "Briefing is ready.");
    expect(f.alert).not.toHaveBeenCalled();
  });

  it("records a failed engine turn as an error with the session's reason, and alerts", async () => {
    const f = setup();
    f.claudeRun.mockResolvedValue(failed("Not logged in · Please run /login"));
    await f.run();

    const [entry, ...rest] = runs(f.job.id);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ status: "error", error: "Not logged in · Please run /login", sessionId: expect.any(String) });
    expect(getSession(entry!.sessionId!)?.status).toBe("error");
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining("Not logged in · Please run /login"));
    expect(f.alert.mock.calls[0]![1]).toContain(`Cron job "${f.job.name}" failed`);
  });

  // A reply the chat connector refuses. Today that throws inside the turn and
  // the session ends in error. Once the gateway keeps the engine result instead,
  // the session stays idle and only lastError records it. Both are failed runs.
  describe("a result that never reached its delivery channel", () => {
    it("is recorded when the turn ends in error because of it", async () => {
      const f = setup();
      f.deliver.mockRejectedValue(new Error("channel_not_found"));
      await f.run();

      const [entry, ...rest] = runs(f.job.id);
      expect(rest).toEqual([]);
      expect(getSession(entry!.sessionId!)?.status).toBe("error");
      expect(entry).toMatchObject({ status: "error", error: "channel_not_found" });
      expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining("channel_not_found"));
    });

    it("is recorded when the session is left idle with the failure only in lastError", async () => {
      const f = setup();
      // What route() leaves behind once a failed delivery no longer fails the turn.
      const route = vi.fn(async (msg: IncomingMessage) => {
        const session = createSession({
          engine: "claude", source: "cron", sourceRef: msg.sessionKey, connector: "cron",
          sessionKey: msg.sessionKey, replyContext: msg.replyContext,
        });
        recordFailedOriginDelivery(session);
        return { sessionId: session.id };
      });
      await runCronJob(f.job, { route, getEngine: () => undefined } as never, f.config, f.connectors);

      const [entry, ...rest] = runs(f.job.id);
      expect(rest).toEqual([]);
      const settled = getSession(entry!.sessionId!)!;
      expect(settled.status).toBe("idle");
      expect(settled.lastError).toBeTruthy();
      expect(entry).toMatchObject({ status: "error", error: settled.lastError });
      expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining(settled.lastError!));
    });
  });

  // The cron connector only drops what it is given when the delivery connector
  // is not running: the turn succeeds, the session is idle, and nobody was told.
  it("records a run whose delivery connector is not running, though the turn itself succeeded", async () => {
    const f = setup();
    f.connectors.delete("slack");
    await f.run();

    const [entry, ...rest] = runs(f.job.id);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ status: "error", sessionId: expect.any(String) });
    expect(entry!.error).toContain('"slack"');
    expect(entry!.error).toContain("not delivered");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(getSession(entry!.sessionId!)?.status).toBe("idle");
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining('"slack"'));
  });

  // The session manager answers an unknown engine with a chat message and
  // returns without marking the session, so such a run was logged as a success.
  it("fails a job that names an engine the gateway does not have, before any session starts", async () => {
    const f = setup();
    f.job.engine = "gemini";
    await f.run();

    const [entry, ...rest] = runs(f.job.id);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ status: "error" });
    expect(entry!.error).toContain('"gemini"');
    expect(entry).not.toHaveProperty("sessionId");
    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(f.codexRun).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining('"gemini"'));
  });

  it("still runs a job that names an engine the gateway has", async () => {
    const f = setup();
    f.job.engine = "codex";
    await f.run();

    expect(f.codexRun).toHaveBeenCalledTimes(1);
    expect(runs(f.job.id)).toEqual([expect.objectContaining({ status: "success", error: null })]);
    expect(f.alert).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", undefined],
    ["the dashboard", { connector: "web", channel: "general" }],
    ["a channel with no connector", { connector: "", channel: "C-briefing" }],
  ])("keeps a run green when its output is meant for %s", async (_label, delivery) => {
    const f = setup();
    f.job.delivery = delivery;
    await f.run();

    expect(runs(f.job.id)).toEqual([expect.objectContaining({ status: "success", error: null })]);
    expect(f.alert).not.toHaveBeenCalled();
  });

  it("keeps a turn green when a fallback engine answered for the failed one", async () => {
    const f = setup({}, { claude: ["codex"] });
    f.claudeRun.mockResolvedValue({ sessionId: "claude-1", result: "", error: "Usage limit reached" });
    await f.run();

    expect(f.codexRun).toHaveBeenCalledTimes(1);
    const [entry] = runs(f.job.id);
    expect(entry).toMatchObject({ status: "success", error: null });
    expect(getSession(entry!.sessionId!)).toMatchObject({ engine: "codex", status: "idle" });
    expect(f.alert).not.toHaveBeenCalled();
  });

  it("reports the failure when every engine in the fallback chain failed", async () => {
    const f = setup({}, { claude: ["codex"] });
    f.claudeRun.mockResolvedValue({ sessionId: "claude-1", result: "", error: "Usage limit reached" });
    f.codexRun.mockResolvedValue({ sessionId: "codex-1", result: "", error: "Rate limited" });
    await f.run();

    expect(runs(f.job.id)).toEqual([expect.objectContaining({ status: "error", error: "Rate limited" })]);
    expect(f.alert).toHaveBeenCalledTimes(1);
  });

  it("stays pending while the session waits on a usage limit, then records that the limit never cleared", async () => {
    vi.useFakeTimers();
    const f = setup({ rateLimitStrategy: "wait" });
    f.claudeRun.mockImplementation(async () => ({
      sessionId: "claude-1", result: "", error: "Rate limited",
      rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 60 },
    }));
    let settled = false;
    const pending = f.run().then(() => { settled = true; });
    await vi.waitFor(() => expect(f.claudeRun).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // route() has not returned: nothing may be logged for a session that is still waiting.
    expect(settled).toBe(false);
    expect(runs(f.job.id)).toEqual([]);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await pending;
    expect(runs(f.job.id)).toEqual([expect.objectContaining({ status: "error", error: "claude usage limit did not clear in time" })]);
    expect(f.alert).toHaveBeenCalledTimes(1);
  });

  // While it waits the session carries the usage-limit note in lastError. A
  // turn that then finishes resets it, so that note must not fail the run.
  it("is a success when the turn resumes after a usage limit, though an error was noted while it waited", async () => {
    vi.useFakeTimers();
    const f = setup({ rateLimitStrategy: "wait" });
    f.claudeRun
      .mockImplementationOnce(async () => ({
        sessionId: "claude-1", result: "", error: "Rate limited",
        rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 60 },
      }))
      .mockResolvedValue({ sessionId: "claude-1", result: "Briefing is ready.", cost: 0.01, numTurns: 1 });
    const pending = f.run();
    await vi.waitFor(() => expect(f.claudeRun).toHaveBeenCalledTimes(1));
    const sessionId = f.claudeRun.mock.calls[0]![0].sessionId!;
    await vi.waitFor(() => expect(getSession(sessionId)).toMatchObject({ status: "waiting", lastError: expect.stringContaining("usage limit") }));

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await pending;
    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(getSession(sessionId)).toMatchObject({ status: "idle", lastError: null });
    expect(runs(f.job.id)).toEqual([expect.objectContaining({ status: "success", error: null })]);
    expect(f.alert).not.toHaveBeenCalled();
  });

  // The two places that note something in lastError without changing the
  // status are both background hooks, and both can land while the reply is
  // still being delivered. The turn's own final write follows and clears the
  // note. If that order ever changes, a clean run would be read as failed.
  it.each([
    ["a late Stop whose own delivery has nowhere to go", { hook_event_name: "Stop", last_assistant_message: "Background task finished." }],
    ["a StopFailure", { hook_event_name: "StopFailure", error: "overloaded" }],
  ])("is not failed by %s arriving while the reply is being delivered", async (_label, hook) => {
    const f = setup();
    let notedMeanwhile: string | null | undefined;
    f.deliver.mockImplementationOnce(async () => {
      const sessionId = f.claudeRun.mock.calls[0]![0].sessionId!;
      await f.manager.handleOrphanHook(sessionId, hook);
      notedMeanwhile = getSession(sessionId)?.lastError;
      return "delivery-ts";
    });
    await f.run();

    expect(notedMeanwhile).toBeTruthy();
    const [entry] = runs(f.job.id);
    expect(getSession(entry!.sessionId!)).toMatchObject({ status: "idle", lastError: null });
    expect(entry).toMatchObject({ status: "success", error: null });
    expect(f.alert).not.toHaveBeenCalled();
  });

  // A child-session callback or detached-job notification that arrives during
  // the cron turn is queued behind it and starts the moment the turn settles —
  // before the runner can read the row, whose status is then "running" again.
  describe("with a wake-up queued behind the cron turn", () => {
    async function runWithQueuedWakeUp(cronTurn: EngineResult) {
      const f = setup();
      let finishWakeUp!: (result: EngineResult) => void;
      const wakeUp = new Promise<EngineResult>((resolve) => { finishWakeUp = resolve; });
      f.claudeRun
        .mockImplementationOnce(async (opts) => {
          const response = await fetch(`${baseUrl}/api/sessions/${opts.sessionId}/message`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "Child session finished.", role: "notification" }),
          });
          expect(((await response.json()) as { status: string }).status).toBe("queued");
          return cronTurn;
        })
        .mockImplementationOnce(() => wakeUp);
      await f.run();
      const [entry] = runs(f.job.id);
      const statusAtReturn = getSession(entry!.sessionId!)?.status;
      finishWakeUp({ sessionId: "claude-1", result: "Noted.", cost: 0.01, numTurns: 1 });
      await vi.waitFor(() => expect(getSession(entry!.sessionId!)?.status).toBe("idle"), { timeout: 5_000 });
      return { ...f, entry, statusAtReturn };
    }

    it("still reports the failure the cron turn left behind", async () => {
      const f = await runWithQueuedWakeUp(failed("Engine crashed"));
      expect(f.statusAtReturn).toBe("running");
      expect(f.entry).toMatchObject({ status: "error", error: "Engine crashed" });
      expect(f.alert).toHaveBeenCalledTimes(1);
    });

    it("does not turn a clean run red", async () => {
      const f = await runWithQueuedWakeUp({ sessionId: "claude-1", result: "Briefing is ready.", cost: 0.01, numTurns: 1 });
      expect(f.statusAtReturn).toBe("running");
      expect(f.entry).toMatchObject({ status: "success", error: null });
      expect(f.alert).not.toHaveBeenCalled();
    });
  });
});

// A job that fails on every fire alerted on every fire: four alerts an hour for
// a 15-minute job, for as long as the outage lasts. The run log still records
// every failure; only the repeat of an alert already sent is held back.
describe("cron alerts for a job that keeps failing", () => {
  const start = Date.parse("2026-10-12T07:00:00.000Z");
  const loggedOut = failed("Not logged in · Please run /login");
  const ok: EngineResult = { sessionId: "claude-1", result: "Briefing is ready.", cost: 0.01, numTurns: 1 };

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });

  /** Fires the job at each minute offset with the engine result given for it. */
  async function fireAt(f: ReturnType<typeof setup>, schedule: Array<[number, EngineResult]>) {
    for (const [minutes, result] of schedule) {
      vi.setSystemTime(start + minutes * 60_000);
      f.claudeRun.mockResolvedValue(result);
      await f.run();
    }
  }

  it("sends one alert while the same failure repeats, and logs every run as an error", async () => {
    const f = setup();
    await fireAt(f, [[0, loggedOut], [15, loggedOut], [30, loggedOut], [45, loggedOut]]);

    expect(runs(f.job.id).map((entry) => [entry.status, entry.error])).toEqual(
      Array(4).fill(["error", "Not logged in · Please run /login"]),
    );
    expect(f.alert).toHaveBeenCalledTimes(1);
  });

  it("repeats the alert once an hour has passed since it was last sent", async () => {
    const f = setup();
    await fireAt(f, [[0, loggedOut], [15, loggedOut], [30, loggedOut], [45, loggedOut], [60, loggedOut], [75, loggedOut]]);

    expect(runs(f.job.id)).toHaveLength(6);
    expect(f.alert).toHaveBeenCalledTimes(2);
  });

  it("alerts at once when the reason changes", async () => {
    const f = setup();
    await fireAt(f, [[0, loggedOut], [15, loggedOut], [30, failed("Engine crashed")]]);

    expect(f.alert).toHaveBeenCalledTimes(2);
    expect(f.alert.mock.calls[1]![1]).toContain("Engine crashed");
  });

  it("alerts at once for a failure that comes after a success", async () => {
    const f = setup();
    await fireAt(f, [[0, loggedOut], [15, ok], [30, loggedOut]]);

    expect(runs(f.job.id).map((entry) => entry.status)).toEqual(["error", "success", "error"]);
    expect(f.alert).toHaveBeenCalledTimes(2);
  });

  it("alerts on every failure when cron.alertThrottleMinutes is 0", async () => {
    const f = setup();
    f.config.cron = { ...f.config.cron, alertThrottleMinutes: 0 };
    await fireAt(f, [[0, loggedOut], [15, loggedOut], [30, loggedOut]]);

    expect(f.alert).toHaveBeenCalledTimes(3);
  });

  it("honours a shorter window from the config", async () => {
    const f = setup();
    f.config.cron = { ...f.config.cron, alertThrottleMinutes: 20 };
    await fireAt(f, [[0, loggedOut], [15, loggedOut], [30, loggedOut]]);

    expect(f.alert).toHaveBeenCalledTimes(2);
  });

  it("tries again on the next failure when the alert could not be sent", async () => {
    const f = setup();
    f.alert.mockRejectedValueOnce(new Error("slack is down"));
    await fireAt(f, [[0, loggedOut], [15, loggedOut], [30, loggedOut]]);

    expect(f.alert).toHaveBeenCalledTimes(2);
  });
});
