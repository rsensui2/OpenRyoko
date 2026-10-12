import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, Engine, EngineResult, JinnConfig, Session } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

const { org } = vi.hoisted(() => ({ org: new Map<string, unknown>() }));

vi.mock("../org.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org.js")>()),
  scanOrg: () => org,
}));
vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../../sessions/context.js", () => ({ buildContext: vi.fn(() => "context") }));
vi.mock("../../sessions/goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "Verified by test" })) }));

/**
 * A session a connector routes is started on the fallback engine while the
 * engine it would have used is known to be out of allowance. One created
 * through the API was not: every child session a parent delegated to, and every
 * new chat in the web UI, spent a failed turn on the spent engine first and
 * told the operator it was switching — once per child, for as long as the limit
 * lasted.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "api-health-aware-start-"));
process.env.JINN_HOME = scratch;
process.env.RYOKO_HOME = scratch;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let Manager: typeof import("../../sessions/manager.js").SessionManager;
let callbacks: typeof import("../../sessions/callbacks.js");
let health: typeof import("../../shared/engine-health.js");
let gate: typeof import("../../sessions/engine-health-gate.js");
let login: typeof import("../../sessions/engine-login.js");

const START = Date.parse("2026-10-12T07:00:00.000Z");
const HOUR = 60 * 60_000;
const RESET = START + 2 * HOUR;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  Manager = (await import("../../sessions/manager.js")).SessionManager;
  callbacks = await import("../../sessions/callbacks.js");
  health = await import("../../shared/engine-health.js");
  gate = await import("../../sessions/engine-health-gate.js");
  login = await import("../../sessions/engine-login.js");
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: START, toFake: ["Date"] });
  org.clear();
  fs.rmSync(path.join(scratch, "tmp", "engine-health.json"), { force: true });
  gate._resetUsageLimitAnnouncements();
  login._resetEngineLoginKnowledge();
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const answered = (engine: string): EngineResult => ({ sessionId: `${engine}-thread`, result: `Answered by ${engine}.`, cost: 0.1, numTurns: 1 });
const spent = (): EngineResult => ({ sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor(RESET / 1000), window: "5h" } });
const staff = (fields: Partial<Employee>): Employee => ({
  name: "analyst", displayName: "Analyst", department: "ops", rank: "employee", engine: "claude", persona: "Analyses things.", ...fields,
});

function setup(sessions: JinnConfig["sessions"] = {}) {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude-test", model: "opus", interactive: true }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    connectors: {}, sessions, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  // Claude is out until RESET and answers again afterwards.
  const claudeRun = vi.fn<Engine["run"]>(async () => (Date.now() < RESET ? spent() : answered("claude")));
  const codexRun = vi.fn<Engine["run"]>(async () => answered("codex"));
  const sessionManager = new Manager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]), []);
  const emit = vi.fn();
  const context: ApiContext = { config, getConfig: () => config, sessionManager, startTime: Date.now(), emit, connectors: new Map() };
  const parent = registry.createSession({ engine: "claude", source: "slack", sourceRef: `slack:parent-${Date.now()}-${Math.random()}`, connector: "slack", sessionKey: `slack:parent-${Math.random()}` });
  /** Wait until `count` turns of the session have finished. */
  const settled = (sessionId: string, count = 1) => vi.waitFor(() =>
    expect(emit.mock.calls.filter(([event, payload]) => event === "session:completed" && payload.sessionId === sessionId)).toHaveLength(count), { timeout: 3000 });
  /** Create a session the way a parent delegates to a child, and wait for its first turn. */
  const createChild = async (body: Record<string, unknown> = {}) => {
    const response = await request(context, "POST", "/api/sessions", { prompt: "Summarise the thread.", parentSessionId: parent.id, ...body });
    expect(response.status).toBe(201);
    await settled(String(response.body.id));
    return { created: response.body as unknown as Session, session: registry.getSession(String(response.body.id))! };
  };
  return { context, parent, claudeRun, codexRun, emit, settled, createChild };
}

/** Claude is known to be out until RESET, and Codex has answered a turn in this process. */
function claudeKnownToBeOut() {
  health.recordEngineUnavailable("claude", "claude usage limit", Math.floor(RESET / 1000), new Date(), "5h");
  login.noteLoginWorked("codex");
}

async function request(context: ApiContext, method: string, url: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, unknown> = {};
  const res = { writeHead(code: number) { status = code; return this; }, setHeader(name: string, value: unknown) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; }, end(value?: unknown) { if (value) chunks.push(String(value)); } } as unknown as ServerResponse;
  await api.handleApiRequest(req, res, context);
  return { status, body: (chunks.length ? JSON.parse(chunks.join("")) : {}) as Record<string, unknown> };
}

const override = (session: Session) => (session.transportMeta as { engineOverride?: Record<string, unknown> } | null)?.engineOverride;
const notifications = (sessionId: string) => registry.getMessages(sessionId).filter((message) => message.role === "notification").map((message) => message.content);

