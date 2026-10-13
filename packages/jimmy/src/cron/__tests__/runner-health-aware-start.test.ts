import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, Employee, Engine, EngineResult, JinnConfig, Session } from "../../shared/types.js";

// Two changes meet in a cron fire. The runner hands route() only the engine and
// model the job itself names, never a default spelled out; and a new session
// that names neither starts on the fallback engine when the engine it would
// have used is known to be out of allowance. Each is tested on its own. These
// drive runCronJob end to end — the real session manager, fake engines, the run
// log read off disk — to show that a fire really does start where it should.
const { registry } = vi.hoisted(() => ({ registry: new Map<string, unknown>() }));

vi.mock("../../gateway/org.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/org.js")>()),
  scanOrg: () => registry,
}));
vi.mock("../../sessions/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/context.js")>()),
  buildContext: () => "context",
}));
vi.mock("../../sessions/callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/callbacks.js")>()),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));

import { notifyDiscordChannel } from "../../sessions/callbacks.js";
import { _resetUsageLimitAnnouncements, setEngineInstallProbe } from "../../sessions/engine-health-gate.js";
import { _resetEngineLoginKnowledge, noteLoginWorked } from "../../sessions/engine-login.js";
import { SessionManager } from "../../sessions/manager.js";
import { createSession, getSession, updateSession } from "../../sessions/registry.js";
import { readEngineHealth, recordEngineUnavailable } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { CRON_RUNS, JINN_HOME } from "../../shared/paths.js";
import { runCronJob } from "../runner.js";

type RunEntry = { status: string; error: string | null; sessionId: string; durationMs: number; reason?: string; resetsAt?: string; waitingSessionId?: string };

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-10-12T07:00:00.000Z");
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

const answered = (engine: string): EngineResult => ({ sessionId: `${engine}-thread`, result: `Briefing by ${engine}.`, cost: 0.01, numTurns: 1 });
/** What the interactive Claude engine reports once its allowance is spent: a declared limit, its reset and its window. */
const spentUntil = (resetsAtMs: number, window: string): EngineResult => ({
  sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor(resetsAtMs / 1000), window },
});

interface Options {
  /** The instance's default engine. */
  default?: "claude" | "codex";
  /** Claude's fallback chain; left out, the gateway's own default (Codex) applies. */
  claudeFallback?: string[];
  job?: Partial<CronJob>;
  employee?: Employee;
}

