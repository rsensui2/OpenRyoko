import { Buffer } from "node:buffer";
import cron, { type ScheduledTask } from "node-cron";
import { validateCronSchedule } from "../cron/validation.js";
import { logger } from "../shared/logger.js";
import { claimWorkItem, releaseWorkItemClaim } from "../work-items/claims.js";
import { normalizeLabelName } from "../work-items/labels.js";
import { appendRespawnGuardHold, checkRespawnGuard } from "../work-items/respawn-guards.js";
import { createWorkflowTodoEventFeed, type WorkflowTodoEventFeed,
  type WorkflowTodoStatusEvent } from "../work-items/workflow-event-feed.js";
import { startedAfterEvent } from "../work-items/workflow-event-winners.js";
import { jsonValueSchema, type JsonValue, type TriggerNode, type WorkflowDefinition } from "./model.js";
import { WorkflowRepositoryError, type WorkflowRepository } from "./repository.js";
import type { WorkflowRunDetail } from "./runtime.js";
import type { WorkflowRunner } from "./runner.js";
import { owningWorkflowId } from "../work-items/workflow-ownership.js";
import { declinedOutcomes, NOTHING_SUPERSEDED, settle, stillWhereTheEventLeftIt, suppressAll,
  type IndexedTrigger, type SupersededBy, type TodoCandidate, type TodoMismatch } from "./todo-event-outcome.js";

export interface FireWorkflowEventInput {
  eventName: string;
  fireId: string;
  payload: Record<string, JsonValue>;
}

interface ScheduleIndex extends IndexedTrigger { task: ScheduledTask }
function bad(message: string): never { throw new WorkflowRepositoryError("bad-input", message); }
function payload(value: unknown): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    bad("Workflow event payload must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 64 * 1024) bad("Workflow event payload must be at most 64 KiB.");
  return parsed.data as Record<string, JsonValue>;
}
function trigger(definition: WorkflowDefinition, kind: TriggerNode["config"]["kind"]): TriggerNode | undefined {
  return definition.nodes.find((node): node is TriggerNode => node.type === "trigger" && node.config.kind === kind);
}
function labelMatches(filter: string, labels: WorkflowTodoStatusEvent["item"]["labels"]): boolean {
  let name: string; try { name = normalizeLabelName(filter); } catch { return false; }
  return labels.some((label) => label.id === filter || label.name === name);
}
function refused(reason: string): TodoMismatch { return { filter: "other", reason }; }
/** Why this Todo event does NOT match the trigger, or undefined when it does.
 *  Filters are ANDed; the first mismatch is what gets reported, so a suppressed
 *  run always says which filter refused it. */
function todoMismatch(node: TriggerNode, event: WorkflowTodoStatusEvent): TodoMismatch | undefined {
  if (node.config.kind !== "todo-status") return refused("trigger is not a todo-status trigger");
  const { actor, label, department, assignee, delegates, unlabeled, unassigned, rootOnly } = node.config;
  // An arming delegate moved the Todo as itself, so the event names its session
  // rather than the operator; the stamp the status route wrote at that moment is
  // what says the operator's authority stands behind it. Only an `operator`
  // filter is widened, and only where the binding has not opted out.
  const armed = actor === "operator" && delegates !== false && event.armedAsDelegate !== null;
  const resumed = actor === "operator" && (event.quotaWindowDecided || event.armedAsRecovery === true);
  if (actor !== undefined && actor !== event.actor && !armed && !resumed) {
    return refused(`actor ${event.actor ?? "unknown"} is not ${actor}`);
  }
  if (department !== undefined && department !== event.item.department) return refused(`department filter ${department} does not match`);
  if (assignee !== undefined && assignee !== event.item.assignee) return refused(`assignee filter ${assignee} does not match`);
  const live = event.item.live;
  if (unlabeled !== undefined || unassigned !== undefined || rootOnly !== undefined) {
    // These three assert what the Todo IS right now, so a row that has since been
    // deleted answers none of them — an unknown Todo must refuse rather than fall
    // through as a match and arm a workflow on nothing.
    if (live === null) return refused("the Todo no longer exists, so its live filters cannot match");
    if (unlabeled && event.item.labels.length > 0) return refused("unlabeled filter does not match: the Todo carries labels");
    if (unassigned && live.assignee !== null) return refused(`unassigned filter does not match: the Todo is assigned to ${live.assignee}`);
    if (rootOnly && live.parentId !== null) return refused(`rootOnly filter does not match: the Todo is a child of ${live.parentId}`);
  }
  // Judged LAST on purpose: a `label` mismatch has to mean that every other filter
  // was satisfied, or a Todo refused for something a label cannot change would be
  // read as a race and left waiting for a label that would not have helped.
  if (label !== undefined && !labelMatches(label, event.item.labels)) {
    return { filter: "label", reason: `label filter ${label} does not match` };
  }
  return undefined;
}
export class WorkflowTriggerService {
  private readonly schedules = new Map<string, ScheduleIndex>();
  private readonly todos = new Map<string, IndexedTrigger[]>();
  private readonly feed: WorkflowTodoEventFeed;

