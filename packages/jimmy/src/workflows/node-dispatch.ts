import type { Employee, ModelRegistry } from "../shared/types.js";
import { interpolateWorkflowPrompt, resolveBinding, type WorkflowBindingContext } from "./bindings.js";
import { continuationPrompt, resolveEmployeeContinuation } from "./employee-continuation.js";
import { readEngineHealth, recordEngineUnavailable } from "../shared/engine-health.js";
import { engineAvailabilityFailure, selectSubstituteEngine, type EngineChainSource, type EngineSubstitution,
  type SubstituteDeps } from "./engine-chain.js";
import type { EmployeeNode } from "./model.js";
import type { WorkflowRepository } from "./repository.js";
import type { ResolvedEmployeeConfig, WorkflowError, WorkflowRunDetail } from "./runtime.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";
import type { WorkflowTodoDispatchOverride } from "./todo-ports.js";

/**
 * What a run's bindings see, and what an Employee node's attempt actually runs
 * on. Both are read once per attempt, immediately before dispatch, so an
 * override set while an earlier attempt was in flight lands on the next one.
 */

const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 180;

/** The narrow slice of the runner's options this resolution needs. Declared
 *  here rather than imported from `runner.ts` so the dependency runs one way. */
export interface DispatchResolutionDeps {
  employees: () => ReadonlyMap<string, Employee>;
  models: () => ModelRegistry;
  repository: WorkflowRepository;
  executor: Pick<WorkflowSessionExecutor, "resumableEngineSession">;
  todoDispatch?: WorkflowTodoDispatchOverride;
  /** The configured `engines.<name>.fallback` chains, so an attempt whose engine
   *  could not serve the turn re-dispatches on one that can. Absent = no chains,
   *  and a run that freezes on the failure exactly as it did before. */
  engineFallback?: EngineChainSource;
}

export function bindingContext(run: WorkflowRunDetail): WorkflowBindingContext {
  const itemIndex = run.trigger.payload.itemIndex;
  return {
    input: run.input,
    trigger: {
      kind: run.trigger.kind,
      payload: run.trigger.payload,
      ...(Number.isInteger(itemIndex) ? { itemIndex: itemIndex as number } : {}),
    },
    run: { id: run.id, startedAt: run.startedAt, ...(run.trigger.todoId ? { todoId: run.trigger.todoId } : {}) },
    nodes: Object.fromEntries(run.nodeRuns.map((node) => [node.nodeId, {
      status: node.status, output: node.output ?? null, error: node.error ?? null,
    }])),
  };
}

