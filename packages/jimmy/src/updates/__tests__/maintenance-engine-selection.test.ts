import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, Employee, Engine, EngineResult, JinnConfig } from "../../shared/types.js";

// The update check's maintenance run is routed from a cron fire like any other
// cron turn, and it used to spell the default engine out when it did: an engine
// "named" that way is run as an instruction, so the session was never started
// on the fallback engine while the default one was out of allowance. It spent a
// failed turn on it first, every time. Like the cron runner, it now names only
// what the job names and leaves the rest to route().
const { registry, inspect } = vi.hoisted(() => ({ registry: new Map<string, unknown>(), inspect: vi.fn() }));

vi.mock("../maintenance-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../maintenance-audit.js")>()), inspectMaintenance: inspect,
}));
vi.mock("../../gateway/org.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/org.js")>()), scanOrg: () => registry,
}));
vi.mock("../../sessions/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/context.js")>()), buildContext: () => "context",
}));
vi.mock("../../sessions/callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/callbacks.js")>()),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));

import { _resetUsageLimitAnnouncements } from "../../sessions/engine-health-gate.js";
import { _resetEngineLoginKnowledge, noteLoginWorked } from "../../sessions/engine-login.js";
import { SessionManager } from "../../sessions/manager.js";
import { getSession } from "../../sessions/registry.js";
import { recordEngineUnavailable } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import { runUpdateMaintenance } from "../maintenance.js";

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const RECEIPTS = path.join(JINN_HOME, "updates", "maintenance");
const HOUR = 60 * 60_000;
const audit = { version: "2026.10.9", fingerprint: "first", findings: [{ id: "cron-efficiency-v1", count: 1 }], inventory: { enabledPromptJobs: 1 } };

const config = {
  engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true }, codex: { bin: "codex-bin", model: "codex-model" } },
  sessions: { transientRetryDelaysMs: [] }, connectors: {}, logging: { level: "error", stdout: false, file: false },
} as unknown as JinnConfig;

let sequence = 0;
const job = (fields: Partial<CronJob> = {}): CronJob => ({
  id: `maintenance-engine-${++sequence}`, name: "Update check", enabled: true, kind: "update-notification", schedule: "0 9 * * *",
  prompt: "", delivery: { connector: "slack", channel: "C-updates" }, ...fields,
});
const staff = (fields: Partial<Employee>): Employee => ({
  name: "operator", displayName: "Operator", department: "ops", rank: "employee", engine: "claude", persona: "Keeps the instance tidy.", ...fields,
});
const send = vi.fn<Connector["sendMessage"]>(async () => "message-ts");
const connectors = new Map<string, Connector>([["slack", { name: "slack", sendMessage: send } as unknown as Connector]]);

beforeEach(() => {
  vi.clearAllMocks();
  registry.clear();
  inspect.mockReturnValue(audit);
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
  fs.rmSync(RECEIPTS, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

describe("what a maintenance run states to route()", () => {
  async function routeOptions(cronJob: CronJob, employee?: Employee): Promise<Record<string, unknown>> {
    if (employee) registry.set(employee.name, employee);
    const route = vi.fn().mockResolvedValue(undefined);
    await runUpdateMaintenance(employee ? { ...cronJob, employee: employee.name } : cronJob, { route } as never, config, connectors);
    return route.mock.calls[0]![2] as Record<string, unknown>;
  }

  // A default spelled out here arrives looking like an engine the job asked for.
  it("names no engine or model the job did not name", async () => {
    const employee = staff({ engine: "codex", model: "gpt-staff" });
    for (const options of [await routeOptions(job()), await routeOptions(job(), employee)]) {
      expect(options.engine).toBeUndefined();
      expect(options.model).toBeUndefined();
    }
    expect((await routeOptions(job(), employee)).employee).toBe(employee);
  });

  it("names the engine, model and effort the job itself names", async () => {
    expect(await routeOptions(job({ engine: "codex", model: "gpt-job", effortLevel: "high" }))).toMatchObject({ engine: "codex", model: "gpt-job", effortLevel: "high" });
  });
});

describe("the engine a maintenance run uses", () => {
  const answered = (engine: string): EngineResult => ({ sessionId: `${engine}-thread`, result: `Reviewed by ${engine}: one suggestion.`, cost: 0.01, numTurns: 1 });

  async function run(cronJob: CronJob, employee?: Employee) {
    if (employee) registry.set(employee.name, employee);
    const runs = { claude: vi.fn<Engine["run"]>(async () => answered("claude")), codex: vi.fn<Engine["run"]>(async () => answered("codex")) };
    const manager = new SessionManager(config, new Map<string, Engine>([
      ["claude", { name: "claude", run: runs.claude }], ["codex", { name: "codex", run: runs.codex }],
    ]));
    const outcome = await runUpdateMaintenance(employee ? { ...cronJob, employee: employee.name } : cronJob, manager, config, connectors);
    return { runs, outcome, session: outcome.sessionId ? getSession(outcome.sessionId) : undefined };
  }

  it.each([
    ["the default engine, with its model", job(), undefined, "claude", "claude-model"],
    ["the engine and model the job names", job({ engine: "codex", model: "gpt-job" }), undefined, "codex", "gpt-job"],
    ["the employee's engine, with that engine's own model", job(), staff({ engine: "codex" }), "codex", "codex-model"],
    ["the employee's engine and model", job(), staff({ engine: "codex", model: "gpt-staff" }), "codex", "gpt-staff"],
  ] as const)("is %s, as before", async (_label, cronJob, employee, engine, model) => {
    const f = await run(cronJob, employee);

    expect(f.outcome).toMatchObject({ status: "notified", outcome: "completed" });
    const calls = Object.entries(f.runs).flatMap(([name, fn]) => fn.mock.calls.map(([opts]) => ({ name, opts })));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: engine, opts: { model, bin: `${engine}-bin` } });
    expect(f.session).toMatchObject({ engine, status: "idle" });
  });

  it("is the fallback engine, without a failed turn first, while the default engine is known to be out of allowance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    recordEngineUnavailable("claude", "claude usage limit", Math.floor((Date.now() + 2 * HOUR) / 1000), new Date(), "5h");
    noteLoginWorked("codex"); // Codex has answered a turn in this process

    const f = await run(job());

    expect(f.runs.claude).not.toHaveBeenCalled();
    expect(f.runs.codex).toHaveBeenCalledTimes(1);
    expect(f.runs.codex.mock.calls[0]![0]).toMatchObject({ model: "codex-model", bin: "codex-bin" });
    expect(f.outcome).toMatchObject({ status: "notified", outcome: "completed" });
    expect(f.session).toMatchObject({ engine: "codex", status: "idle", lastError: null });
    expect(send).toHaveBeenCalledExactlyOnceWith({ channel: "C-updates" }, expect.stringContaining("Reviewed by codex: one suggestion."));
  });

  it("is still the engine the job names, spent or not: that is an instruction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    recordEngineUnavailable("claude", "claude usage limit", Math.floor((Date.now() + 2 * HOUR) / 1000), new Date(), "5h");
    noteLoginWorked("codex");

    const f = await run(job({ engine: "claude" }));

    expect(f.runs.claude).toHaveBeenCalledTimes(1);
    expect(f.runs.codex).not.toHaveBeenCalled();
  });
});