  constructor(private readonly repository: WorkflowRepository, private readonly runner: WorkflowRunner,
    private readonly now: () => string = () => new Date().toISOString(), feed?: WorkflowTodoEventFeed) {
    this.feed = feed ?? createWorkflowTodoEventFeed();
    this.rebuild();
  }
  dispose(): void { for (const item of this.schedules.values()) item.task.stop(); this.schedules.clear(); this.todos.clear(); }

  rebuild(): void {
    this.dispose();
    for (const definition of this.enabledDefinitions()) {
      const schedule = trigger(definition, "schedule");
      if (schedule && schedule.config.kind === "schedule") this.addSchedule(definition, schedule);
      const todo = trigger(definition, "todo-status");
      if (todo && todo.config.kind === "todo-status") {
        const items = this.todos.get(todo.config.status) ?? []; items.push({ definition, trigger: todo });
        this.todos.set(todo.config.status, items);
      }
    }
  }

  async fire(input: FireWorkflowEventInput): Promise<WorkflowRunDetail[]> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(input.eventName)
      || typeof input.fireId !== "string" || input.fireId.length < 1 || input.fireId.length > 128) bad("Workflow event identity is invalid.");
    const eventPayload = payload(input.payload); const runs: WorkflowRunDetail[] = [];
    for (const definition of this.enabledDefinitions()) {
      const event = definition.nodes.find((node): node is TriggerNode => node.type === "trigger"
        && node.config.kind === "event" && node.config.eventName === input.eventName);
      if (event) runs.push(await this.start(definition, event, input.fireId, eventPayload, `event:${input.fireId}`));
    }
    return runs;
  }

  async recoverTodoEvents(): Promise<number> {
    if (this.todos.size === 0) return 0;
    const pending = this.feed.listPendingEvents(500);
    const superseded = this.supersededDefinitions(pending);
    let count = 0;
    for (const event of pending) count += await this.fireTodo(event, superseded.get(event.id) ?? NOTHING_SUPERSEDED);
    return count;
  }

  /** A Todo whose label stood down leaves a backlog of unclaimed events behind,
   *  and restoring the label makes all of them qualify at once — six runs on one
   *  Todo in half a minute. For each (Todo, definition) only the newest
   *  qualifying event runs. `listPendingEvents` hands them back oldest first, so
   *  walking backwards makes the first sighting of a key the winner. */
  private supersededDefinitions(pending: ReadonlyArray<WorkflowTodoStatusEvent>): Map<string, Map<string, string>> {
    const winners = new Map<string, string>();
    const superseded = new Map<string, Map<string, string>>();
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const event = pending[index]!;
      for (const item of this.todos.get(event.toStatus) ?? []) {
        if (todoMismatch(item.trigger, event) !== undefined) continue;
        const key = `${event.workItemId}\u0000${item.definition.id}`;
        const winner = winners.get(key);
        if (winner === undefined) { winners.set(key, event.id); continue; }
        const forEvent = superseded.get(event.id) ?? new Map<string, string>();
        forEvent.set(item.definition.id, winner);
        superseded.set(event.id, forEvent);
      }
    }
    return superseded;
  }

  private enabledDefinitions(): WorkflowDefinition[] {
    const definitions: WorkflowDefinition[] = []; let cursor: string | undefined;
    do {
      const page = this.repository.listDefinitions({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
      definitions.push(...page.items.map((item) => this.repository.getDefinition(item.id)!).filter(Boolean));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return definitions;
  }

  private addSchedule(definition: WorkflowDefinition, schedule: TriggerNode): void {
    if (schedule.config.kind !== "schedule") return;
    // A row stored before the authoring gate existed can still be unarmable;
    // skip-and-log it exactly as the Cron scheduler does, rather than throwing
    // out of rebuild() and taking the whole gateway down at boot.
    const errors = validateCronSchedule({ schedule: schedule.config.cron, timezone: schedule.config.timezone });
    if (errors.length > 0) {
      logger.warn(`Skipping invalid Workflow schedule "${definition.id}": ${errors.map((error) => error.message).join("; ")}`);
      return;
    }
    const revision = definition.revision;
    const task = cron.schedule(schedule.config.cron, () => { void this.fireSchedule(definition.id, revision); },
      { timezone: schedule.config.timezone });
    this.schedules.set(definition.id, { definition, trigger: schedule, task });
  }

  private async fireSchedule(workflowId: string, revision: number): Promise<void> {
    const indexed = this.schedules.get(workflowId);
    if (!indexed || indexed.definition.revision !== revision) return;
    const fireId = this.now();
    await this.start(indexed.definition, indexed.trigger, fireId, { scheduledAt: fireId }, `schedule:${fireId}`);
  }

  private async fireTodo(event: WorkflowTodoStatusEvent, pendingWinners: SupersededBy): Promise<number> {
    const candidates: TodoCandidate[] = (this.todos.get(event.toStatus) ?? [])
      .map((item) => ({ ...item, mismatch: todoMismatch(item.trigger, event) }));
    const superseded = this.supersededForEvent(event, candidates, pendingWinners);
    // Drop the superseded definitions BEFORE the claim: the claim stores the ids
    // a lease takeover replays from, so one we have decided not to run must
    // never be written into it.
    const indexed = candidates.filter((item) => item.mismatch === undefined && !superseded.has(item.definition.id));
    const claim = this.feed.claimEvent(event.id, indexed.map((item) => item.definition.id));
    if (claim.state !== "acquired") return 0;
    const allowed = new Set(claim.definitionIds);
    // A deferred re-drain is only re-deciding the definitions the deferral put
    // back; every other candidate was settled by the pass that deferred, and
    // recording it again here would overwrite what actually happened to it.
    const deciding = claim.deferred ? candidates.filter((item) => allowed.has(item.definition.id)) : candidates;
    const outcomes = declinedOutcomes(event, deciding, superseded, claim.deferred === true);
    const labels = event.item.labels.map((label) => label.name);
    let runnable = indexed.filter((candidate) => allowed.has(candidate.definition.id));
    const bound = owningWorkflowId(event.workItemId);
    if (bound !== undefined && runnable.some((candidate) => candidate.definition.id === bound)) {
      for (const extra of runnable.filter((candidate) => candidate.definition.id !== bound)) {
        const detail = `Todo event ${event.id} suppressed: ${event.workItemId} already belongs to workflow \`${bound}\`.`;
        logger.info(`Workflow ${extra.definition.id}: ${detail}`);
        outcomes.push({ workflowId: extra.definition.id, outcome: "suppressed", detail });
      }
      runnable = runnable.filter((candidate) => candidate.definition.id === bound);
    }
    const owner = `workflow:${event.id}`;
    const refusal = this.refusalBeforeStart(event, claim.deferred === true, runnable, owner);
    if (refusal !== undefined) return suppressAll(this.feed, event, runnable, outcomes, refusal);
    try {
      for (const item of runnable) {
        const run = await this.start(item.definition, item.trigger, event.id, {
          todoId: event.workItemId, fromStatus: event.fromStatus, toStatus: event.toStatus,
          actor: event.actor, source: event.item.source, department: event.item.department,
          assignee: event.item.assignee, labels, labelList: labels.join(", "),
        }, `todo:${event.id}`, event.workItemId);
        outcomes.push({ workflowId: item.definition.id, outcome: "started", runId: run.id, detail: `Todo event ${event.id} started.` });
      }
      settle(this.feed, event, deciding, outcomes);
      return outcomes.filter((outcome) => outcome.outcome === "started").length;
    } catch (error) { releaseWorkItemClaim(event.workItemId, owner); this.feed.releaseEvent(event.id); throw error; }
  }

  /** Which definitions a newer event has already taken this Todo's lane for.
   *  The pending page answers this for siblings still waiting their turn; it
   *  cannot answer it for one that has already run, because a settled event is
   *  no longer pending — and past the page's own limit it cannot answer it at
   *  all. A deferral released after either kind of sibling would otherwise see
   *  an empty gate and start a second run on a lane already running. */
  private supersededForEvent(event: WorkflowTodoStatusEvent, candidates: ReadonlyArray<TodoCandidate>,
    pendingWinners: SupersededBy): SupersededBy {
    // Nothing qualified, so nothing can be beaten, and the ordinary drain pays
    // nothing for a query with no question in it.
    if (!candidates.some((item) => item.mismatch === undefined)) return pendingWinners;
    const settled = startedAfterEvent(event.id);
    if (settled.size === 0) return pendingWinners;
    // Both maps name events strictly newer than this one, so either detail line
    // is true. The pending page wins the tie: it is the same rule the drain has
    // already applied to this event's waiting siblings.
    const winners = new Map(settled);
    for (const [definitionId, winner] of pendingWinners) winners.set(definitionId, winner);
    return winners;
  }

  /** Why nothing may start on this event yet, or undefined when a run may. The
   *  filters have already had their say; these are the three things that stop a
   *  fire this late, and they all refuse the whole event rather than one
   *  definition of it. */
  private refusalBeforeStart(event: WorkflowTodoStatusEvent, deferred: boolean,
    runnable: ReadonlyArray<IndexedTrigger>, owner: string): string | undefined {
    // A deferral is only good while the Todo sits where the event put it. Once it
    // has moved on the event is stale, and a label landing later must not fire a
    // run on work that has already gone somewhere else.
    if (deferred && !stillWhereTheEventLeftIt(event)) return `${event.workItemId} has moved on from ${event.toStatus}`;
    // Nothing is going to run, so there is no work to hold and no guard to ask:
    // taking the Todo's claim here would only lock it against somebody who will.
    if (runnable.length === 0) return undefined;
    // The respawn guards run BEFORE the claim (ICI-731): this is the automated
    // re-dispatch lane — status-driven pickup, and workflow re-arm one hop later
    // through the status transition it writes — and a Todo a guard refuses must
    // stay free for a human to dispatch by hand. One event, one audited hold,
    // however many definitions were about to run on it. A re-arm the availability
    // sweep wrote arrives with the quota window already settled from the
    // failure's own reset, so `rate_limit_cooldown` does not get to answer that
    // question again generically; the other three guards still do.
    const guard = checkRespawnGuard(event.workItemId, undefined, { quotaWindowDecided: event.quotaWindowDecided });
    if (guard.state === "held") {
      appendRespawnGuardHold(event.workItemId, guard, owner);
      return `the ${guard.guard} guard holds it: ${guard.reason}`;
    }
    // Claim the TODO, not just the event: the event claim stops this event being
    // replayed, and this stops a DIFFERENT event — or another gateway — starting
    // a second run on work somebody is already doing. A rejected claim means the
    // Todo row is gone, and a Todo that no longer exists cannot be double-worked.
    const todo = claimWorkItem({ workItemId: event.workItemId, owner });
    return todo.state === "held" ? `${event.workItemId} is already being worked by ${todo.claim.owner}` : undefined;
  }

  private async start(definition: WorkflowDefinition, source: TriggerNode, fireId: string,
    triggerPayload: Record<string, JsonValue>, idempotencyKey: string, todoId?: string): Promise<WorkflowRunDetail> {
    const created = this.repository.createRun({ workflowId: definition.id, input: {},
      trigger: { nodeId: source.id, kind: source.config.kind, fireId, payload: triggerPayload, ...(todoId ? { todoId } : {}) },
      idempotencyKey });
    const detail = this.repository.getRun(definition.id, created.id)!;
    return detail.status === "pending" ? this.runner.start(created.id) : detail;
  }
}
