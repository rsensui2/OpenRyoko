import { logger } from "../shared/logger.js";
import type { Employee, ModelRegistry, WorkflowAttemptCompletion } from "../shared/types.js";
import { TODO_ID_PATTERN } from "../work-items/id.js";
import { approvalDescription } from "./approval-description.js";
import { interpolateWorkflowPrompt, resolveBinding } from "./bindings.js";
import { buildNodeContract } from "./contract.js";
import { continuationPrompt } from "./employee-continuation.js";
import { bindingContext, hasSubstitute, resolveDispatch, resolveString, type DispatchResolutionDeps } from "./node-dispatch.js";
import { canNeverActivate, edgeActivated, incoming, mergeReady, nodeRun, terminalNode, upstreamSessions } from "./run-graph.js";
import { commentReplyOutput, waitDueOutput } from "./wait-comment-output.js";
import type {
  ConditionNode,
  EmployeeNode,
  EndNode,
  JsonValue,
  ApprovalNode,
  WaitNode,
  WorkflowCallNode,
  WorkflowNode,
  WorkflowNodeOutput,
} from "./model.js";
import { dispatchFailure, interruptedAttemptFailure, RESTART_INTERRUPTED, workflowError } from "./failure.js";
import { openRestartReplacement, restartExhaustedFailure, restartsOn } from "./restart-redispatch.js";
import { fanoutOutput, parseWorkflowOutput, validateSubmittedFields, WorkflowOutputError } from "./output.js";
import { fanoutConcurrencyRecord } from "./capacity.js";
import { mutexHolder, recordMutexWaits, wakeMutexWaiters } from "./node-mutex.js";
import { predicatesHold } from "./predicates.js";
import { completeBoundTodo, landingShortfall, reachedSuccessEnd, type WorkflowLandingVerifier } from "./run-closure.js";
import { callChildren, childTerminal, fanoutInput, fanoutPlan, iterationSettings, iterationStep, validateFanoutChildren,
  type FanoutPlan, type IterationStep } from "./workflow-call.js";
import { addMinutes, hasWorkflowOutputBlock, remindDueAttempts, REMINDER_RUNGS_MINUTES } from "./reminder-ladder.js";
import { planStopNudge, STOP_NUDGE_TEXT } from "../sessions/stop-nudge.js";
import { WorkflowRepositoryError, type WorkflowRepository } from "./repository.js";
import type {
  ResolvedEmployeeConfig,
  WorkflowFanoutChildSummary,
  WorkflowError,
  WorkflowNodeRunRecord,
  WorkflowRunDetail,
} from "./runtime.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";
import { resolveRearmTarget } from "./rearm-target.js";
import { todoApprovalRef } from "./todo-approval-ref.js";
import { openTodoRun, settleTodoRun } from "./todo-run-ledger.js";
import type { WorkflowRearmTarget, WorkflowRunReflection, WorkflowTodoApprovalMirror, WorkflowTodoDispatchOverride,
  WorkflowTodoLifecycle, WorkflowTodoSessionLink } from "./todo-ports.js";
import { topologicalOrder, validateExecutableWorkflow } from "./validation.js";

export interface WorkflowRunnerOptions extends Pick<DispatchResolutionDeps, "engineFallback"> {
  repository: WorkflowRepository;
  executor: WorkflowSessionExecutor;
  employees: () => ReadonlyMap<string, Employee>;
  models: () => ModelRegistry;
  now?: () => string;
  onChange?: (change: { workflowId: string; runId: string }) => void;
  callWorkflow: (input: {
    workflowId: string;
    caller: { workflowId: string; runId: string; nodeId: string };
    input: Record<string, JsonValue>;
    idempotencyKey: string;
    itemIndex: number;
    todoId?: string;
  }) => Promise<WorkflowRunDetail>;
  /** Mirrors an Approval node's gate onto the run's bound Todo so the operator
   *  decides it from Todos, not from Workflows. Absent = no Todo surface (the
   *  gate still parks the run and is decidable through the workflow API). */
  todoApprovals?: WorkflowTodoApprovalMirror;
  /** Links each phase session to the run's bound Todo so the run's spend rolls
   *  up on that Todo. Absent = no attribution (the run still executes). */
  todoSessions?: WorkflowTodoSessionLink;
  /** Reflects the run's own lifecycle onto its bound Todo, so no workflow author
   *  has to write `update_work_item` into a phase prompt for the board to be
   *  honest. Absent = no reflection (the run still executes). */
  todoLifecycle?: WorkflowTodoLifecycle;
  /** Lets the run's bound Todo redirect the next attempt to another engine or
   *  model. Absent = the node's own configuration decides. */
  todoDispatch?: WorkflowTodoDispatchOverride;
  /** Proves that a commit a success End demanded really reached `main`, in the
   *  checkout the run itself named. Absent = git in that checkout, which is the
   *  answer everywhere but a test. */
  landingEvidence?: WorkflowLandingVerifier;
  /** Engine sessions across the whole gateway that already hold the machine,
   *  read fresh whenever a fan-out asks for room. Absent = no system ceiling:
   *  the authored concurrency stands, bounded only by its schema maximum. */
  activeEngineSessions?: () => number;
}

/** The Todo-facing ports live in todo-ports.ts; re-exported so the runner stays
 *  the one import every implementer and caller already had. */
export type { WorkflowRearmTarget, WorkflowRevisionRequest, WorkflowRunReflection, WorkflowTodoApprovalMirror,
  WorkflowTodoDispatchOverride, WorkflowTodoLifecycle, WorkflowTodoSessionLink } from "./todo-ports.js";

type NodeAction =
  | { kind: "activate" | "skip" | "condition" | "merge" | "approval" | "wait" | "end"; node: WorkflowNode }
  | { kind: "fanout" | "iterate"; node: WorkflowCallNode }
  | { kind: "dispatch"; node: EmployeeNode; config: ResolvedEmployeeConfig };

