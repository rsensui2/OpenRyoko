import os from 'node:os';
import { resolveBinding, type WorkflowBindingContext } from './bindings.js';
import type { WorkflowCallNode } from './model.js';

/** Resident working set one engine session costs, near enough. Deliberately
 *  generous: the failure it prevents is a machine fanning out into swap, and
 *  overestimating costs a slower fan-out while underestimating costs the box. */
const SESSION_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/** The authored maximum on a Workflow Call's `concurrency` (see `model.ts`).
 *  A resolved binding answers to the same bound as a written-in number. */
const MAX_CONCURRENCY = 16;

/** What the machine looks like at the instant a fan-out asks for room. */
export interface WorkflowCapacitySnapshot {
  cpus: number;
  freeMemBytes: number;
  /** Engine sessions holding the machine that the asker is not itself running. */
  activeEngineSessions: number;
}

/** How wide a fan-out may run on this machine right now.
 *
 *  The ceiling is the smallest of three headrooms, then clamped to [1, 16]:
 *  - CPU: one core stays for the gateway itself, so `cpus - 1`.
 *  - Memory: how many session-sized working sets fit in free memory, so a
 *    starved machine narrows the fan-out instead of swapping.
 *  - Sessions: the CPU headroom minus the engine sessions already running, so a
 *    fan-out shares the machine with the operator's own work and with a sibling
 *    workflow rather than competing with it.
 *
 *  The floor of 1 is what keeps a run making progress on a loaded machine; the
 *  cap of 16 is the authored contract and this never widens it. */
export function systemConcurrencyCeiling(snapshot: WorkflowCapacitySnapshot): number {
  const cpuHeadroom = Math.max(1, Math.floor(snapshot.cpus) - 1);
  const memoryHeadroom = Math.max(1, Math.floor(snapshot.freeMemBytes / SESSION_MEMORY_BUDGET_BYTES));
  const sessionHeadroom = Math.max(1, cpuHeadroom - Math.max(0, Math.floor(snapshot.activeEngineSessions)));
  return Math.min(cpuHeadroom, memoryHeadroom, sessionHeadroom, MAX_CONCURRENCY);
}

/** The machine as one fan-out's refill sees it.
 *
 *  `activeChildren` — the node's own children still running — comes off the gateway's
 *  count here, because the refill subtracts them a second time when it takes the
 *  running children off the effective width. Charged in both places the same sessions
 *  leave the machine twice: a wave whose children have half finished then reads a
 *  ceiling no wider than the ones still running, refills none of them, and the fan-out
 *  stops holding items it never started. */
export function readCapacitySnapshot(activeEngineSessions: number, activeChildren: number): WorkflowCapacitySnapshot {
  return {
    cpus: os.availableParallelism(),
    freeMemBytes: os.freemem(),
    activeEngineSessions: Math.max(0, activeEngineSessions - activeChildren),
  };
}

/** What a fan-out asked for, what it got, and why they differ. */
export interface FanoutConcurrency {
  requested: number;
  effective: number;
  limitedBy: 'requested' | 'system-ceiling';
}

/** Resolve a Workflow Call node's authored concurrency against the machine.
 *
 *  `concurrency` is a plain number or a binding a planner node fills in, and
 *  only the `fixed` arm of that binding is bounded by the schema — a resolved
 *  node output can be anything at all, so it is checked here against the same
 *  contract a written-in number answers to. Nothing is defaulted or floored:
 *  a planner that emits a degree nobody can honour has made an error worth
 *  failing the run over, not one worth quietly rounding into 1.
 *
 *  `capacity` absent means no system ceiling — the authored number stands. */
export function resolveFanoutConcurrency(
  node: WorkflowCallNode,
  context: WorkflowBindingContext,
  capacity: WorkflowCapacitySnapshot | null,
): FanoutConcurrency {
  const authored = node.config.concurrency;
  const label = `Workflow Call ${node.id} concurrency`;
  let resolved: unknown = authored;
  if (typeof authored !== 'number') {
    try {
      resolved = resolveBinding(authored, context);
    } catch (error) {
      throw new Error(`${label} could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < 1 || resolved > MAX_CONCURRENCY) {
    throw new Error(`${label} must resolve to a whole number between 1 and ${MAX_CONCURRENCY}.`);
  }
  const effective = capacity ? Math.min(resolved, systemConcurrencyCeiling(capacity)) : resolved;
  return { requested: resolved, effective, limitedBy: effective < resolved ? 'system-ceiling' : 'requested' };
}

/** What the node run records about its own fan-out width. `concurrency` keeps
 *  its name and its meaning — what the author asked for — so an existing reader
 *  is not silently handed a different number than it was written against. */
export function fanoutConcurrencyRecord(concurrency: FanoutConcurrency): Record<string, string | number> {
  return {
    concurrency: concurrency.requested,
    concurrencyEffective: concurrency.effective,
    concurrencyLimitedBy: concurrency.limitedBy,
  };
}
