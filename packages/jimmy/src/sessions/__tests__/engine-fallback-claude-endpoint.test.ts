import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEngineWithResponseTimeout, runFallbackAttempts } from "../engine-fallback.js";
import { exhaustedRecordFor } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge, noteLoginWorked } from "../engine-login.js";
import { startOnHealthyEngine } from "../new-session-engine.js";
import { createSession } from "../registry.js";
import { configureClaudeEndpoints, resetClaudeEndpointsForTests } from "../../shared/claude-endpoints.js";
import { readEngineHealth, recordEngineUnavailable } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";

/**
 * A turn on a Claude endpoint (a non-Anthropic server) runs under the "claude"
 * engine name, but must not touch the Anthropic account's health, login or
 * allowance records — and its work stays on the endpoint unless it opts in.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const LOCAL = "local-model";
const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
let sequence = 0;

function config(): JinnConfig {
  return { engines: { default: "claude",
    claude: { bin: "claude-bin", model: "claude-model", fallback: ["codex"] },
    codex: { bin: "codex-bin", model: "codex-model" } },
    sessions: {}, connectors: {}, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
}

function endpoints(fallback = false) {
  process.env.TEST_LOCAL_KEY = "k";
  configureClaudeEndpoints([{ name: "local-mac", baseUrl: "http://100.64.0.10:1236", apiKeyEnv: "TEST_LOCAL_KEY", fallback, models: [LOCAL] }], "claude-model");
}

const answering = (name: string): Engine =>
  ({ name, run: vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: `${name}-new`, result: `Answered by ${name}.` }) });

const attempt = (engine: Engine, model: string) =>
  runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId: "s", model }, config());

beforeEach(() => {
  invalidateModelRegistry();
  resetClaudeEndpointsForTests();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => {
  resetClaudeEndpointsForTests();
  delete process.env.TEST_LOCAL_KEY;
});

describe("health records", () => {
  it("keeps Anthropic's usage limit when an endpoint turn succeeds", async () => {
    endpoints();
    recordEngineUnavailable("claude", "claude usage limit", inMinutes(45));
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "Done locally." }) }, LOCAL);
    expect(exhaustedRecordFor("claude", "claude-model")).toBeDefined();
  });

  it("does not record a limit that an endpoint reports", async () => {
    endpoints();
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "", error: "rate_limit",
      numTurns: 1, rateLimit: { status: "rejected", resetsAt: inMinutes(45), window: "5h" } }) }, LOCAL);
    expect(readEngineHealth().claude).toBeUndefined();
  });

  it("still records an Anthropic model's limit as before", async () => {
    endpoints();
    await attempt({ name: "claude", run: async () => ({ sessionId: "s", result: "", error: "rate_limit",
      numTurns: 1, rateLimit: { status: "rejected", resetsAt: inMinutes(45), window: "5h" } }) }, "claude-model");
    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted" });
  });
});

describe("engine fallback", () => {
  function failedEndpointTurn() {
    const session = createSession({ engine: "claude", model: LOCAL, source: "slack", sourceRef: `endpoint-${++sequence}` });
    const engines = new Map<string, Engine>(["claude", "codex"].map((name) => [name, answering(name)]));
    const initialOpts: EngineRunOpts = { prompt: "Summarise.", cwd: "/test", sessionId: session.id, model: LOCAL };
    const initialResult: EngineResult = { sessionId: "", result: "", error: "Engine response timeout" };
    return { engines, options: { config: config(), session, initialEngine: engines.get("claude")!, initialResult, initialOpts,
      getEngine: (name: string) => engines.get(name), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) } };
  }

  it("keeps a failed endpoint turn on the endpoint by default", async () => {
    endpoints(false);
    const { engines, options } = failedEndpointTurn();
    const outcome = await runFallbackAttempts(options);
    expect(engines.get("codex")!.run).not.toHaveBeenCalled();
    expect(outcome.attempted).toBe(false);
  });

  it("hands it to the fallback engine when the endpoint opts in", async () => {
    endpoints(true);
    const { engines, options } = failedEndpointTurn();
    await runFallbackAttempts(options);
    expect(engines.get("codex")!.run).toHaveBeenCalled();
  });
});

describe("new sessions while Anthropic is out of allowance", () => {
  it("start an endpoint model on the endpoint instead of moving them to the fallback engine", () => {
    endpoints();
    noteLoginWorked("codex"); // codex has served a turn, so it would be a valid destination
    recordEngineUnavailable("claude", "claude usage limit", inMinutes(45));
    const engines = new Map<string, Engine>(["claude", "codex"].map((name) => [name, answering(name)]));
    const session = createSession({ engine: "claude", model: LOCAL, source: "cron", sourceRef: `endpoint-start-${++sequence}` });
    const started = startOnHealthyEngine(config(), (name) => engines.get(name), session, {});
    expect(started.session.engine).toBe("claude");
    expect(started.session.model).toBe(LOCAL);
  });
});