describe("POST /api/sessions while the default engine is known to be out of allowance", () => {
  it("starts a child session on the fallback engine, with no failed turn and no switch for the operator to be told of", async () => {
    const f = setup();
    claudeKnownToBeOut();

    const { created, session } = await f.createChild();

    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(f.codexRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun.mock.calls[0]![0]).toMatchObject({ model: "gpt-5.4", bin: "codex-test", prompt: "Summarise the thread." });
    // What the caller is handed back already says where the session runs.
    expect(created).toMatchObject({ engine: "codex", model: "gpt-5.4", status: "running" });
    expect(session).toMatchObject({ engine: "codex", status: "idle", lastError: null, parentSessionId: f.parent.id });
    expect(override(session)).toMatchObject({ originalEngine: "claude", originalModel: null, source: "engine-health" });
    expect(callbacks.notifyDiscordChannel).not.toHaveBeenCalled();
    expect(callbacks.notifyParentSession).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), expect.objectContaining({ result: "Answered by codex." }), expect.anything());
  });

  it("says why in the first session of a limit period, and not again in the ones after it", async () => {
    const f = setup();
    claudeKnownToBeOut();

    const first = await f.createChild();
    const second = await f.createChild();

    expect(notifications(first.session.id)).toEqual([expect.stringMatching(/^⚠️ claude usage limit reached \(resets .+\)\. Starting on codex\.$/)]);
    expect(notifications(second.session.id)).toEqual([]);
    expect(f.emit).toHaveBeenCalledWith("session:notification", { sessionId: first.session.id, message: notifications(first.session.id)[0] });
    expect(f.claudeRun).not.toHaveBeenCalled();
  });

  it("goes back to the session's own engine once the limit has reset, and starts new sessions there again", async () => {
    const f = setup();
    claudeKnownToBeOut();
    const { session } = await f.createChild();

    vi.setSystemTime(RESET + 60_000);
    const followUp = await request(f.context, "POST", `/api/sessions/${session.id}/message`, { message: "And the open questions?" });
    expect(followUp.status).toBe(200);
    await f.settled(session.id, 2);
    const fresh = await f.createChild();

    expect(f.codexRun).toHaveBeenCalledTimes(1);
    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    // The session's own engine is told what happened while it was away.
    expect(f.claudeRun.mock.calls[0]![0]).toMatchObject({ model: "opus", bin: "claude-test" });
    expect(f.claudeRun.mock.calls[0]![0].prompt).toContain("Answered by codex.");
    const back = registry.getSession(session.id)!;
    expect(back).toMatchObject({ engine: "claude", status: "idle" });
    expect(override(back)).toBeUndefined();
    expect(fresh.session).toMatchObject({ engine: "claude", status: "idle" });
    expect(override(fresh.session)).toBeUndefined();
  });

  // Naming the engine or the model is an instruction. Such a session fails its
  // turn on the spent engine and is switched within it, as it always was.
  it.each([
    ["its engine", { engine: "claude" }],
    ["a model", { model: "opus" }],
  ])("does not move a session whose request names %s", async (_label, named) => {
    const f = setup();
    claudeKnownToBeOut();

    const { created, session } = await f.createChild(named);

    expect(created).toMatchObject({ engine: "claude" });
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).toHaveBeenCalledTimes(1);
    expect(session).toMatchObject({ engine: "codex", status: "idle" });
    expect(callbacks.notifyDiscordChannel).toHaveBeenCalledTimes(1); // the switch, as before
  });

  it("leaves an employee on another engine where it works, and moves one whose own engine is out with the fallback's model", async () => {
    const f = setup();
    claudeKnownToBeOut();
    org.set("coder", staff({ name: "coder", engine: "codex" }));
    org.set("analyst", staff({ name: "analyst", engine: "claude", model: "claude-staff" }));

    const coder = await f.createChild({ employee: "coder" });
    const analyst = await f.createChild({ employee: "analyst" });

    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(coder.session).toMatchObject({ engine: "codex", employee: "coder" });
    expect(override(coder.session)).toBeUndefined(); // never moved: this is where the employee works
    expect(analyst.session).toMatchObject({ engine: "codex", employee: "analyst", model: "gpt-5.4" });
    expect(override(analyst.session)).toMatchObject({ originalEngine: "claude", originalModel: "claude-staff" });
  });

  it.each([
    ["the instance waits limits out instead of switching", { rateLimitStrategy: "wait" as const }, {}, undefined],
    ["the employee runs on a remote machine", {}, { employee: "remote" }, staff({ name: "remote", engine: "claude", sshHost: "worker-box" })],
  ])("starts the session where it always did when %s", async (_label, sessions, body, employee) => {
    const f = setup(sessions);
    claudeKnownToBeOut();
    if (employee) org.set(employee.name, employee);
    // Not this scenario's subject: let the turn on Claude simply answer.
    f.claudeRun.mockImplementation(async () => answered("claude"));

    const { created } = await f.createChild(body);

    expect(created).toMatchObject({ engine: "claude" });
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).not.toHaveBeenCalled();
  });

  it("starts on the default engine as before when nothing is known to be wrong with it", async () => {
    const f = setup();
    login.noteLoginWorked("codex");
    f.claudeRun.mockImplementation(async () => answered("claude"));

    const { created, session } = await f.createChild();

    expect(created).toMatchObject({ engine: "claude" });
    expect(session).toMatchObject({ engine: "claude", status: "idle" });
    expect(f.codexRun).not.toHaveBeenCalled();
    expect(notifications(session.id)).toEqual([]);
  });
});
