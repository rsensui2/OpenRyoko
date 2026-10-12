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
import { getSession } from "../../sessions/registry.js";
import { readEngineHealth, recordEngineUnavailable } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { CRON_RUNS, JINN_HOME } from "../../shared/paths.js";
import { runCronJob } from "../runner.js";

type RunEntry = { status: string; error: string | null; sessionId: string; durationMs: number };

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
  const post = async (_target: unknown, text: string) => { posted.push(text); return "ts"; };
  const alert = vi.fn<Connector["sendMessage"]>(async () => "alert-ts");
  const getCapabilities = () => ({ threading: true, messageEdits: false, reactions: true, attachments: false });
  const connectors = new Map<string, Connector>([
    ["slack", { name: "slack", sendMessage: post, replyMessage: post, getCapabilities } as unknown as Connector],
    ["ops", { name: "ops", sendMessage: alert, replyMessage: vi.fn(async () => "reply-ts"), getCapabilities } as unknown as Connector],
  ]);
  const fire = () => runCronJob(job, manager, config, connectors);
  return {
    job, claudeRun, codexRun, alert, posted, fire,
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
    // The same job failing for the same reason alerts once an hour …
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ channel: "C-alerts" }, expect.stringContaining(iso(reset)));
    // … but its delivery channel is told on every fire.
    expect(f.posted).toEqual(entries.map((entry) => entry.error));

    await f.fireAt(75);
    expect(f.alert).toHaveBeenCalledTimes(2);
  });
});

describe("cron fires that wait for a reset near enough to wait for", () => {
  // The scheduler does not wait for a fire to finish before the next one, and
  // every fire is a session of its own. While one waits for the reset, the next
  // fires of the same job spend a turn finding the same limit and wait beside it.
  // (Six minutes stand in for any reset within the six hours a turn waits, and
  // a fire every two minutes for any schedule: each simulated half-second of
  // waiting is a timer, and a registry read, that this test has to run.)
  it("wait side by side when the same job fires again, and all run at once when the limit resets", { timeout: 20_000 }, async () => {
    vi.useFakeTimers({ now: START });
    const f = setup({ claudeFallback: [] });
    const reset = START + 6 * MINUTE;
    // Out until the reset; after it, a turn that takes half a minute.
    let inFlight = 0;
    let mostAtOnce = 0;
    f.claudeRun.mockImplementation(async () => {
      if (Date.now() < reset) return spentUntil(reset, "5h");
      mostAtOnce = Math.max(mostAtOnce, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      inFlight--;
      return answered("claude");
    });
    const waitingSessions = () => f.claudeRun.mock.calls.map(([opts]) => getSession(opts.sessionId!)?.status).filter((status) => status === "waiting");

    const pending: Array<Promise<void>> = [];
    for (const minutes of [0, 2, 4]) {
      await vi.advanceTimersByTimeAsync(Math.max(0, START + minutes * MINUTE - Date.now()));
      pending.push(f.fire());
      await vi.waitFor(() => expect(waitingSessions()).toHaveLength(pending.length));
    }

    expect(f.claudeRun).toHaveBeenCalledTimes(3);
    expect(runs(f.job.id)).toEqual([]); // nothing is logged for a fire that is still waiting
    expect(f.alert).not.toHaveBeenCalled();
    // Each of them told the delivery channel, and the operator, that it is waiting.
    expect(f.posted).toEqual(Array(3).fill(expect.stringMatching(/^⏳ claude usage limit reached\. Resets .+ — I'll continue automatically\.$/)));
    expect(vi.mocked(notifyDiscordChannel).mock.calls.map(([text]) => text)).toEqual(Array(3).fill(expect.stringContaining("paused until")));

    await vi.advanceTimersByTimeAsync(reset + 2 * MINUTE - Date.now());
    await Promise.all(pending);

    expect(f.claudeRun).toHaveBeenCalledTimes(6); // the three turns that found the limit, then all three again at the reset
    expect(mostAtOnce).toBe(3); // the same job, three times over, at the same moment
    expect(f.results()).toEqual(Array(3).fill("Briefing by claude."));
    const entries = runs(f.job.id);
    expect(entries.map((entry) => entry.status)).toEqual(["success", "success", "success"]);
    expect(entries.every((entry) => entry.durationMs >= 2 * MINUTE)).toBe(true); // each ran for as long as it waited
  });
});