function composeEmployeePrompt(run: WorkflowRunDetail, node: EmployeeNode, continued: boolean): string {
  const prompt = interpolateWorkflowPrompt(continuationPrompt(node, continued), bindingContext(run));
  return `${prompt}\n\n---\n${buildNodeContract(node, upstreamSessions(run, node.id))}`;
}
function conditionPort(run: WorkflowRunDetail, node: ConditionNode): string {
  const context = bindingContext(run);
  return node.config.cases.find((item) => predicatesHold(item.all, context))?.port
    ?? node.config.defaultPort;
}
function inputFor(run: WorkflowRunDetail, nodeId: string): JsonValue {
  const outputs = incoming(run, nodeId).filter((edge) => edgeActivated(run, edge))
    .map((edge) => nodeRun(run, edge.from.nodeId).output).filter((output): output is WorkflowNodeOutput => output !== undefined);
  return outputs.length === 1 ? outputs[0] as unknown as JsonValue : run.input;
}
function mergeOutput(run: WorkflowRunDetail, nodeId: string): WorkflowNodeOutput {
  const values = incoming(run, nodeId).filter((edge) => edgeActivated(run, edge)).map((edge) => {
    const output = nodeRun(run, edge.from.nodeId).output;
    return [edge.from.nodeId, output ?? { text: "", fields: {} }] as const;
  });
  return { text: "", fields: { byNode: Object.fromEntries(values) as unknown as JsonValue } };
}
function approvalRef(run: WorkflowRunDetail, node: ApprovalNode): string | undefined {
  return node.config.approver ? resolveString(node.config.approver, bindingContext(run), "Workflow approver") : undefined;
}
/** What a Wait node writes when it parks. `resumeAt` is the instant it stops
 *  waiting unprompted: the scheduled resume for `duration` and `until`, and the
 *  timeout ceiling for `todo-comment`, which an operator reply pre-empts. */
