import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEngineWithResponseTimeout, runFallbackAttempts } from "../engine-fallback.js";
import { exhaustedRecordFor, setEngineInstallProbe } from "../engine-health-gate.js";
import { createSession, getSession } from "../registry.js";
import { readEngineHealth, recordEngineUnavailable } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
let sequence = 0;

function config(): JinnConfig {
  return { engines: { default: "claude",
    claude: { bin: "claude-bin", model: "claude-model" },
    codex: { bin: "codex-bin", model: "codex-model" },
    gemini: { bin: "gemini-bin", model: "gemini-model" } },
    sessions: {}, connectors: {}, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
}

const answering = (name: string): Engine =>
  ({ name, run: vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: `${name}-new`, result: `Answered by ${name}.` }) });

/** A Claude session whose turn has just come back limited, with every engine registered. */
function limitedClaudeTurn(cfg: JinnConfig = config()) {
  const session = createSession({ engine: "claude", source: "slack", sourceRef: `fallback-health-${++sequence}` });
  const engines = new Map<string, Engine>(["claude", "codex", "gemini"].map((name) => [name, answering(name)]));
  const initialOpts: EngineRunOpts = { prompt: "Summarise the thread.", cwd: "/test", sessionId: session.id };
  const initialResult: EngineResult = { sessionId: "claude-limited", result: "", error: "Usage limit reached", numTurns: 1 };
  return { session, engines, options: { config: cfg, session, initialEngine: engines.get("claude")!, initialResult, initialOpts,
    getEngine: (name: string) => engines.get(name), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) } };
}

beforeEach(() => {
  invalidateModelRegistry();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => {
  setEngineInstallProbe(undefined);
  vi.useRealTimers();
});

describe("what an engine attempt leaves on the health record", () => {
  const attempt = (engine: Engine, opts: Partial<EngineRunOpts> = {}) =>
    runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId: "s", model: "claude-model", ...opts }, config());

  it("records a limit together with the reset the engine stated", async () => {
    const reopensAt = inMinutes(45);
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "", error: "Interactive turn failed: rate_limit",
      numTurns: 1, rateLimit: { status: "rejected", resetsAt: reopensAt, window: "5h" } }) });

    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted", until: new Date(reopensAt * 1000).toISOString(), window: "5h" });
  });

  it("forgets the record once the engine serves a turn", async () => {
    recordEngineUnavailable("claude", "claude usage limit", inMinutes(45));

    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "All done." }) });

    expect(exhaustedRecordFor("claude", "claude-model")).toBeUndefined();
  });

  it("keeps the record when a turn that was already running at the limit finishes afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let finish!: (result: EngineResult) => void;
    const alreadyRunning = attempt({ name: "claude", run: () => new Promise<EngineResult>((resolve) => { finish = resolve; }) });

    vi.setSystemTime(Date.now() + 60_000); // a minute later another turn is refused
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "", error: "Interactive turn failed: rate_limit",
      numTurns: 1, rateLimit: { status: "rejected", resetsAt: inMinutes(45), window: "5h" } }) });
    vi.setSystemTime(Date.now() + 60_000); // and a minute after that the first one finishes what it had started
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish({ sessionId: "s", result: "Finished what it had started." });
    await alreadyRunning;

    expect(exhaustedRecordFor("claude", "claude-model")).toBeDefined();

    // A turn that starts now and is served is the evidence the record waits for.
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "All done." }) });
    expect(exhaustedRecordFor("claude", "claude-model")).toBeUndefined();
  });

  it("does not let a turn that ran on a remote machine speak for the local account", async () => {
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "", error: "Rate limited",
      rateLimit: { status: "rejected", resetsAt: inMinutes(45) } }) }, { sshHost: "worker-box" });
    expect(readEngineHealth().claude).toBeUndefined();

    recordEngineUnavailable("claude", "claude usage limit", inMinutes(45));
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "Remote answer." }) }, { sshHost: "worker-box" });
    expect(exhaustedRecordFor("claude", "claude-model")).toBeDefined();
  });
});

describe("choosing a fallback engine with health in view", () => {
  it("skips a chain member known to be out of allowance and takes the next one", async () => {
    const cfg = config();
    cfg.engines.claude.fallback = ["codex", "gemini"];
    recordEngineUnavailable("codex", "codex usage limit", inMinutes(60));
    const { options, engines } = limitedClaudeTurn(cfg);

    const outcome = await runFallbackAttempts(options);

    expect(outcome).toMatchObject({ attempted: true, result: { result: "Answered by gemini." } });
    expect(engines.get("codex")!.run).not.toHaveBeenCalled();
    expect(getSession(options.session.id)!.engine).toBe("gemini");
  });

  it("returns the original limit, without switching, when the only member is known to be out", async () => {
    recordEngineUnavailable("codex", "codex usage limit", inMinutes(60));
    const { options, engines, session } = limitedClaudeTurn();
    const onSwitch = vi.fn();

    const outcome = await runFallbackAttempts({ ...options, onSwitch });

    expect(outcome).toMatchObject({ attempted: false, result: { error: "Usage limit reached" } });
    expect(outcome.engine.name).toBe("claude");
    expect(engines.get("codex")!.run).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(getSession(session.id)).toMatchObject({ engine: "claude", transportMeta: null });
  });

  it("takes the member back once its window has passed", async () => {
    recordEngineUnavailable("codex", "codex usage limit", inMinutes(60));
    vi.useFakeTimers({ now: Date.now() + 61 * 60_000, toFake: ["Date"] });
    const { options, engines } = limitedClaudeTurn();

    const outcome = await runFallbackAttempts(options);

    expect(outcome.attempted).toBe(true);
    expect(engines.get("codex")!.run).toHaveBeenCalledTimes(1);
  });

  it("does not switch to an engine whose binary is known to be missing", async () => {
    setEngineInstallProbe((bin) => bin !== "codex-bin");
    const { options, engines, session } = limitedClaudeTurn();

    const outcome = await runFallbackAttempts(options);

    expect(outcome).toMatchObject({ attempted: false, result: { error: "Usage limit reached" } });
    expect(engines.get("codex")!.run).not.toHaveBeenCalled();
    expect(getSession(session.id)!.engine).toBe("claude");
  });

  it("still switches to an engine a limit without a stated reset was seen on", async () => {
    recordEngineUnavailable("codex", "codex usage limit", undefined);
    const { options, engines } = limitedClaudeTurn();

    const outcome = await runFallbackAttempts(options);

    expect(outcome.attempted).toBe(true);
    expect(engines.get("codex")!.run).toHaveBeenCalledTimes(1);
  });
});
