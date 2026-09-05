import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../../shared/types.js";
import { engineAvailabilityFailure, engineChain, selectSubstituteEngine } from "../engine-chain.js";
import type { WorkflowRunDetail } from "../runtime.js";

/**
 * The walk that decides which engine covers for one that could not serve a turn.
 * Its rules are all about what NOT to try again: the engine that just failed,
 * anything this node already burned an attempt on, and anything the registry
 * does not have.
 */

const CHAINS: Record<string, readonly string[]> = {
  codex: ["claude", "grok"],
  claude: ["codex"],
  grok: ["pi"],
};
const chainFor = (engine: string): readonly string[] => CHAINS[engine] ?? [];

const MODELS = {
  codex: { name: "codex", available: true, defaultModel: "sol", models: [] },
  claude: { name: "claude", available: true, defaultModel: "opus", models: [] },
  grok: { name: "grok", available: true, defaultModel: "grok-4", models: [] },
  pi: { name: "pi", available: false, defaultModel: "gemma", models: [] },
} as unknown as ModelRegistry;

/** Just the slice the walk reads: the node's authored fallback and what this
 *  node has already run on. */
function run(fallback: unknown, engines: string[]): WorkflowRunDetail {
  return {
    definition: { nodes: [{ id: "work", type: "employee", name: "Work", config: { fallback } }] },
    attempts: engines.map((engine, index) => ({ nodeId: "work", attempt: index + 1, resolvedConfig: { engine } })),
  } as unknown as WorkflowRunDetail;
}

const deps = { models: () => MODELS, engineFallback: { chainFor } };

/** The engine's own account of a turn it could not serve. */
const turnFailed = (message: string) => ({ code: "workflow-step-failed", message, retryable: false });

describe("engineChain", () => {
  it("walks the config chain transitively, first preference first", () => {
    expect(engineChain("codex", undefined, chainFor)).toEqual(["claude", "grok", "pi"]);
  });

  it("terminates on a chain that names its way back", () => {
    expect(engineChain("claude", "inherit", chainFor)).toEqual(["codex", "grok", "pi"]);
  });

  it("uses an explicit chain verbatim, ignoring config", () => {
    expect(engineChain("codex", ["pi", "hermes"], chainFor)).toEqual(["pi", "hermes"]);
  });

  it("offers nothing when the node opted out", () => {
    expect(engineChain("codex", "none", chainFor)).toEqual([]);
  });
});

describe("selectSubstituteEngine", () => {
  it("names the first chain member for an availability failure", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", turnFailed("429 rate limit"), deps))
      .toEqual({ engine: "claude", from: "codex", reason: "rate-limited" });
  });

  it("skips a member this node already ran on", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex", "claude"]), "work", "codex", turnFailed("usage limit reached"), deps))
      .toEqual({ engine: "grok", from: "codex", reason: "out of quota" });
  });

  it("skips a member the registry does not have", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex", "claude", "grok"]), "work", "codex", turnFailed("usage limit reached"), deps))
      .toBeUndefined();
  });

  it("offers nothing for a failure another engine cannot get past", () => {
    for (const failure of [turnFailed("invalid api key"), turnFailed("the tests did not pass"), undefined]) {
      expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", failure, deps)).toBeUndefined();
    }
  });

  it("offers nothing for a verdict the employee submitted, whatever prose it carries", () => {
    const submitted = { code: "workflow-submitted-failure", message: "Stopping: the API is rate limited.", retryable: false };
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", submitted, deps)).toBeUndefined();
  });

  it("offers nothing when the base engine has not been attempted yet", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "claude", turnFailed("429 rate limit"), deps)).toBeUndefined();
  });

  it("offers nothing without a configured chain", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", turnFailed("429 rate limit"), { models: () => MODELS }))
      .toBeUndefined();
  });
});

describe("selectSubstituteEngine — engine health", () => {
  const quota = turnFailed("usage limit reached");
  const reading = (state: "exhausted" | "degraded" | "ok", ...engines: string[]) =>
    ({ ...deps, engineHealth: () => Object.fromEntries(engines.map((engine) => [engine, { state }])) });

  it("prefers a healthy member over one that is out of allowance", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", quota, reading("exhausted", "claude")))
      .toEqual({ engine: "grok", from: "codex", reason: "out of quota" });
  });

  it("offers an exhausted member once the healthy ones are spent", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex", "grok"]), "work", "codex", quota, reading("exhausted", "claude")))
      .toEqual({ engine: "claude", from: "codex", reason: "out of quota" });
  });

  it("still answers when every member is exhausted, so health cannot empty a chain", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", quota, reading("exhausted", "claude", "grok")))
      .toEqual({ engine: "claude", from: "codex", reason: "out of quota" });
  });

  it("takes a member back once its window has passed and it reads ok again", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", quota, reading("ok", "claude")))
      .toEqual({ engine: "claude", from: "codex", reason: "out of quota" });
  });

  it("holds back only exhausted members — a degraded one keeps its place", () => {
    expect(selectSubstituteEngine(run(undefined, ["codex"]), "work", "codex", quota, reading("degraded", "claude")))
      .toEqual({ engine: "claude", from: "codex", reason: "out of quota" });
  });
});

describe("engineAvailabilityFailure", () => {
  it("carries the reset the engine stated", () => {
    const at = new Date("2026-08-19T14:00:00.000Z");
    expect(engineAvailabilityFailure(turnFailed(`usage limit reached — resets at ${at.toISOString()}`)))
      .toEqual({ reason: "out of quota", resetsAt: at.getTime() / 1000 });
  });

  it("reads nothing off a failure that is not the engine's own account of the turn", () => {
    expect(engineAvailabilityFailure({ code: "workflow-attempt-interrupted", message: "usage limit reached", retryable: true } as never))
      .toBeUndefined();
    expect(engineAvailabilityFailure(turnFailed("the phase refused to proceed"))).toBeUndefined();
  });
});