function waitPark(run: WorkflowRunDetail, node: WaitNode, now: string):
{ resumeAt: string; resolvedConfig?: Record<string, JsonValue> } {
  if (node.config.mode === "duration") {
    return { resumeAt: new Date(Date.parse(now) + node.config.minutes * 60_000).toISOString() };
  }
  if (node.config.mode === "todo-comment") {
    const { todoId } = run.trigger;
    if (!todoId) {
      throw new Error(`Workflow Wait ${node.id} waits for the operator's comment on this run's Todo, `
        + "but the run is not bound to one. Start it from a Todo — a todo-status Trigger, or a manual "
        + "or Workflow Call start that carries a todoId.");
    }
    const { timeoutMinutes } = node.config;
    return { resumeAt: new Date(Date.parse(now) + timeoutMinutes * 60_000).toISOString(),
      resolvedConfig: { mode: "todo-comment", todoId, timeoutMinutes } };
  }
  const value = resolveBinding(node.config.timestamp, bindingContext(run));
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Workflow Wait timestamp must resolve to a canonical instant.");
  }
  return { resumeAt: value };
}
function endOutput(run: WorkflowRunDetail, node: EndNode): WorkflowNodeOutput {
  let fields: Record<string, JsonValue> = {};
  if (node.config.output) {
    const value = resolveBinding(node.config.output, bindingContext(run));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Workflow End ${node.id} output must resolve to a JSON object.`);
    }
    fields = value as Record<string, JsonValue>;
  }
  return { text: node.config.message ?? "", fields };
}
export class WorkflowRunner {
  private readonly advances = new Map<string, Promise<WorkflowRunDetail>>();

  constructor(private readonly options: WorkflowRunnerOptions) {}
  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private detail(workflowId: string, runId: string): WorkflowRunDetail {
    const run = this.options.repository.getRun(workflowId, runId);
    if (!run) throw new Error(`Workflow run ${runId} was not found.`);
    return run;
  }
  private changed(run: Pick<WorkflowRunDetail, "workflowId" | "id">): void {
    this.options.onChange?.({ workflowId: run.workflowId, runId: run.id });
  }
  private failRun(run: WorkflowRunDetail, error: unknown, nodeId = run.trigger.nodeId): WorkflowRunDetail {
    const endedAt = this.now();
    const failure = workflowError(error, nodeId);
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setRunStatus("failed", { endedAt, error: failure });
      const runtime = nodeRun(run, nodeId);
      if (!terminalNode(runtime)) tx.setNodeStatus(nodeId, "failed", { activated: true, error: failure, startedAt: endedAt, endedAt });
    });
    this.reflectFailure(run, nodeId, failure);
    this.changed(run);
    return this.detail(run.workflowId, run.id);
  }

  async start(runId: string): Promise<WorkflowRunDetail> {
    const record = this.options.repository.listRecoverableRuns().find((candidate) => candidate.id === runId);
    if (!record) throw new Error(`Workflow run ${runId} was not found.`);
    const run = this.detail(record.workflowId, record.id);
    if (run.status !== "pending") return run;
    const validation = validateExecutableWorkflow(run.definition);
    if (!run.definition.enabled || !validation.ok) return this.failRun(run, new Error("Workflow is not enabled and executable."));
    const trigger = run.definition.nodes.find((node) => node.id === run.trigger.nodeId)!;
    const endedAt = this.now();
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setRunStatus("running");
      tx.setNodeStatus(trigger.id, "completed", { activated: true, startedAt: run.startedAt, endedAt });
    });
    this.changed(run);
    return this.advance(run.workflowId, run.id);
  }

  private nextAction(run: WorkflowRunDetail): NodeAction | null {
    for (const id of topologicalOrder(run.definition)) {
      const node = run.definition.nodes.find((candidate) => candidate.id === id)!;
      const runtime = nodeRun(run, id);
      if (node.type === "trigger"
        || (node.type === "workflow-call" ? !["pending", "running"].includes(runtime.status) : runtime.status !== "pending")) continue;
      if (!runtime.activated && incoming(run, id).some((edge) => edgeActivated(run, edge))) return { kind: "activate", node };
      if (!runtime.activated && canNeverActivate(run, id)) return { kind: "skip", node };
      if (!runtime.activated) continue;
      if (node.type === "employee") {
        if (mutexHolder(this.options.repository, run, node)) continue;
        try { return { kind: "dispatch", node, config: resolveDispatch(run, node, this.options) }; }
        catch (error) { this.failRun(run, error, node.id); return null; }
      }
      if (node.type === "workflow-call") {
        try {
          const children = callChildren(run, node.id);
          const active = children.filter((child) => !childTerminal(child)).length;
          if (node.config.iterate) {
            // One round at a time, so there is nothing to decide until the round
            // in flight has settled.
            if (runtime.status === "pending" || active === 0) return { kind: "iterate", node };
            continue;
          }
          const plan = fanoutPlan(run, node, this.options.activeEngineSessions, active);
          validateFanoutChildren(node, plan, children);
          if (runtime.status === "pending" || (children.length === plan.items.length && active === 0)
            || (children.length < plan.items.length && active < plan.concurrency.effective)) {
            return { kind: "fanout", node };
          }
        } catch (error) {
          this.failRun(run, error, node.id);
          return null;
        }
        continue;
      }
      if (node.type === "condition") return { kind: "condition", node };
      if (node.type === "merge" && mergeReady(run, node.id)) return { kind: "merge", node };
      if (node.type === "approval") return { kind: "approval", node };
      if (node.type === "wait") return { kind: "wait", node };
      if (node.type === "end") return { kind: "end", node };
    }
    return null;
  }

  private applyInline(run: WorkflowRunDetail, action: Exclude<NodeAction, { kind: "dispatch" | "fanout" }>): void {
    const at = this.now();
    let approver: string | undefined;
    let park: { resumeAt: string; resolvedConfig?: Record<string, JsonValue> } | undefined;
    let output: WorkflowNodeOutput | undefined;
    if (action.kind === "approval") approver = approvalRef(run, action.node as ApprovalNode);
    if (action.kind === "wait") {
      try { park = waitPark(run, action.node as WaitNode, at); }
      catch (error) { this.failRun(run, error, action.node.id); return; }
    }
    if (action.kind === "end" && action.node.type === "end") {
      try { output = endOutput(run, action.node); }
      catch (error) { this.failRun(run, error, action.node.id); return; }
    }
    const failureEnd: WorkflowError | undefined = action.kind === "end" && action.node.type === "end"
      && action.node.config.result === "failure"
      ? { code: "workflow-failure-end", message: `Workflow reached failure End ${action.node.id}.`,
          retryable: false, nodeId: action.node.id }
      : undefined;
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      if (action.kind === "activate") tx.setNodeStatus(action.node.id, "pending", { activated: true, input: inputFor(run, action.node.id) });
      else if (action.kind === "skip") tx.setNodeStatus(action.node.id, "skipped", { endedAt: at });
      else if (action.kind === "condition") {
        const port = conditionPort(run, action.node as ConditionNode);
        tx.setNodeStatus(action.node.id, "completed", { output: { text: "", fields: { port } }, startedAt: at, endedAt: at });
      } else if (action.kind === "merge") {
        tx.setNodeStatus(action.node.id, "completed", { output: mergeOutput(run, action.node.id), startedAt: at, endedAt: at });
      } else if (action.kind === "approval") {
        tx.putApproval({ nodeId: action.node.id, status: "pending", requestedAt: at, ...(approver ? { approverRef: approver } : {}) });
        tx.setNodeStatus(action.node.id, "waiting", { startedAt: at });
        tx.setRunStatus("waiting");
        this.mirrorApproval(run, action.node as ApprovalNode, approver);
      } else if (action.kind === "wait") {
        tx.setNodeStatus(action.node.id, "waiting", { resumeAt: park!.resumeAt, startedAt: at,
          ...(park!.resolvedConfig ? { resolvedConfig: park!.resolvedConfig } : {}) });
        tx.setRunStatus("waiting");
      } else {
        tx.setNodeStatus(action.node.id, "completed", { output, startedAt: at, endedAt: at });
        if (failureEnd) tx.setRunStatus("failed", { endedAt: at, error: failureEnd });
      }
    });
    if (action.kind === "approval") this.reflect(run, "in_review", action.node.id);
    if (failureEnd) this.reflectFailure(run, action.node.id, failureEnd);
    this.changed(run);
  }

  /** Keep the node's account of its own fan-out width true: the ceiling is read again on every
   *  reconcile, so a record frozen at the first wave would claim a width the run stopped using. */
  private recordFanoutWidth(run: WorkflowRunDetail, node: WorkflowCallNode, runtime: WorkflowNodeRunRecord, plan: FanoutPlan): void {
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setNodeStatus(node.id, runtime.status, { resolvedConfig: { ...runtime.resolvedConfig, ...fanoutConcurrencyRecord(plan.concurrency) } });
    });
  }

  /** One round of a bounded loop. The node stays `running` across rounds — the
   *  service refuses a child whose caller node is not live — and settles only
   *  when `continueWhile` stops asking or the bound runs out. Exhaustion routes
   *  through the `exhausted` port rather than failing the run, so what happens
   *  after N is whatever the author wired there. */
  private async reconcileIteration(run: WorkflowRunDetail, node: WorkflowCallNode): Promise<void> {
    const children = callChildren(run, node.id);
    if (children.some((child) => !childTerminal(child))) return;
    const at = this.now();
    let step: IterationStep;
    try {
      step = iterationStep(run, node, children);
    } catch (error) { this.failRun(run, error, node.id); return; }
    if (step.kind === "settle") {
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setNodeStatus(node.id, "completed", { output: step.output, endedAt: at });
      });
      this.changed(run);
      return;
    }
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setNodeStatus(node.id, "running", {
        resolvedConfig: { workflowId: step.workflowId, round: step.round, maxRounds: iterationSettings(node).maxRounds },
        ...(nodeRun(run, node.id).startedAt ? {} : { startedAt: at }),
      });
    });
    try {
      await this.options.callWorkflow({
        workflowId: step.workflowId,
        caller: { workflowId: run.workflowId, runId: run.id, nodeId: node.id },
        input: step.input,
        idempotencyKey: `${run.id}:${node.id}:${step.round}`,
        itemIndex: step.round - 1,
      });
    } catch (error) {
      const current = this.detail(run.workflowId, run.id);
      if (!current.cancelRequestedAt && !["completed", "failed", "cancelled"].includes(current.status)) {
        this.failRun(current, error, node.id);
      }
      return;
    }
    this.changed(run);
  }

  private async reconcileFanout(run: WorkflowRunDetail, node: WorkflowCallNode): Promise<void> {
    const children = callChildren(run, node.id)
      .filter((child): child is WorkflowFanoutChildSummary => child.itemIndex !== undefined);
    const active = children.filter((child) => !childTerminal(child)).length;
    const plan = fanoutPlan(run, node, this.options.activeEngineSessions, active);
    const runtime = nodeRun(run, node.id);
    if (runtime.status === "pending") {
      const at = this.now();
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setNodeStatus(node.id, "running", {
          resolvedConfig: { workflowId: plan.workflowId, total: plan.items.length, ...fanoutConcurrencyRecord(plan.concurrency) },
          startedAt: at,
        });
      });
      this.changed(run);
      return;
    }

    validateFanoutChildren(node, plan, children);
    if (children.length === plan.items.length && children.every(childTerminal)) {
      const at = this.now();
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setNodeStatus(node.id, "completed", { output: fanoutOutput(children), endedAt: at });
      });
      this.changed(run);
      return;
    }

    this.recordFanoutWidth(run, node, runtime, plan);
    const started = new Set(children.map((child) => child.itemIndex));
    const indexes = plan.items.map((_, index) => index).filter((index) => !started.has(index));
    const capacity = Math.max(0, plan.concurrency.effective - active);
    try {
      for (const index of indexes.slice(0, capacity)) {
        const input = fanoutInput(run, node, plan, index);
        let todoId: string | undefined;
        if (node.config.input && Object.hasOwn(node.config.input, "todoId")) {
          const mappedTodoId = input.todoId;
          if (typeof mappedTodoId !== "string" || !TODO_ID_PATTERN.test(mappedTodoId)) {
            throw new Error(`Workflow Call ${node.id} todoId must resolve to a Todo id matching AAA-123.`);
          }
          todoId = mappedTodoId;
        }
        await this.options.callWorkflow({
          workflowId: plan.workflowId,
          caller: { workflowId: run.workflowId, runId: run.id, nodeId: node.id },
          input,
          idempotencyKey: `${run.id}:${node.id}:${index}`,
          itemIndex: index,
          ...(todoId === undefined ? {} : { todoId }),
        });
      }
    } catch (error) {
      const current = this.detail(run.workflowId, run.id);
      if (!current.cancelRequestedAt && !["completed", "failed", "cancelled"].includes(current.status)) {
        this.failRun(current, error, node.id);
      }
      return;
    }
    if (capacity > 0 && indexes.length > 0) this.changed(run);
  }

  /** Mirror a parked gate onto the run's bound Todo (Gap 2: the operator picks
   *  and approves from Todos), then wake its routed employee when it has one.
   *  Best-effort — neither a mirror nor a notification failure may fail a run
   *  whose gate is already parked and decidable through the workflow API.
   *  Reached only from the transition INTO parked, so an employee notification
   *  fires once per gate rather than on every recovery sweep. */
  private mirrorApproval(run: WorkflowRunDetail, node: ApprovalNode, approver: string | undefined): void {
    const todoId = run.trigger.todoId;
    if (!todoId || !this.options.todoApprovals) return;
    const ref = todoApprovalRef(run, node.id);
    const request = approvalDescription(run, node);
    try {
      this.options.todoApprovals.request({ todoId, request, ref,
        ...(node.config.options ? { options: node.config.options } : {}),
        ...(approver ? { approver } : {}) });
    } catch { /* the workflow-side gate stands on its own */ }
    try {
      this.options.todoApprovals.notifyParked({ todoId, workflowId: run.workflowId, runId: run.id,
        nodeId: node.id, request, ref });
    } catch (error) {
      logger.warn(`Workflow run ${run.id} could not notify the approver of parked gate ${node.id}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Reflect the run's own lifecycle onto its bound Todo. The platform owes the
   *  board this: until now the ONLY reason a bound Todo moved was an author
   *  hand-writing `update_work_item` into a phase prompt, so one forgotten
   *  instruction left a merged Todo reading `assigned`. Best-effort — the Todo
   *  may have been closed or deleted since the run started. */
  private reflect(run: WorkflowRunDetail, status: WorkflowRunReflection, nodeId: string): void {
    const todoId = run.trigger.todoId;
    if (!todoId || !this.options.todoLifecycle) return;
    try {
      this.options.todoLifecycle.reflect({ todoId, status, workflowId: run.workflowId, runId: run.id, nodeId });
    } catch (error) {
      logger.warn(`Workflow run ${run.id} could not reflect ${status} onto Todo ${todoId}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A run that settles failed leaves an honest trace: `blocked`, plus which
   *  node died and why. Both halves so an author needs neither a status
   *  instruction in a prompt nor a record-failure node in the graph. */
  private reflectFailure(run: WorkflowRunDetail, nodeId: string, error: WorkflowError): void {
    this.reflect(run, "blocked", nodeId);
    const todoId = run.trigger.todoId;
    if (!todoId || !this.options.todoLifecycle) return;
    try {
      this.options.todoLifecycle.recordFailure({ todoId, workflowId: run.workflowId, runId: run.id, nodeId, error });
    } catch (recordError) {
      logger.warn(`Workflow run ${run.id} could not record its failure onto Todo ${todoId}: `
        + `${recordError instanceof Error ? recordError.message : String(recordError)}`);
    }
  }

  /** Hand a rejection's feedback to the bound Todo so the work goes round again.
   *  Best-effort like every other Todo-side write from a run: the run has already
   *  stopped, and a Todo closed or deleted mid-run must not throw from here. */
  private requestRevision(run: WorkflowRunDetail, nodeId: string, feedback: string, decidedBy: string): void {
    const todoId = run.trigger.todoId;
    if (!todoId || !this.options.todoLifecycle) return;
    try {
      this.options.todoLifecycle.requestRevision({ todoId, workflowId: run.workflowId, runId: run.id,
        nodeId, feedback, decidedBy, rearm: this.rearmTarget(run.workflowId) });
    } catch (error) {
      logger.warn(`Workflow run ${run.id} could not send Todo ${todoId} round again: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private rearmTarget(workflowId: string): WorkflowRearmTarget {
    return resolveRearmTarget(this.options.repository.getDefinition(workflowId), workflowId);
  }

  /** Attribute a phase session to the run's bound Todo, so the Todo's derived
   *  spend covers what the pipeline cost — it sums `total_cost` over its linked
   *  sessions, and until now a run's phases were linked to nothing. Best-effort:
   *  the attempt is already dispatched and the Todo may have been deleted since
   *  the run started, so a failure is logged rather than failing the run. */
  private attributeSession(run: WorkflowRunDetail, sessionId: string): void {
    const todoId = run.trigger.todoId;
    if (!todoId || !this.options.todoSessions) return;
    try {
      this.options.todoSessions.link({ todoId, sessionId });
    } catch (error) {
      logger.warn(`Workflow run ${run.id} could not attribute session ${sessionId} to Todo ${todoId}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async dispatch(run: WorkflowRunDetail, node: EmployeeNode, config: ResolvedEmployeeConfig): Promise<void> {
    const at = this.now();
    const promptText = composeEmployeePrompt(run, node, Boolean(config.continuedFrom));
    const firstPhase = run.attempts.length === 0;
    const attempt = this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setNodeStatus(node.id, "dispatching", { resolvedConfig: config as unknown as Record<string, JsonValue>,
        input: inputFor(run, node.id), startedAt: at });
      return tx.createAttempt({ nodeId: node.id, resolvedConfig: config, input: inputFor(run, node.id), promptText });
    });
    // The run's first attempt going out is the moment work starts. Later phases do
    // not re-assert it: a phase that deliberately moved the Todo somewhere more
    // informative keeps that status for the rest of the run.
    if (firstPhase) this.reflect(run, "executing", node.id);
    this.changed(run);
    await this.sendAttempt(run, node.id, attempt.attempt);
  }

  /** Hand a created attempt to the executor, settling it as a dispatch failure if the executor refuses it. */
  private async sendAttempt(run: WorkflowRunDetail, nodeId: string, attemptNumber: number): Promise<void> {
    try {
      await this.recoverDispatching(run.workflowId, run.id, nodeId, attemptNumber);
    } catch (error) {
      const current = this.detail(run.workflowId, run.id);
      const stored = current.attempts.find((item) => item.nodeId === nodeId && item.attempt === attemptNumber)!;
      this.settleFailure(current, stored, dispatchFailure(error, nodeId, attemptNumber), "failed", this.now());
    }
  }

  private async finish(run: WorkflowRunDetail): Promise<boolean> {
    const active = run.nodeRuns.some((node) => node.activated && !terminalNode(node));
    if (active || !reachedSuccessEnd(run) || run.status !== "running") return false;
    const endedAt = this.now();
    // Arriving at a success End is not the same as having landed. An End that
    // declared what its landing had to produce settles the run FAILED when that
    // cannot be shown, so the bound Todo reads blocked with the reason rather
    // than done over work that never left its branch.
    const shortfall = await landingShortfall(run, this.options.landingEvidence);
    if (shortfall) {
      const error: WorkflowError = { code: "workflow-landing-unverified", message: shortfall.reason,
        retryable: false, nodeId: shortfall.nodeId };
      this.options.repository.mutateRun(run.id, run.revision, (tx) => tx.setRunStatus("failed", { endedAt, error }));
      this.reflectFailure(run, shortfall.nodeId, error);
      this.changed(run);
      return true;
    }
    this.options.repository.mutateRun(run.id, run.revision, (tx) => tx.setRunStatus("completed", { endedAt }));
    completeBoundTodo(this.options.todoLifecycle, run);
    this.changed(run);
    return true;
  }

  private advance(workflowId: string, runId: string): Promise<WorkflowRunDetail> {
    const previous = this.advances.get(runId) ?? Promise.resolve(this.detail(workflowId, runId));
    const current = previous.catch(() => this.detail(workflowId, runId))
      .then(() => this.advanceNow(workflowId, runId));
    this.advances.set(runId, current);
    const clear = () => { if (this.advances.get(runId) === current) this.advances.delete(runId); };
    void current.then(clear, clear);
    return current;
  }

  private async advanceNow(workflowId: string, runId: string): Promise<WorkflowRunDetail> {
    const definition = this.detail(workflowId, runId).definition;
    const max = definition.nodes.length * 4 + 4
      + definition.nodes.reduce((budget, node) => budget
        + (node.type === "workflow-call" ? 100 * (node.config.iterate?.maxRounds ?? 1) : 0), 0);
    for (let index = 0; index < max; index += 1) {
      const run = this.detail(workflowId, runId);
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      if (run.cancelRequestedAt) return run;
      const action = this.nextAction(run);
      if (!action) {
        recordMutexWaits(this.options.repository, run);
        if (await this.finish(run)) continue;
        return this.detail(workflowId, runId);
      }
      if (action.kind === "dispatch") await this.dispatch(run, action.node, action.config);
      else if (action.kind === "fanout") await this.reconcileFanout(run, action.node);
      else if (action.kind === "iterate") await this.reconcileIteration(run, action.node);
      else this.applyInline(run, action);
    }
    return this.failRun(this.detail(workflowId, runId), new Error("Workflow control flow did not settle."));
  }

  async advanceCaller(workflowId: string, runId: string, nodeId: string): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const authored = run.definition.nodes.find((node) => node.id === nodeId);
    const runtime = run.nodeRuns.find((node) => node.nodeId === nodeId);
    if (authored?.type !== "workflow-call" || !runtime?.activated || terminalNode(runtime)
      || run.cancelRequestedAt || ["completed", "failed", "cancelled"].includes(run.status)) return false;
    await this.advance(workflowId, runId);
    return true;
  }

  async resumeWait(workflowId: string, runId: string, nodeId: string, now: string): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const runtime = nodeRun(run, nodeId);
    const authored = run.definition.nodes.find((node) => node.id === nodeId);
    const resumableEmployee = authored?.type === "employee" && runtime.status === "waiting";
    if (run.status !== "waiting" || (authored?.type !== "wait" && !resumableEmployee)
      || runtime.status !== "waiting" || !runtime.resumeAt || runtime.resumeAt > now) return false;
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      if (resumableEmployee) tx.setNodeStatus(nodeId, "pending", { activated: true });
      else tx.setNodeStatus(nodeId, "completed", { output: waitDueOutput(authored), endedAt: now });
      tx.setRunStatus("running");
    });
    this.changed(run);
    await this.advance(workflowId, runId);
    return true;
  }

  /** Resume a `todo-comment` Wait early, because the operator answered. The
   *  comment is not claimed: every run parked on that Todo resumes from it, and
   *  a re-sweep is a no-op because the node is no longer `waiting`. */
  async resumeCommentWait(workflowId: string, runId: string, nodeId: string,
    comment: { id: string; body: string; attachments: ReadonlyArray<{ id: string; mime: string }> }, now: string,
  ): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const runtime = nodeRun(run, nodeId);
    const authored = run.definition.nodes.find((node) => node.id === nodeId);
    const todoId = run.trigger.todoId;
    if (!todoId || run.status !== "waiting" || authored?.type !== "wait" || authored.config.mode !== "todo-comment"
      || runtime.status !== "waiting") return false;
    const output = commentReplyOutput(todoId, comment);
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setNodeStatus(nodeId, "completed", { endedAt: now, output });
      tx.setRunStatus("running");
    });
    this.changed(run);
    await this.advance(workflowId, runId);
    return true;
  }

  async recoverDispatching(workflowId: string, runId: string, nodeId: string, attemptNumber: number): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const attempt = run.attempts.find((item) => item.nodeId === nodeId && item.attempt === attemptNumber);
    const node = run.definition.nodes.find((item): item is EmployeeNode => item.id === nodeId && item.type === "employee");
    if (!attempt || attempt.status !== "dispatching" || !node) return false;
    // Prefer the prompt persisted at attempt creation so the session receives
    // exactly what the run detail shows; recompose only for attempts that
    // predate the column.
    const config = attempt.resolvedConfig;
    const prompt = attempt.promptText ?? composeEmployeePrompt(run, node, Boolean(config.continuedFrom));
    const { sessionId } = await this.options.executor.startAttempt({ owner: { workflowId, runId, nodeId, attempt: attemptNumber },
      employeeId: config.employeeId, engine: config.engine, ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}), prompt,
      ...(config.continuedFrom ? { continueFrom: { engine: config.engine, engineSessionId: config.continuedFrom.engineSessionId, sourceSessionId: config.continuedFrom.sessionId } } : {}) });
    const current = this.detail(workflowId, runId);
    this.options.repository.mutateRun(runId, current.revision, (tx) => {
      tx.settleAttempt(nodeId, attemptNumber, { status: "running", sessionId });
      tx.setNodeStatus(nodeId, "running");
    });
    this.attributeSession(current, sessionId);
    openTodoRun(this.options.todoSessions, current, sessionId, this.now());
    this.changed(current);
    return true;
  }

  async timeoutAttempt(workflowId: string, runId: string, nodeId: string, attemptNumber: number, at: string): Promise<boolean> {
    const run = this.detail(workflowId, runId);
    const attempt = run.attempts.find((item) => item.nodeId === nodeId && item.attempt === attemptNumber);
    if (!attempt || attempt.status !== "running") return false;
    this.settleFailure(run, attempt, { code: "workflow-timeout", message: "Workflow attempt timed out.", retryable: true, nodeId, attempt: attemptNumber }, "timed-out", at);
    return true;
  }

  async retryNode(workflowId: string, runId: string, nodeId: string, idempotencyKey: string): Promise<WorkflowRunDetail> {
    const run = this.detail(workflowId, runId);
    const replay = this.options.repository.findAttemptByRetryKey(run.id, idempotencyKey);
    if (replay) return this.detail(workflowId, runId);
    const latest = run.attempts.filter((attempt) => attempt.nodeId === nodeId).at(-1);
    const authored = run.definition.nodes.find((item): item is EmployeeNode => item.id === nodeId && item.type === "employee");
    if (!latest || !authored) throw new Error(`Workflow Employee ${nodeId} has no retryable attempt.`);
    const resolvedConfig = resolveDispatch(run, authored, this.options); // ICI-733: resolved fresh, never copied off the attempt that just failed.
    const promptText = composeEmployeePrompt(run, authored, Boolean(resolvedConfig.continuedFrom));
    try {
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setNodeStatus(nodeId, "dispatching", { activated: true });
        tx.setRunStatus("running");
        tx.createAttempt({ nodeId, resolvedConfig, input: latest.input, promptText, retryIdempotencyKey: idempotencyKey });
      });
    } catch (error) {
      const claimed = this.options.repository.findAttemptByRetryKey(run.id, idempotencyKey);
      if (claimed?.nodeId === nodeId && error instanceof WorkflowRepositoryError
        && error.code === "revision-conflict") return this.detail(workflowId, runId);
      throw error;
    }
    this.changed(run);
    const attempt = this.options.repository.findAttemptByRetryKey(run.id, idempotencyKey)!;
    await this.recoverDispatching(workflowId, runId, nodeId, attempt.attempt);
    return this.detail(workflowId, runId);
  }

  async decideApproval(input: {
    workflowId: string; runId: string; nodeId: string; decision: "approve" | "reject";
    decidedBy: string; reason?: string; choice?: string; expectedRevision: number;
  }): Promise<WorkflowRunDetail> {
    const run = this.detail(input.workflowId, input.runId);
    const at = this.now();
    const status = input.decision === "approve" ? "approved" : "rejected";
    // A rejection that carries a note is not "no", it is "not yet — do it again
    // with this". The graph's `rejected` route encodes what "no" means (in
    // practice, an End that abandons the work), so it is deliberately NOT taken:
    // this run stops here and the bound Todo goes round again carrying the note.
    // Silence still means stop, and takes the authored route exactly as before.
    const note = input.reason?.trim();
    const feedback = input.decision === "reject" ? note ?? "" : "";
    const revising: WorkflowError | undefined = feedback && run.trigger.todoId && this.options.todoLifecycle
      ? { code: "workflow-revision-requested", nodeId: input.nodeId, retryable: false,
          message: `Workflow approval ${input.nodeId} was rejected with feedback; the Todo goes round again.` }
      : undefined;
    const routed = !revising
      && run.definition.edges.some((edge) => edge.from.nodeId === input.nodeId && edge.from.port === status);
    const missingRoute: WorkflowError = { code: "workflow-approval-route-missing", message: `Workflow approval ${input.nodeId} has no ${status} route.`, retryable: false, nodeId: input.nodeId };
    const gateOutput = { text: input.choice ?? "", fields: { port: status, ...(note ? { reason: note } : {}) }, ...(input.choice !== undefined ? { choice: input.choice } : {}) };
    this.options.repository.mutateRun(run.id, input.expectedRevision, (tx) => {
      const pending = run.approvals.find((approval) => approval.nodeId === input.nodeId)!;
      tx.putApproval({ nodeId: pending.nodeId, requestedAt: pending.requestedAt,
        ...(pending.approverRef ? { approverRef: pending.approverRef } : {}), status,
        decidedAt: at, decidedBy: input.decidedBy, decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}) });
      if (revising) {
        // The gate was decided, not broken — `completed` on its `rejected` port.
        // The run is `cancelled`, not `failed`: a human stopped it on purpose, and
        // a failed run would reflect `blocked` onto the very Todo being re-armed.
        tx.setNodeStatus(input.nodeId, "completed", { output: gateOutput, endedAt: at });
        tx.setRunStatus("cancelled", { cancelRequestedAt: at, endedAt: at, error: revising });
      } else if (routed) {
        tx.setNodeStatus(input.nodeId, "completed", { output: gateOutput, endedAt: at });
        tx.setRunStatus("running");
      } else {
        tx.setNodeStatus(input.nodeId, "failed", { error: missingRoute, endedAt: at });
        tx.setRunStatus("failed", { error: missingRoute, endedAt: at });
      }
    });
    const todoId = run.trigger.todoId;
    if (todoId && this.options.todoLifecycle) {
      try {
        this.options.todoLifecycle.recordApprovalDecision({
          todoId, workflowId: run.workflowId, runId: run.id, nodeId: input.nodeId,
          decision: input.decision, decidedBy: input.decidedBy,
          ...(input.choice !== undefined ? { choice: input.choice } : {}),
          ...(note ? { note } : {}),
        });
      } catch (error) {
        logger.warn(`Workflow run ${run.id} could not record gate ${input.nodeId} decision onto Todo ${todoId}: `
          + `${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.changed(run);
    if (revising) {
      this.requestRevision(run, input.nodeId, feedback, input.decidedBy);
      return this.detail(input.workflowId, input.runId);
    }
    // An unrouted decision ends the run, so the bound Todo owes the same honest
    // trace as any other failure — without this it kept reading `in_review`
    // while the run behind it was already dead.
    if (!routed) this.reflectFailure(run, input.nodeId, missingRoute);
    return routed ? this.advance(input.workflowId, input.runId) : this.detail(input.workflowId, input.runId);
  }

  private settleFailure(run: WorkflowRunDetail, attempt: typeof run.attempts[number], error: WorkflowError,
    status: "failed" | "timed-out" | "cancelled", endedAt: string, processedTurn?: number, handoff?: unknown): boolean {
    // `error.retryable` is what decides this, not the attempt counter alone. A node's retry budget exists for
    // attempts that never landed; spending it on an employee that ran and reported failure pays twice for a verdict
    // that was already reached, and can override a phase that deliberately refused. A substitution spends none of it:
    // the budget governs asking the SAME engine again, and an engine with no allowance left never answered at all.
    // A gateway restart is not one of this node's attempts at the work, so the replacements it forced are discounted first.
    const retry = (error.retryable && attempt.attempt - restartsOn(run, attempt.nodeId) < attempt.resolvedConfig.retry.attempts)
      || hasSubstitute(run, attempt, error, this.options);
    const routed = !retry && run.definition.edges.some((edge) => edge.from.nodeId === attempt.nodeId && edge.from.port === "error");
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      if (processedTurn !== undefined) {
        tx.setAttemptReminder(attempt.nodeId, attempt.attempt, { lastProcessedTurn: processedTurn });
      }
      tx.settleAttempt(attempt.nodeId, attempt.attempt, { status,
        ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}), error, endedAt });
      if (retry) {
        const factor = attempt.resolvedConfig.retry.backoff === "exponential" ? 2 ** (attempt.attempt - 1) : 1;
        const resumeAt = new Date(Date.parse(endedAt)
          + Math.min(600, attempt.resolvedConfig.retry.delaySeconds * factor) * 1000).toISOString();
        tx.setNodeStatus(attempt.nodeId, "waiting", { error, resumeAt, endedAt });
        tx.setRunStatus("waiting");
      } else {
        tx.setNodeStatus(attempt.nodeId, "failed", { error, endedAt });
        if (routed) tx.setRunStatus("running");
        else tx.setRunStatus("failed", { error, endedAt });
      }
    });
    // A routed error edge keeps the run alive, so the Todo is not blocked yet —
    // whatever that branch reaches decides.
    if (!retry && !routed) this.reflectFailure(run, attempt.nodeId, error);
    // The ATTEMPT is over either way: a retry opens a fresh row on the next
    // dispatch and this one's evidence is what that retry gets to read.
    settleTodoRun(this.options.todoSessions, run, attempt, { status, endedAt, error, handoff });
    // A retry keeps the node live, and with it its mutex key: the node is still working the same
    // critical section, so handing the key on mid-backoff puts two of them in there when it ends.
    if (!retry) wakeMutexWaiters(this.options.repository, run, attempt.nodeId, (id, item) => this.advance(id, item));
    this.changed(run);
    return routed;
  }

  private activeRunForAttempt(attempt: WorkflowRunDetail["attempts"][number]): WorkflowRunDetail {
    const record = this.options.repository.listRecoverableRuns().find((candidate) => candidate.id === attempt.runId);
    if (!record) {
      throw new WorkflowRepositoryError("corrupt-record", `Workflow attempt ${attempt.nodeId}:${attempt.attempt} has no active run.`);
    }
    return this.detail(record.workflowId, record.id);
  }

  private alreadySubmitted(sessionId: string): never {
    throw new WorkflowRepositoryError("already-submitted", `Workflow attempt session ${sessionId} already submitted.`);
  }

  async remindDueAttempts(now: string): Promise<void> {
    await remindDueAttempts(now, {
      repository: this.options.repository,
      executor: this.options.executor,
      activeRun: (attempt) => this.activeRunForAttempt(attempt),
      changed: (run) => this.changed(run),
    });
  }

  /**
   * The immediate half of the same problem the ladder solves on a timer: a turn
   * that ended on narration decided nothing, and the first rung is five minutes
   * away. Nudging inline costs nothing and usually ends the step right here.
   *
   * The nudge is itself a turn, so its own end re-enters `complete()`; the
   * persisted count is what bounds the loop. A dispatch that cannot be claimed
   * (the session took a message in the meantime) is not a failure worth
   * propagating: the caller falls back to arming the ordinary rung.
   */
  private async stopNudge(run: WorkflowRunDetail, attempt: WorkflowRunDetail["attempts"][number],
    event: WorkflowAttemptCompletion): Promise<boolean> {
    if (!planStopNudge({ finalText: event.finalText ?? "", stopNudgesSent: attempt.stopNudgesSent })) return false;
    try {
      await this.options.executor.remind({ sessionId: event.sessionId, text: STOP_NUDGE_TEXT });
    } catch (error) {
      logger.warn(`Workflow attempt ${attempt.nodeId}:${attempt.attempt} could not be nudged to submit: `
        + `${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setAttemptReminder(attempt.nodeId, attempt.attempt, {
        stopNudgesSent: attempt.stopNudgesSent + 1,
        lastProcessedTurn: event.turn,
      });
    });
    this.changed(run);
    return true;
  }

  async submit(input: {
    sessionId: string;
    outcome?: "success" | "failure";
    fields?: unknown;
    summary?: string;
  }): Promise<WorkflowRunDetail> {
    const attempt = this.options.repository.findAttemptBySessionId(input.sessionId);
    if (!attempt) {
      throw new WorkflowRepositoryError("not-found", `Workflow attempt session ${input.sessionId} was not found.`);
    }
    if (attempt.status !== "running") this.alreadySubmitted(input.sessionId);
    const run = this.activeRunForAttempt(attempt);
    const node = run.definition.nodes.find((candidate): candidate is EmployeeNode =>
      candidate.id === attempt.nodeId && candidate.type === "employee");
    if (!node) throw new WorkflowRepositoryError("corrupt-record", `Workflow attempt ${attempt.nodeId} has no Employee node.`);
    if (input.outcome === "failure") {
      const error: WorkflowError = {
        code: "workflow-submitted-failure",
        // The employee ran and reported failure. That is a verdict, not a dropped
        // attempt: re-dispatching it spends again on a decision already made, and
        // has overridden a phase that stopped on purpose.
        message: input.summary ?? "Step reported failure.",
        retryable: false,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
      };
      const routed = this.settleFailure(run, attempt, error, "failed", this.now(), undefined, input.fields);
      return routed ? this.advance(run.workflowId, run.id) : this.detail(run.workflowId, run.id);
    }
    const fields = validateSubmittedFields(input.fields, node.config.output);
    const output: WorkflowNodeOutput = {
      text: input.summary ?? "",
      fields,
      employeeId: attempt.resolvedConfig.employeeId,
      engine: attempt.resolvedConfig.engine,
      ...(attempt.resolvedConfig.model ? { model: attempt.resolvedConfig.model } : {}),
      sessionId: input.sessionId,
    };
    try {
      this.options.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, {
          status: "completed",
          sessionId: input.sessionId,
          output,
          endedAt: this.now(),
        });
        tx.setNodeStatus(attempt.nodeId, "completed", { output, endedAt: this.now() });
      });
    } catch (error) {
      if (error instanceof WorkflowRepositoryError && error.code === "revision-conflict"
        && this.options.repository.findAttemptBySessionId(input.sessionId)?.status !== "running") {
        this.alreadySubmitted(input.sessionId);
      }
      throw error;
    }
    settleTodoRun(this.options.todoSessions, run, attempt, { status: "completed", endedAt: this.now(), output });
    this.changed(run);
    return this.advance(run.workflowId, run.id);
  }

  async extend(input: { sessionId: string; reason?: string }): Promise<void> {
    const attempt = this.options.repository.findAttemptBySessionId(input.sessionId);
    if (!attempt) {
      throw new WorkflowRepositoryError("not-found", `Workflow attempt session ${input.sessionId} was not found.`);
    }
    if (attempt.status !== "running") this.alreadySubmitted(input.sessionId);
    const run = this.activeRunForAttempt(attempt);
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setAttemptReminder(attempt.nodeId, attempt.attempt, {
        remindersSent: 0,
        nextReminderAt: null,
        extensions: attempt.extensions + 1,
        lastExtensionReason: input.reason ?? null,
        pendingOutputError: null,
      });
    });
    this.changed(run);
  }

  async complete(event: WorkflowAttemptCompletion): Promise<boolean> {
    const attempt = this.options.repository.findAttemptBySessionId(event.sessionId);
    if (!attempt || attempt.status !== "running" || event.terminalVersion < 1
      || !Number.isInteger(event.turn) || event.turn < 1 || event.turn <= attempt.lastProcessedTurn) return false;
    const run = this.detail(event.owner.workflowId, event.owner.runId);
    if (attempt.runId !== run.id || attempt.nodeId !== event.owner.nodeId || attempt.attempt !== event.owner.attempt) return false;
    const node = run.definition.nodes.find((candidate): candidate is EmployeeNode => candidate.id === attempt.nodeId && candidate.type === "employee");
    if (!node) return false;
    const cancellation = event.outcome === "interrupted" && run.cancelRequestedAt
      ? { code: "workflow-cancelled", message: event.error ?? "Workflow run cancelled.", retryable: false, nodeId: attempt.nodeId, attempt: attempt.attempt } satisfies WorkflowError : undefined;
    const userMessageTurnEnd = event.outcome === "interrupted"
      && event.interruptionCause === "user-message"
      && !run.cancelRequestedAt;
    const cleanTurnEnd = event.outcome === "succeeded" || userMessageTurnEnd;
    let output: WorkflowNodeOutput | undefined;
    let failure: WorkflowError | undefined;
    let pendingOutputError: string | undefined;
    if (event.outcome === "succeeded") {
      const finalText = event.finalText ?? "";
      if (hasWorkflowOutputBlock(finalText)) {
        try {
          output = { ...parseWorkflowOutput(finalText, node.config.output), employeeId: attempt.resolvedConfig.employeeId,
            engine: attempt.resolvedConfig.engine, ...(attempt.resolvedConfig.model ? { model: attempt.resolvedConfig.model } : {}), sessionId: event.sessionId };
        } catch (error) {
          if (error instanceof WorkflowOutputError) pendingOutputError = error.message;
          else failure = workflowError(error, attempt.nodeId, attempt.attempt);
        }
      }
    } else if (!userMessageTurnEnd) {
      failure = event.outcome === "interrupted"
        ? interruptedAttemptFailure(event.error ?? "Workflow attempt was interrupted.", attempt.nodeId, attempt.attempt, event.interruptionCause)
        : workflowError(event.error ?? `Workflow attempt was ${event.outcome}.`, attempt.nodeId, attempt.attempt);
    }
    const endedAt = event.completedAt;
    if (cleanTurnEnd && !output && !failure) {
      // An unparseable block already earns its own targeted reminder, so telling
      // that turn it ended on narration would simply be untrue.
      if (!pendingOutputError && await this.stopNudge(run, attempt, event)) return true;
      if (attempt.remindersSent < REMINDER_RUNGS_MINUTES.length) {
        this.options.repository.mutateRun(run.id, run.revision, (tx) => {
          tx.setAttemptReminder(attempt.nodeId, attempt.attempt, {
            nextReminderAt: addMinutes(endedAt, REMINDER_RUNGS_MINUTES[attempt.remindersSent]!),
            ...(pendingOutputError ? { pendingOutputError } : {}),
            lastProcessedTurn: event.turn,
          });
        });
        this.changed(run);
        return true;
      }
      const state = this.options.executor.attemptState(event.sessionId);
      if ((state?.runningChildren ?? 0) > 0) return true;
      const noOutput: WorkflowError = { code: "workflow-no-output", message: "Workflow attempt ended without submitting output.", retryable: true, nodeId: attempt.nodeId, attempt: attempt.attempt };
      const routed = this.settleFailure(run, attempt, noOutput, "failed", endedAt, event.turn);
      if (routed) await this.advance(run.workflowId, run.id);
      return true;
    }
    if (!output && !cancellation) {
      const replacement = failure!.code === RESTART_INTERRUPTED
        ? openRestartReplacement({ ...this.options, prompt: (continued) => composeEmployeePrompt(run, node, continued) },
          run, attempt, failure!, event) : null;
      if (replacement !== null) { this.changed(run); await this.sendAttempt(run, attempt.nodeId, replacement); return true; }
      const routed = this.settleFailure(run, attempt, failure!.code === RESTART_INTERRUPTED
        ? restartExhaustedFailure(attempt.nodeId, attempt.attempt, restartsOn(run, attempt.nodeId) + 1) : failure!,
        event.outcome === "interrupted" ? "cancelled" : "failed", endedAt, event.turn);
      if (routed) await this.advance(run.workflowId, run.id);
      return true;
    }
    this.options.repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setAttemptReminder(attempt.nodeId, attempt.attempt, { lastProcessedTurn: event.turn });
      if (cancellation) {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, { status: "cancelled", sessionId: event.sessionId, error: cancellation, endedAt });
        tx.setNodeStatus(attempt.nodeId, "cancelled", { error: cancellation, endedAt });
        // A cancel the gateway died inside of has no drain left to finish it, so the last node going terminal settles the run itself.
        if (!run.nodeRuns.some((item) => item.nodeId !== attempt.nodeId && item.activated && !terminalNode(item))) tx.setRunStatus("cancelled", { endedAt });
      } else if (output) {
        tx.settleAttempt(attempt.nodeId, attempt.attempt, { status: "completed", sessionId: event.sessionId, output, endedAt });
        tx.setNodeStatus(attempt.nodeId, "completed", { output, endedAt });
      }
    });
    if (cancellation) settleTodoRun(this.options.todoSessions, run, attempt, { status: "cancelled", endedAt, error: cancellation });
    else if (output) settleTodoRun(this.options.todoSessions, run, attempt, { status: "completed", endedAt, output });
    wakeMutexWaiters(this.options.repository, run, attempt.nodeId, (id, item) => this.advance(id, item));
    this.changed(run);
    if (output && !cancellation) await this.advance(run.workflowId, run.id);
    return true;
  }
}
