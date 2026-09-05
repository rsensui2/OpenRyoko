import { resolveBinding, type WorkflowBindingContext } from "./bindings.js";
import { readCapacitySnapshot, resolveFanoutConcurrency, type FanoutConcurrency } from "./capacity.js";
import type { JsonValue, WorkflowCallNode, WorkflowIteration, WorkflowNodeOutput } from "./model.js";
import { bindingContext, resolveString } from "./node-dispatch.js";
import { predicatesHold } from "./predicates.js";
import type { WorkflowChildRunSummary, WorkflowRunDetail } from "./runtime.js";

/**
 * What a Workflow Call node resolves to before the runner acts on it.
 *
 * The node has two shapes and they are exclusive. `items` is fan-out: a width
 * known up front, every child independent, all of them in flight at once up to
 * the concurrency ceiling. `iterate` is a loop: a depth discovered as it goes,
 * one child at a time, each round free to read what the round before it
 * returned. Both spend the same machinery — a child run per unit of work, keyed
 * by `itemIndex` — which is why they share a file and a node type.
 */

/** How many children at once, and over what. `[null]` is the single-call case:
 *  not a special path, just a fan-out of width one. */
export interface FanoutPlan {
  workflowId: string;
  concurrency: FanoutConcurrency;
  items: JsonValue[];
  hasItems: boolean;
}

type CapacityReader = (() => Parameters<typeof readCapacitySnapshot>[0]) | undefined;

export function fanoutPlan(run: WorkflowRunDetail, node: WorkflowCallNode, capacity: CapacityReader,
  activeChildren: number): FanoutPlan {
  const context = bindingContext(run);
  const workflowId = resolveString(node.config.workflowId, context, "Workflow Call target");
  const concurrency = resolveFanoutConcurrency(node, context, capacity ? readCapacitySnapshot(capacity(), activeChildren) : null);
  if (!node.config.items) return { workflowId, concurrency, items: [null], hasItems: false };
  const items = resolveBinding(node.config.items, context);
  if (!Array.isArray(items)) throw new Error(`Workflow Call ${node.id} items must resolve to an array.`);
  if (items.length > 100) throw new Error(`Workflow Call ${node.id} items may contain at most 100 entries.`);
  return { workflowId, concurrency, items, hasItems: true };
}

export function fanoutInput(run: WorkflowRunDetail, node: WorkflowCallNode, plan: FanoutPlan, index: number): Record<string, JsonValue> {
  const base = bindingContext(run);
  const context: WorkflowBindingContext = {
    ...base,
    trigger: {
      ...base.trigger,
      itemIndex: index,
      ...(plan.hasItems ? { item: plan.items[index]! } : {}),
    },
  };
  return mapCallInput(node, context);
}

function mapCallInput(node: WorkflowCallNode, context: WorkflowBindingContext): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(node.config.input ?? {})
    .map(([key, binding]) => [key, resolveBinding(binding, context)]));
}

export function callChildren(run: WorkflowRunDetail, nodeId: string): WorkflowChildRunSummary[] {
  return run.childRuns.filter((child) => child.nodeId === nodeId);
}

export function childTerminal(child: WorkflowChildRunSummary): boolean {
  return ["completed", "failed", "cancelled"].includes(child.status);
}

export function validateFanoutChildren(node: WorkflowCallNode, plan: FanoutPlan, children: WorkflowChildRunSummary[]): void {
  if (children.some((child) => child.itemIndex !== undefined && child.itemIndex >= plan.items.length)) {
    throw new Error(`Workflow Call ${node.id} has a child outside its item range.`);
  }
}

/** The node's loop settings, with the bound proved present. Validation refuses
 *  to make a definition with `iterate` executable until it carries one, so a node
 *  reaching the runner without it got here some other way and says so. */
export function iterationSettings(node: WorkflowCallNode): Required<WorkflowIteration> {
  const iterate = node.config.iterate;
  if (iterate?.maxRounds === undefined) {
    throw new Error(`Workflow Call ${node.id} iterates without a maxRounds bound. Set one on the node.`);
  }
  return { maxRounds: iterate.maxRounds, continueWhile: iterate.continueWhile };
}

