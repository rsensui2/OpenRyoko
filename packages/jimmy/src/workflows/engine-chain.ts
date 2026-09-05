import { z } from "zod";
import { classifyEngineFailureText } from "../shared/engine-failure.js";
// Type-only, and it has to stay that way: the health store resolves the instance
// home on import, and this module is reached from every read of a definition.
import type { EngineHealthReading } from "../shared/engine-health.js";
import type { ModelRegistry } from "../shared/types.js";
import { availabilityReason } from "./failure.js";
import type { WorkflowDefinition } from "./model.js";
import type { WorkflowError, WorkflowRunDetail } from "./runtime.js";

/**
 * Which engine covers for one that could not serve a turn.
 *
 * An engine that ran out of allowance or could not be reached said nothing about
 * the work — so unlike a retry, which pays a second time for the same request on
 * the same provider, a substitution asks a DIFFERENT provider the first question.
 * That is only honest while the alternatives are ones this node has not already
 * spent an attempt on, which is why the walk reads the run's attempt history
 * rather than just the configuration.
 */

/**
 * The one failure path that is the ENGINE's account of a turn it could not
 * serve. A submitted failure is the employee's verdict and an interrupted or
 * undelivered attempt belongs to the runtime — none of them says the provider
 * was out of allowance, whatever prose they happen to carry, and reading their
 * text would let an employee's own summary redirect the run.
 */
const SUBSTITUTABLE_FAILURE_CODE = 'workflow-step-failed';

/** `inherit` (the default) takes the engine's configured chain, `none` opts the
 *  node out entirely, and a list is that node's own chain, used verbatim.
 *
 *  Members are plain strings rather than the engine enum on purpose: this module
 *  is reached from `model.ts`, which the repository parses definitions with, and
 *  the engine list lives in a module that resolves the instance home on import.
 *  Pulling that in decides `JINN_HOME` for anything that reads a definition. A
 *  name no engine answers to is inert anyway — the walk only offers members the
 *  model registry actually has. */
export const nodeFallbackSchema = z.union([
  z.literal('inherit'), z.literal('none'), z.array(z.string().min(1)).min(1),
]);
export type NodeFallback = z.infer<typeof nodeFallbackSchema>;

/** The configured `engines.<name>.fallback` chains, read fresh so a hot config
 *  reload lands on the next attempt. */
export interface EngineChainSource {
  chainFor(engine: string): readonly string[];
}

export interface EngineSubstitution {
  /** The engine this attempt runs on instead. */
  engine: string;
  /** The engine the node's own precedence resolved to, and which could not serve. */
  from: string;
  reason: string;
}

export interface SubstituteDeps {
  models: () => ModelRegistry;
  engineFallback?: EngineChainSource;
  /** Which engines are out of allowance right now, read fresh like `models` so a
   *  record written mid-run lands on the next attempt. Absent = nothing is known
   *  and every installed member is equally preferred. */
  engineHealth?: () => EngineHealthReading;
}

/**
 * What a failure says about the ENGINE, or `undefined` when it says nothing —
 * because it is not the engine's own account of the turn, or because it names
 * something no other provider gets past.
 *
 * Exported because the substitution walk and the health record read the same
 * signal, and a run that swapped engines while the record still called the old
 * one healthy would be two answers to one question.
 */
export function engineAvailabilityFailure(
  failure: WorkflowError | undefined,
): { reason: string; resetsAt?: number } | undefined {
  if (failure?.code !== SUBSTITUTABLE_FAILURE_CODE) return undefined;
  const reason = availabilityReason(failure.message);
  if (reason === undefined) return undefined;
  const { resetsAt } = classifyEngineFailureText(failure.message);
  return { reason, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/**
 * Every engine that could stand in for `baseEngine`, in the order to try them.
 *
 * An inherited chain is walked transitively — an engine's own cover has cover of
 * its own — with a visited set, because config.yaml deliberately allows two
 * engines to name each other. Breadth first, so first preferences are exhausted
 * before their seconds. An explicit chain is the node's whole answer and is not
 * walked further.
 */
export function engineChain(
  baseEngine: string,
  fallback: NodeFallback | undefined,
  chainFor: (engine: string) => readonly string[],
): string[] {
  if (fallback === 'none') return [];
  if (Array.isArray(fallback)) return [...fallback];
  const ordered: string[] = [];
  const seen = new Set([baseEngine]);
  const queue = [baseEngine];
  while (queue.length > 0) {
    for (const next of chainFor(queue.shift()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      ordered.push(next);
      queue.push(next);
    }
  }
  return ordered;
}

function employeeFallback(definition: WorkflowDefinition, nodeId: string): NodeFallback | undefined {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === 'employee' ? node.config.fallback : undefined;
}

/**
 * The substitution the node's next attempt should make, or `undefined` when it
 * should not make one — because the failure is one no other engine gets past,
 * because the node opted out, or because every alternative is already spent.
 * Both the retry boundary and the dispatcher ask through here, so they cannot
 * reach different answers about whether a run is out of options.
 */
export function selectSubstituteEngine(
  run: WorkflowRunDetail,
  nodeId: string,
  baseEngine: string,
  failure: WorkflowError | undefined,
  deps: SubstituteDeps,
): EngineSubstitution | undefined {
  const availability = engineAvailabilityFailure(failure);
  if (availability === undefined) return undefined;
  const attempted = new Set(run.attempts.filter((attempt) => attempt.nodeId === nodeId)
    .map((attempt) => attempt.resolvedConfig.engine));
  // Nothing to cover for until the resolved engine is the one that just failed:
  // a Todo override naming an engine this node has not tried is itself the answer.
  if (!attempted.has(baseEngine)) return undefined;
  const chain = engineChain(baseEngine, employeeFallback(run.definition, nodeId),
    (engine) => deps.engineFallback?.chainFor(engine) ?? []);
  const engine = preferredCandidates(chain, attempted, deps.models(), deps.engineHealth?.() ?? {})[0];
  return engine === undefined ? undefined : { engine, from: baseEngine, reason: availability.reason };
}

/**
 * The members this node could still be dispatched to, healthy ones first.
 *
 * A member that is out of allowance is held back rather than dropped: health
 * orders this walk and never shortens it, because a reading nothing verified
 * must not be able to freeze a run that had somewhere to go. `degraded` is not
 * read at all — an engine that named no reopening is not out of anything.
 */
function preferredCandidates(
  chain: readonly string[],
  attempted: ReadonlySet<string>,
  registry: ModelRegistry,
  health: EngineHealthReading,
): string[] {
  const healthy: string[] = [];
  const exhausted: string[] = [];
  for (const candidate of chain) {
    if (attempted.has(candidate) || !registry[candidate]?.available) continue;
    (health[candidate]?.state === "exhausted" ? exhausted : healthy).push(candidate);
  }
  return [...healthy, ...exhausted];
}
