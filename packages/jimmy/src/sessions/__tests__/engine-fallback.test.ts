import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEngineSyncPrompt, computeEngineOverrideRevert, engineFallbackFailure, runEngineWithResponseTimeout, runFallbackAttempts } from "../engine-fallback.js";
import { createSession, getSession, insertMessage, updateSession } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import type { Engine, EngineResult, EngineRunOpts, InterruptibleEngine, JinnConfig } from "../../shared/types.js";

let sequence = 0;
function setup(from: "claude" | "codex" = "codex") {
  const to = from === "codex" ? "claude" : "codex";
  const config = { engines: { default: from, claude: { bin: "claude-bin", model: "claude-model", effortLevel: "high" },
    codex: { bin: "codex-bin", model: "codex-model", effortLevel: "medium" } }, sessions: {}, connectors: {},
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const session = createSession({ engine: from, source: "web", sourceRef: `fallback-${++sequence}`, model: "source-pin", effortLevel: "high" });
  updateSession(session.id, { engineSessionId: `${from}-old` });
  insertMessage(session.id, "user", "Earlier request: create a draft, do not send it.");
  insertMessage(session.id, "assistant", "Draft created.");
  insertMessage(session.id, "user", "Now check the draft.");
  const run = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: `${to}-new`, result: "Checked.", cost: 0.2 });
  const target: Engine = { name: to, run };
  const source: Engine = { name: from, run: vi.fn() };
  const engines = new Map([[from, source], [to, target]]);
  const initialOpts: EngineRunOpts = { prompt: "Now check the draft.", cwd: "/test", sessionId: session.id, model: "source-pin",
    cliFlags: ["--source-only"], sshHost: "source-remote", remoteCwd: "/source", attachments: ["/tmp/attachment"] };
  const options = { config, session: getSession(session.id)!, initialEngine: source,
    initialResult: { sessionId: `${from}-new`, result: "", error: "Usage limit reached", cost: 0.1 } satisfies EngineResult,
    initialOpts, getEngine: (name: string) => engines.get(name as "claude" | "codex"), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) };
  return { options, from, to, run, engines, config };
}
beforeEach(() => invalidateModelRegistry());
afterEach(() => vi.useRealTimers());

