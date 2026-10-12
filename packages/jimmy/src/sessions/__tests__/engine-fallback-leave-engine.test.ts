import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFallbackAttempts } from "../engine-fallback.js";
import { createSession, getSession } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Engine, EngineResult, EngineRunOpts, InterruptibleEngine, JinnConfig } from "../../shared/types.js";

/**
 * A session that moves to its fallback engine must not leave a live process
 * behind on the engine it came from — that process could still answer.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
let sequence = 0;

function leaving(initialResult: EngineResult, kill: InterruptibleEngine["kill"] = vi.fn()) {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: {},
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const session = createSession({ engine: "claude", source: "slack", sourceRef: `leave-engine-${++sequence}` });
  const claude: InterruptibleEngine = { name: "claude", run: vi.fn(), kill, killAll: vi.fn(), isAlive: () => false };
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-new", result: "Answered on the substitute." });
  const engines = new Map<string, Engine>([["claude", claude], ["codex", { name: "codex", run: codexRun }]]);
  const initialOpts: EngineRunOpts = { prompt: "Summarise the thread.", cwd: "/test", sessionId: session.id };
  return { session, kill, codexRun, options: { config, session, initialEngine: claude, initialResult, initialOpts,
    getEngine: (name: string) => engines.get(name), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) } };
}

beforeEach(() => {
  invalidateModelRegistry();
  fs.rmSync(HEALTH_PATH, { force: true });
});

describe("stopping the engine a session switches away from", () => {
  it.each<[string, EngineResult]>([
    ["a usage limit", { sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1, rateLimit: { status: "rejected" } }],
    ["an empty answer", { sessionId: "claude-thread", result: "  " }],
  ])("stops it for that session after %s", async (_label, initialResult) => {
    const f = leaving(initialResult);

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome.attempted).toBe(true);
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(f.session.id, "Interrupted: engine switched");
  });

  it("does not stop a timed-out engine a second time: the timeout already did, and waited for it", async () => {
    const f = leaving({ sessionId: "claude-thread", result: "", error: "Engine response timeout" });

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome.attempted).toBe(true);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("leaves the engine alone when there is nowhere to switch to", async () => {
    const f = leaving({ sessionId: "claude-thread", result: "", error: "Usage limit reached" });
    f.options.config.engines.claude.fallback = [];

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome.attempted).toBe(false);
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("still switches when the engine it leaves cannot be stopped", async () => {
    const f = leaving({ sessionId: "claude-thread", result: "", error: "Usage limit reached" },
      vi.fn(() => { throw new Error("pty already gone"); }));

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome).toMatchObject({ attempted: true, result: { result: "Answered on the substitute." } });
    expect(getSession(f.session.id)!.engine).toBe("codex");
  });
});