/** What the node reads as, both while `continueWhile` is being asked and after
 *  the last round settles — one shape, so a predicate and a downstream binding
 *  name the same path. `last` is the round that just finished; `rounds` is the
 *  audit trail, one entry per child run in the order they ran. */
function iterationFields(children: readonly WorkflowChildRunSummary[], maxRounds: number): Record<string, JsonValue> {
  const rounds = children.map((child, index) => ({
    round: index + 1,
    runId: child.runId,
    workflowId: child.workflowId,
    status: child.status === "completed" ? "succeeded" : child.status,
    fields: child.endOutput ?? {},
  }));
  return {
    round: children.length,
    maxRounds,
    last: children.at(-1)?.endOutput ?? {},
    rounds,
  };
}

/** Ask the round that just finished whether it wants another. The node stands
 *  for its own latest output while the predicates read it — the one place a
 *  Workflow Call binds to itself, and only because the round has already run. */
function wantsAnotherRound(run: WorkflowRunDetail, node: WorkflowCallNode, settings: Required<WorkflowIteration>,
  fields: Record<string, JsonValue>): boolean {
  const base = bindingContext(run);
  const context: WorkflowBindingContext = {
    ...base,
    nodes: { ...base.nodes, [node.id]: { status: "running", output: { text: "", fields }, error: null } },
  };
  return predicatesHold(settings.continueWhile, context);
}

export type IterationStep =
  | { kind: "run"; round: number; input: Record<string, JsonValue>; workflowId: string }
  | { kind: "settle"; port: "success" | "exhausted"; output: WorkflowNodeOutput };

/** The whole loop decision, in one place: run the next round, leave through
 *  `success` because nothing asked for another, or leave through `exhausted`
 *  because the bound ran out while something still did. Exhaustion is a route,
 *  not a failure — the run carries on down whatever the author wired there.
 *
 *  A round that did not complete is neither. `continueWhile` reads the round's
 *  output, and a broken round has none, so letting it fall through would read a
 *  crashed body as a loop that finished cleanly — and asking a body that just
 *  failed for another round is worse. Both stop here, loudly. */
export function iterationStep(run: WorkflowRunDetail, node: WorkflowCallNode,
  children: readonly WorkflowChildRunSummary[]): IterationStep {
  const settings = iterationSettings(node);
  const { maxRounds } = settings;
  const broken = children.find((child) => child.status !== "completed");
  if (broken) {
    throw new Error(`Workflow Call ${node.id} round ${children.indexOf(broken) + 1} ${broken.status} `
      + `(run ${broken.runId})${broken.error ? `: ${broken.error.message}` : ""}. `
      + `A loop cannot judge a round that did not finish; fix the target Workflow or retry the round.`);
  }
  if (children.length > 0) {
    const fields = iterationFields(children, maxRounds);
    if (!wantsAnotherRound(run, node, settings, fields)) return { kind: "settle", port: "success", output: iterationOutput(fields, "success") };
    if (children.length >= maxRounds) return { kind: "settle", port: "exhausted", output: iterationOutput(fields, "exhausted") };
  }
  // One round at a time, so the fan-out concurrency ceiling has nothing to say here.
  const workflowId = resolveString(node.config.workflowId, bindingContext(run), "Workflow Call target");
  return { kind: "run", round: children.length + 1, workflowId, input: iterationInput(run, node, children.length + 1, maxRounds) };
}

function iterationOutput(fields: Record<string, JsonValue>, port: "success" | "exhausted"): WorkflowNodeOutput {
  return { text: "", fields: { ...fields, port, exhausted: port === "exhausted" } };
}

/** The round's own view of itself, mapped into the target's inputs. This is what
 *  lets the last round say something the first one did not — the difference a
 *  duplicated round-2 node exists to express today. */
function iterationInput(run: WorkflowRunDetail, node: WorkflowCallNode, round: number, maxRounds: number): Record<string, JsonValue> {
  const base = bindingContext(run);
  const context: WorkflowBindingContext = {
    ...base,
    trigger: { ...base.trigger, itemIndex: round - 1, round, maxRounds },
  };
  return mapCallInput(node, context);
}
