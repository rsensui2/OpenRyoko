import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFallbackAttempts } from "../engine-fallback.js";
import { _resetEngineLoginKnowledge, confirmLoginRefusal, loginRefusalConfirmed, noteLoginRefusal } from "../engine-login.js";
import { createSession, getSession, updateSession } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Engine, EngineResult, EngineRunOpts, InterruptibleEngine, JinnConfig } from "../../shared/types.js";

/**
 * A machine can have Codex installed and never signed in. When Claude ran into
 * its limit there, the session was switched to Codex, Codex answered with a
 * login prompt, and the session stayed pinned to it — every message failing —
 * until the override ran out, up to six hours later.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const NOT_SIGNED_IN: EngineResult = { sessionId: "", result: "", error: "Codex exited with code 1: Not logged in" };
const LIMITED: EngineResult = { sessionId: "claude-thread", result: "", error: "Usage limit reached", cost: 0.1, numTurns: 1 };
let sequence = 0;

function config(): JinnConfig {
  return { engines: { default: "claude",
    claude: { bin: "claude-bin", model: "claude-model" },
    codex: { bin: "codex-bin", model: "codex-model" },
    gemini: { bin: "gemini-bin", model: "gemini-model" } },
    sessions: {}, connectors: {}, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
}

/** A Claude session, pinned to a model and an effort, whose turn has just come back limited. */
function limitedClaudeTurn(cfg: JinnConfig = config()) {
  const created = createSession({ engine: "claude", source: "slack", sourceRef: `login-refusal-${++sequence}`, model: "claude-pin", effortLevel: "high" });
  const session = updateSession(created.id, { engineSessionId: "claude-before" })!;
  const run = (name: string) => vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: `${name}-new`, result: `Answered by ${name}.` });
  const runs = { claude: run("claude"), codex: run("codex"), gemini: run("gemini") };
  const engines = new Map<string, Engine>(Object.entries(runs).map(([name, fn]) => [name, { name, run: fn }]));
  const initialOpts: EngineRunOpts = { prompt: "Summarise the thread.", cwd: "/test", sessionId: session.id };
  return { session, runs, engines, options: { config: cfg, session, initialEngine: engines.get("claude")!, initialResult: LIMITED, initialOpts,
    getEngine: (name: string) => engines.get(name), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) } };
}

beforeEach(() => {
  invalidateModelRegistry();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => vi.useRealTimers());

describe("a fallback engine that cannot sign in", () => {
  it("has the switch taken back, and the turn handed on exactly as if there had been no fallback", async () => {
    const f = limitedClaudeTurn();
    f.runs.codex.mockResolvedValue(NOT_SIGNED_IN);

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome).toMatchObject({ attempted: false, result: LIMITED });
    expect(outcome.engine.name).toBe("claude");
    expect(f.runs.codex).toHaveBeenCalledTimes(2); // asked twice before it is believed
    const stored = getSession(f.session.id)!;
    expect(stored).toMatchObject({ engine: "claude", model: "claude-pin", effortLevel: "high", engineSessionId: "claude-before" });
    expect((stored.transportMeta as { engineOverride?: unknown } | null)?.engineOverride).toBeUndefined();
    expect(outcome.session).toMatchObject({ engine: "claude", model: "claude-pin", effortLevel: "high" });
    // The limited turn is the caller's to account, once — not already counted here.
    expect(stored).toMatchObject({ totalCost: 0, totalTurns: 0 });
  });

  it("is believed only after refusing twice: one that signs in on the second try just carries on", async () => {
    const f = limitedClaudeTurn();
    f.runs.codex.mockResolvedValueOnce(NOT_SIGNED_IN);

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome).toMatchObject({ attempted: true, result: { result: "Answered by codex." } });
    expect(f.runs.codex).toHaveBeenCalledTimes(2);
    expect(getSession(f.session.id)).toMatchObject({ engine: "codex", engineSessionId: "codex-new" });
    expect(loginRefusalConfirmed("codex")).toBe(false);
  });

  it("has the tracked goal the switch restored for Codex taken back with it", async () => {
    const f = limitedClaudeTurn();
    // Claude's native goal handoff had cleared the gateway's copy; the switch puts it back for Codex.
    f.options.session = { ...f.options.session, goal: { id: "goal", condition: "Draft verified", request: "Check draft", status: "active", updatedAt: new Date().toISOString() } };
    f.runs.codex.mockImplementation(async () => {
      expect(getSession(f.session.id)!.goal?.condition).toBe("Draft verified");
      return NOT_SIGNED_IN;
    });

    await runFallbackAttempts(f.options);

    expect(getSession(f.session.id)!.goal ?? null).toBeNull();
  });

  it("gets a fresh process for its second try, and keeps none for the session once the switch is taken back", async () => {
    const f = limitedClaudeTurn();
    const events: string[] = [];
    const codex: InterruptibleEngine = { name: "codex", killAll: vi.fn(), isAlive: () => false,
      run: vi.fn(async () => { events.push("run"); return NOT_SIGNED_IN; }),
      kill: vi.fn((sessionId: string, reason?: string) => { events.push(`stop ${sessionId === f.session.id ? "this session" : sessionId} (${reason})`); }) };
    f.engines.set("codex", codex);

    await runFallbackAttempts(f.options);

    expect(events).toEqual([
      "run",
      "stop this session (Interrupted: retrying after a login refusal)", // a warm process would keep the login it failed with
      "run",
      "stop this session (Interrupted: engine switched)",
    ]);
  });

  it("is then left out of fallback for half an hour, and offered a turn again after that", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = limitedClaudeTurn();
    first.runs.codex.mockResolvedValue(NOT_SIGNED_IN);
    await runFallbackAttempts(first.options);

    const held = limitedClaudeTurn();
    expect((await runFallbackAttempts(held.options)).attempted).toBe(false);
    expect(held.runs.codex).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 31 * 60_000);
    const later = limitedClaudeTurn(); // signed in by now
    expect(await runFallbackAttempts(later.options)).toMatchObject({ attempted: true, result: { result: "Answered by codex." } });
  });

  it("gives way to the next engine in the chain when there is one", async () => {
    const cfg = config();
    cfg.engines.claude.fallback = ["codex", "gemini"];
    const f = limitedClaudeTurn(cfg);
    f.runs.codex.mockResolvedValue(NOT_SIGNED_IN);

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome).toMatchObject({ attempted: true, result: { result: "Answered by gemini." } });
    const stored = getSession(f.session.id)!;
    expect(stored.engine).toBe("gemini");
    expect((stored.transportMeta as { engineOverride: Record<string, unknown> }).engineOverride)
      .toMatchObject({ originalEngine: "claude", originalModel: "claude-pin", originalEffortLevel: "high" });
  });

  it.each<[string, EngineResult]>([
    ["crashed for another reason", { sessionId: "", result: "", error: "Codex exited with code 1: stream disconnected before completion" }],
    ["ran into a limit of its own", { sessionId: "", result: "", error: "Rate limited" }],
    // Codex's real shape for a turn that ran a command and then lost its login:
    // no cost and no turn count, only what was seen on its stream. It must not
    // be asked again — that would run the command a second time.
    ["was refused its login only after running a command", { sessionId: "codex-new", result: "", error: "unexpected status 401 Unauthorized: token expired",
      handoffContext: "Observed tool events (verify their effects before continuing):\ntool_use: command_execution\ntool_result: command_execution" }],
  ])("keeps the switch when the fallback engine %s", async (_label, failure) => {
    const f = limitedClaudeTurn();
    f.runs.codex.mockResolvedValue(failure);

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome).toMatchObject({ attempted: true, result: { error: failure.error } });
    expect(f.runs.codex).toHaveBeenCalledTimes(1);
    expect(getSession(f.session.id)!.engine).toBe("codex");
    expect(loginRefusalConfirmed("codex")).toBe(false);
  });

  it("is not asked a second time once the turn has been stopped", async () => {
    const f = limitedClaudeTurn();
    let stopped = false;
    f.runs.codex.mockImplementation(async () => { stopped = true; return NOT_SIGNED_IN; });

    const outcome = await runFallbackAttempts({ ...f.options, shouldStop: () => stopped });

    expect(f.runs.codex).toHaveBeenCalledTimes(1);
    expect(outcome.result.error).toMatch(/^Interrupted/);
  });
});

