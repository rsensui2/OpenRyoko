import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, Employee, Engine, JinnConfig } from "../../shared/types.js";

// The runner used to resolve the engine and model itself and hand route() the
// result. Its model fallback read the DEFAULT engine's model, so an employee on
// another engine with no model of its own was started with a model that engine
// does not serve. It now passes only what the job names; route() resolves the
// rest. Every other combination must reach the engine exactly as before.
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

import { SessionManager } from "../../sessions/manager.js";
import { getSession } from "../../sessions/registry.js";
import { runCronJob } from "../runner.js";

const config = {
  engines: {
    default: "claude",
    claude: { bin: "claude-bin", model: "claude-model", fallback: [] },
    codex: { bin: "codex-bin", model: "codex-model", fallback: [] },
  },
  sessions: { transientRetryDelaysMs: [] },
  connectors: {},
  logging: { level: "error", stdout: false, file: false },
} as unknown as JinnConfig;
const connectors = new Map<string, Connector>();

let sequence = 0;
const job = (fields: Partial<CronJob> = {}): CronJob => ({
  id: `engine-selection-${++sequence}`, name: "Engine selection", enabled: true, schedule: "0 7 * * *",
  prompt: "Do the work", ...fields,
});
const employee = (fields: Partial<Employee>): Employee => ({
  name: "analyst", displayName: "Analyst", department: "ops", rank: "employee", engine: "claude", persona: "Analyses things.", ...fields,
});

/** Runs one fire against the real session manager and reports what reached the engine. */
async function fire(cronJob: CronJob, staff?: Employee) {
  registry.clear();
  if (staff) registry.set(staff.name, staff);
  const runs = { claude: vi.fn<Engine["run"]>(), codex: vi.fn<Engine["run"]>() };
  for (const [name, run] of Object.entries(runs)) run.mockResolvedValue({ sessionId: `${name}-1`, result: "Done.", cost: 0.01, numTurns: 1 });
  const manager = new SessionManager(config, new Map<string, Engine>([
    ["claude", { name: "claude", run: runs.claude }], ["codex", { name: "codex", run: runs.codex }],
  ]));
  await runCronJob(staff ? { ...cronJob, employee: staff.name } : cronJob, manager, config, connectors);
  const calls = Object.entries(runs).flatMap(([engine, run]) => run.mock.calls.map(([opts]) => ({ engine, opts })));
  expect(calls).toHaveLength(1);
  const [{ engine, opts }] = calls;
  const session = getSession(opts.sessionId!)!;
  return { engine, model: opts.model, bin: opts.bin, session };
}

beforeEach(() => vi.clearAllMocks());

describe("engine and model a cron fire runs on", () => {
  it.each([
    ["the job names engine and model", job({ engine: "codex", model: "gpt-job" }), undefined, "codex", "gpt-job"],
    ["the job names only an engine", job({ engine: "codex" }), undefined, "codex", "codex-model"],
    ["the job names only a model", job({ model: "claude-job" }), undefined, "claude", "claude-job"],
    ["the employee is on the default engine", job(), employee({ engine: "claude" }), "claude", "claude-model"],
    ["the employee is on the default engine with its own model", job(), employee({ engine: "claude", model: "claude-staff" }), "claude", "claude-staff"],
    ["the employee is on another engine with its own model", job(), employee({ engine: "codex", model: "gpt-staff" }), "codex", "gpt-staff"],
    ["neither names anything", job(), undefined, "claude", "claude-model"],
    ["the job's engine and model are blank strings", job({ engine: "", model: "" }), undefined, "claude", "claude-model"],
  ] as const)("is unchanged when %s", async (_label, cronJob, staff, engine, model) => {
    const ran = await fire(cronJob, staff);
    expect(ran).toMatchObject({ engine, model, bin: `${engine}-bin` });
    expect(ran.session.engine).toBe(engine);
  });

  it("gives an employee on a non-default engine that engine's own model, not the default engine's", async () => {
    const ran = await fire(job(), employee({ engine: "codex" }));
    expect(ran).toMatchObject({ engine: "codex", model: "codex-model", bin: "codex-bin" });
    expect(ran.session).toMatchObject({ engine: "codex", employee: "analyst" });
  });
});

describe("what a cron fire states to route()", () => {
  async function routeOptions(cronJob: CronJob, staff?: Employee): Promise<Record<string, unknown>> {
    registry.clear();
    if (staff) registry.set(staff.name, staff);
    const route = vi.fn().mockResolvedValue(undefined);
    await runCronJob(staff ? { ...cronJob, employee: staff.name } : cronJob, { route } as never, config, connectors);
    return route.mock.calls[0]![2] as Record<string, unknown>;
  }

  // route() resolves the employee and config defaults itself; a default the
  // runner spelled out would arrive looking like an engine the job asked for.
  it("names no engine or model the job did not name", async () => {
    const staff = employee({ engine: "codex", model: "gpt-staff" });
    for (const options of [await routeOptions(job()), await routeOptions(job(), staff)]) {
      expect(options.engine).toBeUndefined();
      expect(options.model).toBeUndefined();
    }
    expect((await routeOptions(job(), staff)).employee).toBe(staff);
  });

  it("names the engine, model and effort the job itself names", async () => {
    const options = await routeOptions(job({ engine: "codex", model: "gpt-job", effortLevel: "high" }));
    expect(options).toMatchObject({ engine: "codex", model: "gpt-job", effortLevel: "high" });
  });

  it("leaves the session's model unset unless the job pins one", async () => {
    expect((await fire(job())).session.model).toBeNull();
    expect((await fire(job({ engine: "codex" }))).session.model).toBeNull();
    expect((await fire(job({ model: "claude-job" }))).session.model).toBe("claude-job");
  });
});