export function resolveString(
  binding: Parameters<typeof resolveBinding<string>>[0],
  context: WorkflowBindingContext,
  label: string,
): string {
  const value = resolveBinding(binding, context);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must resolve to a nonempty string.`);
  return value;
}

type Override = { engine: string | null; model: string | null } | undefined;

/** Whatever pinned this attempt away from the employee's own defaults, in the
 *  order that wins: the bound Todo first, then the node's own configuration.
 *  `undefined` on either side means nothing pinned it and the employee decides. */
function pinnedSelection(node: EmployeeNode, context: WorkflowBindingContext, override: Override): {
  engine: string | undefined;
  model: string | undefined;
} {
  if (override?.engine) return { engine: override.engine, model: override.model ?? undefined };
  return {
    engine: node.config.engine ? resolveString(node.config.engine, context, "Engine") : undefined,
    model: node.config.model ? resolveString(node.config.model, context, "Model") : undefined,
  };
}

type ModelInfo = ModelRegistry[string]["models"][number];

/** The engine this attempt runs on and the model it runs with, given whatever
 *  pinned it. A pinned engine with no model of its own takes THAT engine's
 *  default, never the employee's model, which it would not be registered for. */
function resolveTarget(
  pinned: { engine: string | undefined; model: string | undefined },
  employee: Employee,
  models: () => ModelRegistry,
): { engine: string; model: string; modelInfo: ModelInfo } {
  const engine = pinned.engine ?? employee.engine;
  const registry = models()[engine];
  if (!registry?.available) throw new Error(`Workflow engine "${engine}" is not available.`);
  const model = pinned.model ?? (pinned.engine ? registry.defaultModel : employee.model || registry.defaultModel);
  const modelInfo = registry.models.find((candidate) => candidate.id === model);
  if (!modelInfo) throw new Error(`Workflow model "${model}" is not available for engine "${engine}".`);
  return { engine, model, modelInfo };
}

/** The employee's configured effort only applies while the employee's own
 *  engine and model do: a pin can land on a model that does not know it. An
 *  effort the node asked for explicitly still has to be one the model has. */
function resolveEffort(
  node: EmployeeNode,
  context: WorkflowBindingContext,
  employee: Employee,
  pinned: boolean,
  modelInfo: ModelInfo,
): ResolvedEmployeeConfig["effort"] {
  const effort = (node.config.effort
    ? resolveString(node.config.effort, context, "Effort")
    : pinned ? undefined : employee.effortLevel) as ResolvedEmployeeConfig["effort"];
  if (effort && (!modelInfo.supportsEffort || !modelInfo.effortLevels.includes(effort))) {
    throw new Error(`Workflow effort "${effort}" is not available for model "${modelInfo.id}".`);
  }
  return effort;
}

/** The walk's dependencies with the live health reading filled in. The store is
 *  gateway-side and global, so unlike the chain source there is nothing upstream
 *  has to supply — and both callers of the walk read it the same way. */
function substituteDeps(options: DispatchResolutionDeps): SubstituteDeps {
  return { ...options, engineHealth: readEngineHealth };
}

/** What the failure that settled an attempt says about the engine that actually
 *  ran it — the stand-in on a substituted attempt, not the engine it stood in
 *  for. Recorded here rather than inside the walk because `hasSubstitute` asks
 *  that walk repeatedly at the retry boundary, and one failure is one
 *  observation. */
function recordAttemptHealth(attempt: WorkflowRunDetail["attempts"][number] | undefined): void {
  if (!attempt) return;
  const availability = engineAvailabilityFailure(attempt.error);
  if (!availability) return;
  recordEngineUnavailable(attempt.resolvedConfig.engine, availability.reason, availability.resetsAt);
}

/**
 * What this attempt actually runs on, and whether that is something other than
 * the employee's own defaults.
 *
 * PLA-149: the engine the node resolved to may be the very one that could not
 * serve this node's last attempt. When a chain covers for it, the attempt runs
 * on the stand-in instead — on THAT engine's own default model, since it is not
 * registered for the first's, and never with an effort the employee configured
 * for an engine it is no longer on.
 */
function dispatchTarget(
  run: WorkflowRunDetail,
  node: EmployeeNode,
  employee: Employee,
  pinned: { engine: string | undefined; model: string | undefined },
  options: DispatchResolutionDeps,
): { engine: string; model: string; modelInfo: ModelInfo; pinned: boolean; substitutedFrom?: EngineSubstitution } {
  const base = resolveTarget(pinned, employee, options.models);
  const failed = run.attempts.filter((attempt) => attempt.nodeId === node.id).at(-1);
  recordAttemptHealth(failed);
  const substitutedFrom = selectSubstituteEngine(run, node.id, base.engine, failed?.error, substituteDeps(options));
  const own = Boolean(pinned.engine || pinned.model);
  if (!substitutedFrom) return { ...base, pinned: own };
  const stood = resolveTarget({ engine: substitutedFrom.engine, model: undefined }, employee, options.models);
  return { ...stood, pinned: true, substitutedFrom };
}

/** What the next walk covers for: the engine this node's own precedence resolved
 *  to, which on an already-substituted attempt is the one it stood in for rather
 *  than the stand-in. */
function substitutionBase(attempt: WorkflowRunDetail["attempts"][number]): string {
  return attempt.resolvedConfig.substitutedFrom?.engine ?? attempt.resolvedConfig.engine;
}

/** Whether a chain would carry this node's next attempt past the failure that
 *  just settled — the retry boundary's half of the same question `dispatchTarget`
 *  answers, asked through the same walk so the two cannot disagree about whether
 *  a run is out of options. */
export function hasSubstitute(
  run: WorkflowRunDetail,
  attempt: WorkflowRunDetail["attempts"][number],
  failure: WorkflowError,
  options: DispatchResolutionDeps,
): boolean {
  return selectSubstituteEngine(run, attempt.nodeId, substitutionBase(attempt), failure, substituteDeps(options)) !== undefined;
}

export function resolveDispatch(
  run: WorkflowRunDetail,
  node: EmployeeNode,
  options: DispatchResolutionDeps,
): ResolvedEmployeeConfig {
  const context = bindingContext(run);
  const employeeId = resolveString(node.config.employee, context, "Employee");
  const employee = options.employees().get(employeeId);
  if (!employee) throw new Error(`Workflow employee "${employeeId}" is not available.`);
  // ICI-733: the bound Todo's override outranks the node's own engine/model. It
  // exists to move a Todo whose attempts keep failing onto a different engine,
  // and a workflow that pinned the failing one would otherwise defeat it.
  const override = run.trigger.todoId ? options.todoDispatch?.read(run.trigger.todoId) : undefined;
  const target = dispatchTarget(run, node, employee, pinnedSelection(node, context, override), options);
  const { engine, model, substitutedFrom } = target;
  const effort = resolveEffort(node, context, employee, target.pinned, target.modelInfo);
  const continuedFrom = resolveEmployeeContinuation(run, node, engine, {
    repository: options.repository,
    resumableEngineSession: (id, target) => options.executor.resumableEngineSession(id, target),
  });
  // Only the prompt going out: an unused delta must not fail a cold round over a binding it never reads.
  interpolateWorkflowPrompt(continuationPrompt(node, Boolean(continuedFrom)), context);
  return {
    employeeId, engine, model, ...(effort ? { effort } : {}), ...(continuedFrom ? { continuedFrom } : {}),
    ...(substitutedFrom ? { substitutedFrom: { engine: substitutedFrom.from, reason: substitutedFrom.reason } } : {}),
    retry: node.config.retry ?? { attempts: 1, delaySeconds: 0, backoff: "fixed" },
    timeoutMinutes: node.config.timeoutMinutes ?? DEFAULT_ATTEMPT_TIMEOUT_MINUTES,
  };
}