describe("shared session fallback", () => {
  it.each(["claude", "codex"] as const)("switches %s after quota and preserves target configuration, history and accounting", async (from) => {
    const { options, to, run } = setup(from);
    const result = await runFallbackAttempts(options);
    expect(result.attempted).toBe(true);
    expect(result.engine.name).toBe(to);
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bin: `${to}-bin`, model: `${to}-model`, attachments: ["/tmp/attachment"],
      cliFlags: undefined, sshHost: undefined, remoteCwd: undefined }));
    expect(run.mock.calls[0][0].prompt).toContain("Draft created.");
    expect(run.mock.calls[0][0].prompt).toContain("do not repeat completed tool actions");
    const stored = getSession(options.session.id)!;
    expect(stored.engine).toBe(to);
    expect(stored.model).toBe(`${to}-model`);
    expect(stored.engineSessionId).toBe(`${to}-new`);
    expect(stored.totalCost).toBeCloseTo(0.1); // caller accounts the final attempt once
    expect(stored.transportMeta!.engineSessions).toMatchObject({ [from]: `${from}-new`, [to]: `${to}-new` });
    expect(stored.transportMeta!.engineOverride).toMatchObject({ originalEngine: from, originalModel: "source-pin", originalEffortLevel: "high" });
  });

  it.each(["claude", "codex"] as const)("falls back for a genuinely empty %s answer", async (from) => {
    const { options, run } = setup(from);
    const result = await runFallbackAttempts({ ...options, initialResult: { sessionId: "original", result: "  " } });
    expect(result.result.result).toBe("Checked.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refreshes resumed target context with work done while another provider was active", async () => {
    const { options, run, to } = setup();
    updateSession(options.session.id, { transportMeta: { engineSessions: { [to]: "target-previous" } } });
    await runFallbackAttempts(options);
    expect(run.mock.calls[0][0].resumeSessionId).toBe("target-previous");
    expect(run.mock.calls[0][0].prompt).toContain("Draft created.");
  });

  it("carries bounded failed-attempt partial work and tool occurrence into the replacement", async () => {
    const { options, run, config } = setup();
    const source: Engine = { name: "codex", run: async (opts) => {
      opts.onStream?.({ type: "tool_use", toolName: "write_file", content: "PRIVATE_TOOL_ARGUMENT" });
      opts.onStream?.({ type: "tool_result", toolName: "write_file", content: "PRIVATE_TOOL_RESULT" });
      opts.onStream?.({ type: "text", content: "Created the draft file already." });
      return { sessionId: "source", result: "Do not recreate draft.md.", turns: ["The draft is saved."], error: "Usage limit reached" };
    } };
    const failed = await runEngineWithResponseTimeout(source, options.initialOpts, config);
    await runFallbackAttempts({ ...options, initialResult: failed });
    const prompt = run.mock.calls[0][0].prompt;
    expect(prompt).toContain("Created the draft file already.");
    expect(prompt).toContain("Do not recreate draft.md.");
    expect(prompt).toContain("tool_result: write_file");
    expect(prompt).not.toMatch(/PRIVATE_TOOL_ARGUMENT|PRIVATE_TOOL_RESULT/);
    expect(failed.handoffContext!.length).toBeLessThanOrEqual(8000);
  });

  it("stops after both sides fail even with explicit cyclic chains", async () => {
    const { options, config, run, engines } = setup();
    config.engines.codex.fallback = ["claude"];
    config.engines.claude.fallback = ["codex"];
    run.mockResolvedValue({ sessionId: "target", result: "", error: "Rate limited" });
    const result = await runFallbackAttempts(options);
    expect(result.result.error).toBe("Rate limited");
    expect(run).toHaveBeenCalledTimes(1);
    expect(engines.get("codex")!.run).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "disabled", "wait"])("does not silently override %s fallback configuration", async (mode) => {
    const { options, config, to, engines, run } = setup();
    if (mode === "unavailable") engines.delete(to);
    if (mode === "disabled") config.engines.codex.fallback = [];
    if (mode === "wait") config.sessions!.rateLimitStrategy = "wait";
    expect((await runFallbackAttempts(options)).attempted).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "s", result: "", error: "Interrupted: user cancelled" },
    { sessionId: "s", result: "", error: "Goal incomplete", retryable: false as const },
    { sessionId: "s", result: "", responseExpected: false as const },
    { sessionId: "s", result: "<!--RYOKO-DISPOSITION:v1:eyJzdXBwcmVzc1B1YmxpYyI6dHJ1ZX0-->" },
  ])("does not revive cancellation, application stops, native commands or intentional silence", async (initialResult) => {
    const { options, run } = setup();
    expect((await runFallbackAttempts({ ...options, initialResult })).attempted).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("observes cancellation between switch notification and target launch", async () => {
    const { options, run } = setup();
    let cancelled = false;
    const result = await runFallbackAttempts({ ...options, shouldStop: () => cancelled, onSwitch: () => { cancelled = true; } });
    expect(result.result.error).toMatch(/^Interrupted/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("restores %s model, effort and missing transcript after temporary override", async (from) => {
    const { options } = setup(from);
    const result = await runFallbackAttempts(options);
    const revert = computeEngineOverrideRevert(result.session, Date.now() + 7 * 60 * 60_000)!;
    expect(revert).toMatchObject({ engine: from, model: "source-pin", effortLevel: "high", engineSessionId: `${from}-new` });
    updateSession(options.session.id, revert);
    insertMessage(options.session.id, "assistant", "Work performed on substitute.");
    expect(buildEngineSyncPrompt(getSession(options.session.id)!, "Continue")).toContain("Work performed on substitute.");
  });

  it("restores a tracked goal for Codex if the failed native-Claude handoff cleared it", async () => {
    const { options, run } = setup("claude");
    options.session.goal = { id: "goal", condition: "Draft verified", request: "Check draft", status: "active", updatedAt: new Date().toISOString() };
    run.mockImplementation(async () => {
      expect(getSession(options.session.id)!.goal?.condition).toBe("Draft verified");
      return { sessionId: "target", result: "Verified" };
    });
    await runFallbackAttempts(options);
  });
});

describe("engine response inactivity and cleanup", () => {
  it("distinguishes a native timeout from user cancellation", () => {
    expect(engineFallbackFailure({ sessionId: "s", result: "", error: "Interrupted: interactive turn timed out" })).toBe("timeout");
    expect(engineFallbackFailure({ sessionId: "s", result: "", error: "Interrupted: user stopped" })).toBeNull();
  });

  it("kills and waits for the timed-out process before allowing a fallback", async () => {
    vi.useFakeTimers();
    const { config } = setup();
    config.sessions!.engineNoResponseTimeoutMs = 1000;
    let finish!: (result: EngineResult) => void;
    let alive = true;
    const engine: InterruptibleEngine = { name: "codex", run: vi.fn(() => new Promise<EngineResult>((resolve) => { finish = resolve; })),
      kill: vi.fn((_id, reason) => { alive = false; finish({ sessionId: "source", result: "", error: reason }); }), isAlive: () => alive, killAll: vi.fn() };
    const pending = runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId: "s" }, config);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(engine.kill).toHaveBeenCalledExactlyOnceWith("s", "Engine response timeout");
    expect(engineFallbackFailure(result)).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a replacement while a timed-out process remains alive", async () => {
    vi.useFakeTimers();
    const { config } = setup();
    config.sessions!.engineNoResponseTimeoutMs = 1000;
    const engine: InterruptibleEngine = { name: "codex", run: vi.fn(() => new Promise<EngineResult>(() => {})), kill: vi.fn(), isAlive: () => true, killAll: vi.fn() };
    const pending = runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId: "s" }, config);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("previous engine did not stop");
    expect(engineFallbackFailure(result)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires a stalled connection even when it once reported genuine upstream activity", async () => {
    vi.useFakeTimers();
    const { config } = setup();
    config.sessions!.engineNoResponseTimeoutMs = 1000;
    let finish!: (result: EngineResult) => void;
    let lastBytesAt = Date.now();
    let alive = true;
    const engine: InterruptibleEngine = { name: "claude", run: () => new Promise<EngineResult>((resolve) => { finish = resolve; }),
      kill: vi.fn((_id, reason) => { alive = false; finish({ sessionId: "s", result: "", error: reason }); }),
      isAlive: () => alive, getLastActivityAt: () => lastBytesAt, killAll: vi.fn() };
    const pending = runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId: "s" }, config);
    await vi.advanceTimersByTimeAsync(900);
    lastBytesAt = Date.now();
    await vi.advanceTimersByTimeAsync(900);
    expect(engine.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(engineFallbackFailure(await pending)).toBe("timeout");
    expect(engine.kill).toHaveBeenCalledTimes(1);
  });

  it("resets the idle clock for stream activity and preserves real proof of ongoing work", async () => {
    vi.useFakeTimers();
    const { config } = setup();
    config.sessions!.engineNoResponseTimeoutMs = 1000;
    let opts!: EngineRunOpts;
    let finish!: (result: EngineResult) => void;
    let activity = 0;
    const engine: InterruptibleEngine = { name: "claude", run: vi.fn((value) => { opts = value; return new Promise<EngineResult>((resolve) => { finish = resolve; }); }),
      kill: vi.fn(), isAlive: () => true, getLastActivityAt: () => activity, killAll: vi.fn() };
    const pending = runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId: "s" }, config);
    await vi.advanceTimersByTimeAsync(900);
    opts.onStream!({ type: "tool_use", content: "working" });
    await vi.advanceTimersByTimeAsync(900);
    activity = Date.now();
    await vi.advanceTimersByTimeAsync(900);
    expect(engine.kill).not.toHaveBeenCalled();
    finish({ sessionId: "source", result: "Done" });
    expect((await pending).result).toBe("Done");
    expect(vi.getTimerCount()).toBe(0);
  });
});