describe("a session already held on a fallback engine that stops signing in", () => {
  /** A Claude conversation currently held on Codex, whose turn there has just been refused. */
  function parkedOnCodex() {
    const f = limitedClaudeTurn();
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const session = updateSession(f.session.id, { engine: "codex", engineSessionId: "codex-thread", model: "codex-model", effortLevel: "medium",
      transportMeta: { engineOverride: { originalEngine: "claude", originalEngineSessionId: "claude-before", originalModel: "claude-pin",
        originalEffortLevel: "high", until, syncSince: new Date().toISOString() } } })!;
    const refused: EngineResult = { ...NOT_SIGNED_IN, sessionId: "codex-thread" };
    return { ...f, options: { ...f.options, session, initialEngine: f.options.getEngine("codex")!, initialResult: refused } };
  }

  it("goes back to its own engine, model and effort once the refusal is confirmed", async () => {
    const f = parkedOnCodex();
    const kill = vi.fn();
    Object.assign(f.options.initialEngine, { kill, killAll: vi.fn(), isAlive: () => false });
    confirmLoginRefusal("codex"); // the turn's two attempts, both refused

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome.attempted).toBe(false);
    expect(kill).toHaveBeenCalledExactlyOnceWith(f.session.id, "Interrupted: engine switched"); // nothing of it is left running for the session
    // The refusal is still this turn's answer, but no Codex id is carried back.
    expect(outcome.result).toMatchObject({ error: NOT_SIGNED_IN.error, sessionId: "" });
    const stored = getSession(f.session.id)!;
    expect(stored).toMatchObject({ engine: "claude", model: "claude-pin", effortLevel: "high", engineSessionId: "claude-before" });
    expect((stored.transportMeta as { engineOverride?: unknown }).engineOverride).toBeUndefined();
    expect(f.runs.claude).not.toHaveBeenCalled();
  });

  it("stays where it is over a single refusal, which may pass", async () => {
    const f = parkedOnCodex();
    noteLoginRefusal("codex");

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome.result).toMatchObject({ error: NOT_SIGNED_IN.error, sessionId: "codex-thread" });
    expect(getSession(f.session.id)!.engine).toBe("codex");
  });

  it("is not moved anywhere when Codex is simply the engine it runs on", async () => {
    const f = parkedOnCodex();
    updateSession(f.session.id, { transportMeta: {} });
    confirmLoginRefusal("codex");

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome.result).toMatchObject({ error: NOT_SIGNED_IN.error, sessionId: "codex-thread" });
    expect(getSession(f.session.id)!.engine).toBe("codex");
    expect(f.runs.claude).not.toHaveBeenCalled();
  });
});
