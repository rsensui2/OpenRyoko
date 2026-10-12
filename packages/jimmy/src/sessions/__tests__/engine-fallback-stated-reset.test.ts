import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeEngineOverrideRevert, runFallbackAttempts } from "../engine-fallback.js";
import { createSession, getSession } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";

/**
 * The interactive Claude engine used to report a usage limit without saying
 * when it clears, so the temporary switch to the other engine was always held
 * for a flat six hours — even when the 5h window reopened half an hour later.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
let sequence = 0;

function limitedClaudeTurn(rateLimit: EngineResult["rateLimit"]) {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: {},
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const session = createSession({ engine: "claude", source: "slack", sourceRef: `stated-reset-${++sequence}` });
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-new", result: "Answered on the substitute." });
  const engines = new Map<string, Engine>([["claude", { name: "claude", run: vi.fn() }], ["codex", { name: "codex", run: codexRun }]]);
  const initialOpts: EngineRunOpts = { prompt: "Summarise the thread.", cwd: "/test", sessionId: session.id };
  return { session, codexRun, options: { config, session, initialEngine: engines.get("claude")!, initialOpts,
    initialResult: { sessionId: "claude-limited", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1, rateLimit } satisfies EngineResult,
    getEngine: (name: string) => engines.get(name), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) } };
}

const overrideUntil = (sessionId: string) =>
  Date.parse(String((getSession(sessionId)!.transportMeta as { engineOverride: { until: string } }).engineOverride.until));

beforeEach(() => {
  invalidateModelRegistry();
  fs.rmSync(HEALTH_PATH, { force: true });
});

describe("how long a usage-limit switch is held", () => {
  it("ends when the window the engine named reopens, not six hours later", async () => {
    const reopensAt = Math.floor(Date.now() / 1000) + 30 * 60;
    const { session, options, codexRun } = limitedClaudeTurn({ status: "rejected", rateLimitType: "interactive_detected", resetsAt: reopensAt, window: "5h" });

    await runFallbackAttempts(options);

    expect(codexRun).toHaveBeenCalledTimes(1);
    expect(overrideUntil(session.id)).toBe(reopensAt * 1000 + 1000);
    const switched = getSession(session.id)!;
    expect(computeEngineOverrideRevert(switched, reopensAt * 1000 - 1)).toBeNull();
    expect(computeEngineOverrideRevert(switched, reopensAt * 1000 + 1000)).toMatchObject({ engine: "claude" });
  });

  it("keeps the six-hour default when the engine could not name a reset", async () => {
    const before = Date.now();
    const { session, options } = limitedClaudeTurn({ status: "rejected", rateLimitType: "interactive_detected" });

    await runFallbackAttempts(options);

    const held = overrideUntil(session.id) - before;
    expect(held).toBeGreaterThanOrEqual(6 * 60 * 60_000);
    expect(held).toBeLessThan(6 * 60 * 60_000 + 5_000);
  });

  // A weekly window can name a reset six days out. Believing that for six days
  // pinned the conversation to the fallback engine long after the account was
  // usable again, so it is believed for twelve hours and then tried for real.
  it("is held for twelve hours at most, however far away the named reset is", async () => {
    const before = Date.now();
    const sixDays = Math.floor(before / 1000) + 6 * 24 * 60 * 60;
    const { session, options } = limitedClaudeTurn({ status: "rejected", rateLimitType: "interactive_detected", resetsAt: sixDays, window: "7d" });

    await runFallbackAttempts(options);

    const held = overrideUntil(session.id) - before;
    expect(held).toBeGreaterThanOrEqual(12 * 60 * 60_000);
    expect(held).toBeLessThan(12 * 60 * 60_000 + 5_000);
  });
});