let sequence = 0;
function setup(options: Options = {}) {
  const job: CronJob = {
    id: `health-aware-${++sequence}`, name: "Morning briefing", enabled: true, schedule: "*/15 * * * *",
    prompt: "Write the morning briefing", delivery: { connector: "slack", channel: "C-briefing" },
    ...(options.employee ? { employee: options.employee.name } : {}), ...options.job,
  };
  registry.clear();
  if (options.employee) registry.set(options.employee.name, options.employee);
  const config = {
    engines: {
      default: options.default ?? "claude",
      claude: { bin: "claude-bin", model: "claude-model", interactive: true, ...(options.claudeFallback ? { fallback: options.claudeFallback } : {}) },
      codex: { bin: "codex-bin", model: "codex-model" },
    },
    sessions: { transientRetryDelaysMs: [] },
    connectors: {},
    logging: { level: "error", stdout: false, file: false },
    cron: { alertConnector: "ops", alertChannel: "C-alerts" },
  } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>(async () => answered("claude"));
  const codexRun = vi.fn<Engine["run"]>(async () => answered("codex"));
  const manager = new SessionManager(config, new Map<string, Engine>([
    ["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }],
  ]));
  // Results and notices are delivered through "slack"; failure alerts go out through "ops".
  const posted: string[] = [];
  const postedTo: Array<{ channel: string; text: string }> = [];
  const post = vi.fn(async (target: { channel: string }, text: string) => {
    posted.push(text);
    postedTo.push({ channel: target.channel, text });
    return "ts";
  });
  const alert = vi.fn<Connector["sendMessage"]>(async () => "alert-ts");
  const getCapabilities = () => ({ threading: true, messageEdits: false, reactions: true, attachments: false });
  const connectors = new Map<string, Connector>([
    ["slack", { name: "slack", sendMessage: post, replyMessage: post, getCapabilities } as unknown as Connector],
    ["ops", { name: "ops", sendMessage: alert, replyMessage: vi.fn(async () => "reply-ts"), getCapabilities } as unknown as Connector],
  ]);
  const fire = () => runCronJob(job, manager, config, connectors);
  return {
    job, config, claudeRun, codexRun, alert, posted, post, connectors, fire,
    /** What one delivery channel received. */
    postedIn: (channel: string) => postedTo.filter((message) => message.channel === channel).map((message) => message.text),
    /** Fire another job on the same gateway. */
    fireJob: (other: CronJob) => runCronJob(other, manager, config, connectors),
    /** Fire the job this many minutes after START. */
    fireAt: async (minutes: number) => { vi.setSystemTime(START + minutes * MINUTE); await fire(); },
    /** Claude's allowance is spent until then, and it answers again afterwards. */
    claudeSpentUntil: (resetsAtMs: number, window = "5h") => {
      claudeRun.mockImplementation(async () => (Date.now() < resetsAtMs ? spentUntil(resetsAtMs, window) : answered("claude")));
    },
    /** What the delivery channel was told about the limit, as opposed to the job's output. */
    limitNotices: () => posted.filter((text) => text.startsWith("⚠️")),
    results: () => posted.filter((text) => text.startsWith("Briefing by")),
  };
}

function runs(jobId: string): RunEntry[] {
  const file = path.join(CRON_RUNS, `${jobId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEntry);
}
const outcomes = (jobId: string) => runs(jobId).map((entry) => entry.status);
const sessionOf = (jobId: string, fireIndex: number): Session => getSession(runs(jobId)[fireIndex]!.sessionId)!;
const override = (session: Session) => (session.transportMeta as { engineOverride?: Record<string, unknown> } | null)?.engineOverride;
/** A limit that is already on record when the fire happens: found by a conversation, say. */
const onRecord = (engine: string, resetsAtMs: number, window?: string) =>
  recordEngineUnavailable(engine, `${engine} usage limit`, Math.floor(resetsAtMs / 1000), new Date(), window);

const staff = (fields: Partial<Employee>): Employee => ({
  name: "analyst", displayName: "Analyst", department: "ops", rank: "employee", engine: "claude", persona: "Analyses things.", ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: START, toFake: ["Date"] });
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => {
  setEngineInstallProbe(undefined);
  vi.useRealTimers();
});

describe("cron fires while the default engine is out of allowance", () => {
  it("start on the fallback engine after the fire that found the limit: no failed turn, a green run, one notice", async () => {
    const f = setup();
    f.claudeSpentUntil(START + 2 * HOUR);

    await f.fireAt(0); // finds the limit the hard way, and is switched within its turn
    await f.fireAt(15);
    await f.fireAt(30);

    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).toHaveBeenCalledTimes(3);
    expect(runs(f.job.id).map((entry) => [entry.status, entry.error])).toEqual(Array(3).fill(["success", null]));
    expect(f.results()).toEqual(Array(3).fill("Briefing by codex."));
    expect(f.limitNotices()).toEqual(["⚠️ claude usage limit reached. Switching to codex."]);
    expect(f.alert).not.toHaveBeenCalled();
    // A later fire's session never ran on Claude: it was started on Codex, on the strength of the record.
    const started = sessionOf(f.job.id, 1);
    expect(started).toMatchObject({ engine: "codex", status: "idle", lastError: null });
    expect(override(started)).toMatchObject({ originalEngine: "claude", source: "engine-health" });
    expect(f.codexRun.mock.calls[1]![0]).toMatchObject({ model: "codex-model", bin: "codex-bin" });
  });

  it("start there from the first fire when the limit is already on record, and say so once", async () => {
    const f = setup();
    f.claudeSpentUntil(START + 2 * HOUR);
    onRecord("claude", START + 2 * HOUR, "5h");
    noteLoginWorked("codex"); // Codex has answered a turn in this process

    await f.fireAt(0);
    await f.fireAt(15);

    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(outcomes(f.job.id)).toEqual(["success", "success"]);
    expect(f.limitNotices()).toEqual([expect.stringMatching(/^⚠️ claude usage limit reached \(resets .+\)\. Starting on codex\.$/)]);
  });

  // The record survives a restart; what the gateway knows about the fallback
  // engine signing in does not. A session is only ever started on an engine
  // that has answered a turn in this process, so the first fire after a
  // restart still goes to Claude, fails, and proves Codex by switching to it.
  it("still fail one turn on the spent engine with the first fire after a restart", async () => {
    const f = setup();
    f.claudeSpentUntil(START + 2 * HOUR);
    onRecord("claude", START + 2 * HOUR, "5h");

    await f.fireAt(0);
    await f.fireAt(15);

    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(outcomes(f.job.id)).toEqual(["success", "success"]);
    expect(f.limitNotices()).toEqual(["⚠️ claude usage limit reached. Switching to codex."]);
  });

  // `claude -p` reports the limit and its reset without saying which window ran out.
  it("start on the fallback engine all the same when the limit named no window", async () => {
    const f = setup();
    const reset = START + 2 * HOUR;
    f.claudeRun.mockImplementation(async () => (Date.now() < reset
      ? { sessionId: "claude-headless", result: "", error: "Claude usage limit reached: You've hit your limit", cost: 0, numTurns: 1,
          rateLimit: { status: "rejected", resetsAt: Math.floor(reset / 1000), rateLimitType: "five_hour" } }
      : answered("claude")));

    await f.fireAt(0);
    await f.fireAt(15);
    await f.fireAt(121);

    expect(f.claudeRun).toHaveBeenCalledTimes(2); // the fire that found the limit, and the one after the reset
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(outcomes(f.job.id)).toEqual(["success", "success", "success"]);
    expect(f.results()).toEqual(["Briefing by codex.", "Briefing by codex.", "Briefing by claude."]);
  });

  it("go back to the default engine with the first fire after the reset", async () => {
    const f = setup();
    f.claudeSpentUntil(START + 2 * HOUR);

    await f.fireAt(0);
    await f.fireAt(60);
    await f.fireAt(121);

    expect(f.claudeRun).toHaveBeenCalledTimes(2); // the fire that found the limit, and the one after the reset
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(outcomes(f.job.id)).toEqual(["success", "success", "success"]);
    expect(f.results()).toEqual(["Briefing by codex.", "Briefing by codex.", "Briefing by claude."]);
    const back = sessionOf(f.job.id, 2);
    expect(back).toMatchObject({ engine: "claude", status: "idle", lastError: null });
    expect(override(back)).toBeUndefined();
    expect(readEngineHealth().claude?.state ?? "ok").toBe("ok");
    expect(f.limitNotices()).toHaveLength(1);
  });

  // A weekly window can name a reset days out. It is believed for twelve hours
  // at a time: after that a fire is let through to try the engine for real.
  it("let one fire try the engine for real every twelve hours of an outage that lasts days", async () => {
    const f = setup();
    f.claudeSpentUntil(START + 3 * 24 * HOUR, "7d");

    await f.fireAt(0);
    await f.fireAt(11 * 60);
    await f.fireAt(12 * 60 + 1); // past the re-probe point: tries Claude, fails, is switched
    await f.fireAt(12 * 60 + 16);

    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(f.codexRun).toHaveBeenCalledTimes(4);
    expect(outcomes(f.job.id)).toEqual(Array(4).fill("success"));
    expect(f.limitNotices()).toHaveLength(1); // the same limit period: not announced again
  });
});

describe("a cron job that names where it runs", () => {
  // Naming the engine or the model is an instruction, not a preference: the
  // session is not started anywhere else. It fails its turn on the spent engine
  // and is switched within that turn, on every fire.
  it.each([
    ["the engine", { engine: "claude" }, "claude-model"],
    ["a model", { model: "claude-pinned" }, "claude-pinned"],
  ])("is not started elsewhere when it names %s: every fire fails a turn first, then switches", async (_label, named, model) => {
    const f = setup({ job: named });
    f.claudeSpentUntil(START + 2 * HOUR);
    onRecord("claude", START + 2 * HOUR, "5h");
    noteLoginWorked("codex");

    await f.fireAt(0);
    await f.fireAt(15);

    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(f.claudeRun.mock.calls[0]![0]).toMatchObject({ model, bin: "claude-bin" });
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(outcomes(f.job.id)).toEqual(["success", "success"]);
    expect(f.results()).toEqual(["Briefing by codex.", "Briefing by codex."]);
    // A cron fire carries only the first notice of a limit period.
    expect(f.limitNotices()).toEqual(["⚠️ claude usage limit reached. Switching to codex."]);
    expect(f.alert).not.toHaveBeenCalled();
  });
});

describe("a cron job for an employee, while an engine is out of allowance", () => {
  it("runs on the employee's own engine and model when it is the default engine that is out", async () => {
    const f = setup({ employee: staff({ engine: "codex" }) });
    onRecord("claude", START + 2 * HOUR, "5h");
    noteLoginWorked("codex");

    await f.fireAt(0);

    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(f.codexRun.mock.calls[0]![0]).toMatchObject({ model: "codex-model", bin: "codex-bin" });
    const session = sessionOf(f.job.id, 0);
    expect(session).toMatchObject({ engine: "codex", employee: "analyst", status: "idle" });
    expect(override(session)).toBeUndefined(); // it was never moved: this is where the employee works
    expect(f.limitNotices()).toEqual([]);
    expect(outcomes(f.job.id)).toEqual(["success"]);
  });

  // The employee is on Claude; the instance's default is Codex. The fire is
  // moved off Claude with Codex's model — neither the default engine's model
  // handed to Claude, nor Claude's handed to Codex — and goes back after the reset.
  it("is started on the fallback with the fallback's model when the employee's engine, not the default, is out", async () => {
    const f = setup({ default: "codex", employee: staff({ engine: "claude" }) });
    f.claudeSpentUntil(START + 2 * HOUR);
    onRecord("claude", START + 2 * HOUR, "5h");
    noteLoginWorked("codex");

    await f.fireAt(0);
    await f.fireAt(121);

    expect(f.codexRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun.mock.calls[0]![0]).toMatchObject({ model: "codex-model", bin: "codex-bin" });
    const moved = sessionOf(f.job.id, 0);
    expect(moved).toMatchObject({ engine: "codex", employee: "analyst" });
    expect(override(moved)).toMatchObject({ originalEngine: "claude", originalModel: null, source: "engine-health" });
    expect(f.limitNotices()).toEqual([expect.stringMatching(/claude usage limit reached \(resets .+\)\. Starting on codex\.$/)]);
    // After the reset the employee is back on its own engine, with that engine's model.
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.claudeRun.mock.calls[0]![0]).toMatchObject({ model: "claude-model", bin: "claude-bin" });
    expect(sessionOf(f.job.id, 1)).toMatchObject({ engine: "claude", employee: "analyst" });
    expect(outcomes(f.job.id)).toEqual(["success", "success"]);
  });

  it("is started on the fallback without the employee's own model, and gets that model back after the reset", async () => {
    const f = setup({ employee: staff({ engine: "claude", model: "claude-staff" }) });
    f.claudeSpentUntil(START + 2 * HOUR);
    onRecord("claude", START + 2 * HOUR, "5h");
    noteLoginWorked("codex");

    await f.fireAt(0);
    await f.fireAt(121);

    expect(f.codexRun.mock.calls[0]![0]).toMatchObject({ model: "codex-model" });
    expect(override(sessionOf(f.job.id, 0))).toMatchObject({ originalEngine: "claude", originalModel: "claude-staff" });
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.claudeRun.mock.calls[0]![0]).toMatchObject({ model: "claude-staff" });
    expect(outcomes(f.job.id)).toEqual(["success", "success"]);
  });
});

describe("cron fires while the only usable engine is out of allowance", () => {
  const noFallback: Array<[string, Options, () => void]> = [
    ["has no fallback engine", { claudeFallback: [] }, () => {}],
    ["has a fallback engine that is not installed", {}, () => setEngineInstallProbe((bin) => bin !== "codex-bin")],
    ["has no fallback engine and the job names its engine", { claudeFallback: [], job: { engine: "claude" } }, () => {}],
  ];

  it.each(noFallback)("fail at once, each logged as an error that says when the limit resets, when the instance %s and the reset is days away", async (_label, options, arrange) => {
    const f = setup(options);
    arrange();
    const reset = START + 5 * 24 * HOUR;
    f.claudeSpentUntil(reset, "7d");

    await f.fireAt(0);
    await f.fireAt(15);
    await f.fireAt(30);

    expect(f.claudeRun).toHaveBeenCalledTimes(3); // each fire spends a turn finding the same limit
    expect(f.codexRun).not.toHaveBeenCalled();
    const entries = runs(f.job.id);
    expect(entries.map((entry) => entry.status)).toEqual(["error", "error", "error"]);
    for (const entry of entries) {
      expect(entry.error).toContain("claude usage limit reached");
      expect(entry.error).toContain(iso(reset));
      expect(entry.durationMs).toBeLessThan(MINUTE); // not waited for
      expect(getSession(entry.sessionId)).toMatchObject({ engine: "claude", status: "error" });
    }
    // The alert goes out once for the limit period, and so does the word to the delivery channel.
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining(iso(reset)));
    expect(f.posted).toEqual([entries[0]!.error]);

    // An hour on, and a day on, it is still the same limit: neither is repeated.
    await f.fireAt(75);
    await f.fireAt(24 * 60 + 15);
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.posted).toHaveLength(1);
    expect(outcomes(f.job.id)).toEqual(Array(5).fill("error"));
    // A fire that posted nothing is still an error for the limit, not for a delivery that failed.
    const last = runs(f.job.id).at(-1)!;
    expect(last).toMatchObject({ status: "error", error: entries[0]!.error });
    expect(getSession(last.sessionId)).toMatchObject({ status: "error", lastError: entries[0]!.error });
  });

  it("tell the delivery channel again when a new limit period begins", async () => {
    const f = setup({ claudeFallback: [] });
    const firstReset = START + 5 * 24 * HOUR;
    const secondReset = firstReset + 7 * 24 * HOUR;
    f.claudeRun.mockImplementation(async () => spentUntil(Date.now() < firstReset ? firstReset : secondReset, "7d"));

    await f.fireAt(0);
    await f.fireAt(15);
    await f.fireAt(5 * 24 * 60 + 1); // the window reopened and was spent again
    await f.fireAt(5 * 24 * 60 + 16);

    expect(f.posted).toEqual([expect.stringContaining(iso(firstReset)), expect.stringContaining(iso(secondReset))]);
    expect(f.alert.mock.calls.map(([, text]) => text)).toEqual([expect.stringContaining(iso(firstReset)), expect.stringContaining(iso(secondReset))]);
    expect(outcomes(f.job.id)).toEqual(["error", "error", "error", "error"]);
  });

  // An alert is about a job. Two jobs that fail on the same limit each say so, once.
  it("alert once per limit period for each job that fails on it", async () => {
    const f = setup({ claudeFallback: [] });
    f.claudeSpentUntil(START + 5 * 24 * HOUR, "7d");
    const other: CronJob = { ...f.job, id: `${f.job.id}-other`, name: "Evening digest" };

    for (const minutes of [0, 15, 75, 24 * 60]) {
      vi.setSystemTime(START + minutes * MINUTE);
      await f.fire();
      await f.fireJob(other);
    }

    expect(f.alert.mock.calls.map(([, text]) => text)).toEqual([
      expect.stringContaining(`Cron job "${f.job.name}" failed`), expect.stringContaining(`Cron job "${other.name}" failed`),
    ]);
  });

  it("keep the hourly alert for a failure of any other kind, and do not repeat the limit's alert after one", async () => {
    const f = setup({ claudeFallback: [] });
    const spent = () => spentUntil(START + 5 * 24 * HOUR, "7d");
    const loggedOut = (): EngineResult => ({ sessionId: "claude-thread", result: "", error: "Not logged in · Please run /login", cost: 0.01, numTurns: 1 });
    // What each fire meets, by the minute it fires at.
    const schedule: Array<[number, () => EngineResult]> = [[0, spent], [15, loggedOut], [30, spent], [45, loggedOut], [80, loggedOut], [95, spent]];

    for (const [minutes, result] of schedule) {
      f.claudeRun.mockImplementation(async () => result());
      await f.fireAt(minutes);
    }

    // The limit at 0, the login at 15 and again at 80 — an hour after it was last alerted.
    expect(f.alert.mock.calls.map(([, text]) => text)).toEqual([
      expect.stringContaining("usage limit reached"), expect.stringContaining("Not logged in"), expect.stringContaining("Not logged in"),
    ]);
    expect(outcomes(f.job.id)).toEqual(Array(6).fill("error"));
  });

  it("alert again for the same limit period after a fire that succeeded in between", async () => {
    const f = setup({ claudeFallback: [] });
    const reset = START + 5 * 24 * HOUR;
    f.claudeRun.mockImplementation(async () => spentUntil(reset, "7d"));
    await f.fireAt(0);
    f.claudeRun.mockImplementation(async () => answered("claude"));
    await f.fireAt(15);
    f.claudeRun.mockImplementation(async () => spentUntil(reset, "7d"));
    await f.fireAt(30);

    expect(outcomes(f.job.id)).toEqual(["error", "success", "error"]);
    expect(f.alert).toHaveBeenCalledTimes(2);
  });

  it("alert on every fire when cron.alertThrottleMinutes is 0", async () => {
    const f = setup({ claudeFallback: [] });
    f.config.cron = { ...f.config.cron, alertThrottleMinutes: 0 };
    f.claudeSpentUntil(START + 5 * 24 * HOUR, "7d");

    await f.fireAt(0);
    await f.fireAt(15);
    await f.fireAt(30);

    expect(f.alert).toHaveBeenCalledTimes(3);
  });

  // Once per limit period is counted per delivery channel: every channel that
  // is waiting for a job's output learns why none is coming, and learns it once.
  it("tell each delivery channel once, however many jobs deliver to it", async () => {
    const f = setup({ claudeFallback: [] });
    f.claudeSpentUntil(START + 5 * 24 * HOUR, "7d");
    const sameChannel: CronJob = { ...f.job, id: `${f.job.id}-same-channel`, name: "Evening digest" };
    const otherChannel: CronJob = { ...f.job, id: `${f.job.id}-other-channel`, name: "Sales report", delivery: { connector: "slack", channel: "C-sales" } };

    for (const minutes of [0, 15]) {
      vi.setSystemTime(START + minutes * MINUTE);
      await f.fire();
      await f.fireJob(sameChannel);
      await f.fireJob(otherChannel);
    }

    expect(f.postedIn("C-briefing")).toHaveLength(1);
    expect(f.postedIn("C-sales")).toHaveLength(1);
    for (const job of [f.job, sameChannel, otherChannel]) expect(outcomes(job.id)).toEqual(["error", "error"]);
  });

  // A fire whose post was held back sent nothing, so nothing of it can have
  // failed to arrive: it is not turned into a delivery failure by the checks
  // that look for output that reached nobody.
  it("stay errors for the limit, not for a delivery, when the channel's connector is gone while a repeat is held back", async () => {
    const f = setup({ claudeFallback: [] });
    f.claudeSpentUntil(START + 5 * 24 * HOUR, "7d");

    await f.fireAt(0);
    f.connectors.delete("slack");
    await f.fireAt(15);

    const [first, second] = runs(f.job.id);
    expect(second).toMatchObject({ status: "error", error: first!.error });
    expect(second!.error).not.toMatch(/deliver/i);
    expect(getSession(second!.sessionId)).toMatchObject({ status: "error", lastError: first!.error });
    expect(f.posted).toHaveLength(1);
  });

  // "Told" means the post went out. One the channel refused is tried again by the next fire.
  it("try again with the next fire when the channel refused the message", async () => {
    const f = setup({ claudeFallback: [] });
    f.claudeSpentUntil(START + 5 * 24 * HOUR, "7d");
    f.post.mockRejectedValueOnce(new Error("channel_not_found"));

    await f.fireAt(0);
    await f.fireAt(15);
    await f.fireAt(30);

    expect(f.posted).toEqual([expect.stringContaining("claude usage limit reached")]);
    expect(outcomes(f.job.id)).toEqual(["error", "error", "error"]);
  });
});

describe("cron fires while an earlier fire of the same job waits for a usage limit to reset", () => {
  // The scheduler does not wait for a fire to finish before the next one, and
  // every fire is a session of its own. Each fire that arrived while one was
  // waiting used to spend a turn finding the same limit and then wait beside
  // it — and all of them ran the job at the same moment when the limit reset.
  //
  // (Six minutes stand in for any reset within the six hours a turn waits, and
  // a fire every two minutes for any schedule: each simulated half-second of
  // waiting is a timer, and a registry read, that the test has to run.)
  const RESET = START + 6 * MINUTE;
  const WAITING_NOTICE = /^⏳ claude usage limit reached\. Resets .+ — I'll continue automatically\.$/;
  const statusOfFire = (f: ReturnType<typeof setup>, index: number) => getSession(f.claudeRun.mock.calls[index]![0].sessionId!)?.status;

  /** Fire the job and return once that fire is parked, waiting for the reset. `settled` resolves when it has run. */
  async function fireAndPark(f: ReturnType<typeof setup>): Promise<{ settled: Promise<void> }> {
    const index = f.claudeRun.mock.calls.length;
    const settled = f.fire();
    await vi.waitFor(() => expect(statusOfFire(f, index)).toBe("waiting"));
    return { settled };
  }

  it("are not started: each is logged as skipped, and the job runs once when the limit resets", { timeout: 20_000 }, async () => {
    vi.useFakeTimers({ now: START });
    const f = setup({ claudeFallback: [] });
    f.claudeSpentUntil(RESET);
    const waiting = await fireAndPark(f);
    const waitingSessionId = f.claudeRun.mock.calls[0]![0].sessionId!;

    const firedAt: string[] = [];
    for (const skippedSoFar of [1, 2]) {
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      firedAt.push(new Date().toISOString());
      const fire = f.fire();
      await vi.waitFor(() => expect(outcomes(f.job.id)).toEqual(Array(skippedSoFar).fill("skipped"))); // logged at once …
      await fire; // … and over with: it does not wait as well
    }

    expect(f.claudeRun).toHaveBeenCalledTimes(1); // no turn spent finding the same limit again
    // A skipped run's line, in the shape the other skips have, with what it was skipped for.
    expect(runs(f.job.id)).toEqual(firedAt.map((timestamp) => ({
      timestamp, status: "skipped", durationMs: expect.any(Number),
      reason: "previous-run-waiting-for-usage-limit", waitingSessionId, resetsAt: iso(RESET),
    })));
    // The channel and the operator were told once, by the fire that is waiting.
    expect(f.posted).toEqual([expect.stringMatching(WAITING_NOTICE)]);
    expect(notifyDiscordChannel).toHaveBeenCalledTimes(1);
    expect(f.alert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RESET + MINUTE - Date.now());
    await waiting.settled;

    expect(f.claudeRun).toHaveBeenCalledTimes(2); // the turn that found the limit, and the same fire again at the reset
    expect(f.results()).toEqual(["Briefing by claude."]);
    expect(outcomes(f.job.id)).toEqual(["skipped", "skipped", "success"]);

    // With nothing waiting any more, the next fire runs as usual.
    await f.fire();
    expect(f.claudeRun).toHaveBeenCalledTimes(3);
    expect(outcomes(f.job.id)).toEqual(["skipped", "skipped", "success", "success"]);
  });

  // A long job overlapping its next fire is a different matter, and is left as it was.
  it("still start while the earlier fire is simply running", async () => {
    const f = setup();
    let finish!: (result: EngineResult) => void;
    f.claudeRun.mockImplementationOnce(() => new Promise<EngineResult>((resolve) => { finish = resolve; }));
    const first = f.fire();
    await vi.waitFor(() => expect(f.claudeRun).toHaveBeenCalledTimes(1));

    await f.fire();

    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    finish(answered("claude"));
    await first;
    expect(outcomes(f.job.id)).toEqual(["success", "success"]);
  });

  it("start again once the fire that was waiting has given up", { timeout: 20_000 }, async () => {
    vi.useFakeTimers({ now: START });
    const f = setup({ claudeFallback: [] });
    const weekly = START + 5 * 24 * HOUR;
    // Out until the reset; and at the reset, told that the weekly window is spent as well.
    f.claudeRun.mockImplementation(async () => (Date.now() < RESET ? spentUntil(RESET, "5h") : spentUntil(weekly, "7d")));
    const waiting = await fireAndPark(f);

    await vi.advanceTimersByTimeAsync(RESET + MINUTE - Date.now());
    await waiting.settled; // gave the wait up: the next reset is days away
    await f.fire();

    expect(f.claudeRun).toHaveBeenCalledTimes(3);
    const entries = runs(f.job.id);
    expect(entries.map((entry) => entry.status)).toEqual(["error", "error"]);
    for (const entry of entries) expect(entry.error).toContain(iso(weekly));
    // The channel heard that the job was waiting, then why it stopped — and not a second time from the fire after it.
    expect(f.posted).toEqual([expect.stringMatching(WAITING_NOTICE), entries[0]!.error]);
    // The same goes for the alert: one, for the limit the wait was given up on.
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining(iso(weekly)));
  });

  // A session that was waiting when the gateway went down is still marked so,
  // but nothing in the new process will resume it. It must not hold fires back.
  it("are not held back by a session left waiting by a gateway that has since restarted", async () => {
    const f = setup({ claudeFallback: [] });
    const leftover = createSession({ engine: "claude", source: "cron", sourceRef: `cron:${f.job.id}:${START - HOUR}`,
      connector: "cron", sessionKey: `cron:${f.job.id}:${START - HOUR}`, prompt: "Write the morning briefing" });
    updateSession(leftover.id, { status: "waiting", lastError: `claude usage limit — resumes ${iso(START + HOUR)}` });

    await f.fireAt(0);

    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(outcomes(f.job.id)).toEqual(["success"]);
  });

  it("do not hold back another job", { timeout: 20_000 }, async () => {
    vi.useFakeTimers({ now: START });
    const f = setup({ claudeFallback: [] });
    f.claudeSpentUntil(RESET);
    const waiting = await fireAndPark(f);
    const other: CronJob = { ...f.job, id: `${f.job.id}-other`, name: "Evening digest" };

    const otherFire = f.fireJob(other);
    await vi.waitFor(() => expect(statusOfFire(f, 1)).toBe("waiting")); // it ran its own turn, and waits on its own

    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(runs(other.id)).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESET + MINUTE - Date.now());
    await Promise.all([waiting.settled, otherFire]);
    expect(outcomes(f.job.id)).toEqual(["success"]);
    expect(outcomes(other.id)).toEqual(["success"]);
  });
});
