import {
  jsonValueSchema,
  workflowDefinitionSchema,
  workflowNodeSchema,
  type Binding,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from './model.js';
import { validateBindingPath } from './bindings.js';
import { validateCronSchedule } from '../cron/validation.js';
import type { WorkflowValidationIssue } from './issues.js';
import { ITERATION_EXHAUSTED_PORT, workflowCallIterationIssues, workflowCallSaveIssues } from './validation-workflow-call.js';
import { endRequirementIssues } from './validation-end-requires.js';

export type { WorkflowValidationIssue } from './issues.js';
export { workflowCallSaveIssues } from './validation-workflow-call.js';
export { endRequirementIssues };

type AddIssue = (issue: WorkflowValidationIssue) => void;
type RecordValue = Record<string, unknown>;
type EdgeParts = { id: string; fromId: string; fromPort: string; toId: string; toPort: string };
type ValidEdge = EdgeParts & { edgeIndex: number; source: WorkflowNode; target: WorkflowNode };
type Graph = {
  outgoing: Map<string, ValidEdge[]>;
  incoming: Map<string, ValidEdge[]>;
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
};
type BindingCheckContext = { declared: Set<string>; graph: Graph; known: Set<string>; add: AddIssue };

const PORT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const FORBIDDEN_PORTS = new Set(['__proto__', 'prototype', 'constructor']);
const CYCLE_MESSAGE = 'Workflow graph contains a directed cycle.';
const INVALID_DEFINITION_MESSAGE = 'Workflow definition is invalid.';
const REFERENCE_MESSAGE = 'Workflow graph contains an unknown node reference.';
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function normalizedValue(value: unknown): unknown | undefined {
  const normalized = jsonValueSchema.safeParse(value);
  return normalized.success ? normalized.data : undefined;
}

function safeDefinition(value: WorkflowDefinition): WorkflowDefinition | undefined {
  const normalized = normalizedValue(value);
  if (normalized === undefined) return undefined;
  const parsed = workflowDefinitionSchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}

function safeNode(value: WorkflowNode): WorkflowNode | undefined {
  const normalized = normalizedValue(value);
  if (normalized === undefined) return undefined;
  const parsed = workflowNodeSchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}

function nodesOf(definition: WorkflowDefinition): WorkflowNode[] {
  const nodes = record(definition)?.nodes;
  return Array.isArray(nodes) ? nodes as WorkflowNode[] : [];
}

function edgesOf(definition: WorkflowDefinition): WorkflowEdge[] {
  const edges = record(definition)?.edges;
  return Array.isArray(edges) ? edges as WorkflowEdge[] : [];
}

function nodeId(node: WorkflowNode): string | undefined {
  const id = record(node)?.id;
  return typeof id === 'string' ? id : undefined;
}

function validConditionPort(value: unknown): value is string {
  return typeof value === 'string' && PORT.test(value) && !FORBIDDEN_PORTS.has(value);
}

function conditionValues(node: WorkflowNode): { cases?: unknown[]; defaultPort?: unknown } {
  const config = record(record(node)?.config);
  return { cases: Array.isArray(config?.cases) ? config.cases : undefined, defaultPort: config?.defaultPort };
}

function conditionPorts(node: WorkflowNode): string[] {
  const { cases, defaultPort } = conditionValues(node);
  const ports: string[] = [];
  const seen = new Set<string>();
  for (const item of cases ?? []) {
    const port = record(item)?.port;
    if (validConditionPort(port) && !seen.has(port)) {
      ports.push(port);
      seen.add(port);
    }
  }
  if (validConditionPort(defaultPort) && !seen.has(defaultPort)) ports.push(defaultPort);
  return ports;
}

function portsOf(node: WorkflowNode): string[] {
  const type = record(node)?.type;
  switch (type) {
    case 'trigger': return ['success'];
    case 'employee': return ['success', 'error'];
    case 'workflow-call': return record(record(node)?.config)?.iterate
      ? ['success', ITERATION_EXHAUSTED_PORT] : ['success'];
    case 'condition': return conditionPorts(node);
    case 'merge': return ['success'];
    case 'approval': return ['approved', 'rejected'];
    case 'wait': return ['success'];
    case 'end': return [];
    default: return [];
  }
}

export function outputPorts(node: WorkflowNode): string[] {
  const safe = safeNode(node);
  return safe ? portsOf(safe) : [];
}

function edgeParts(edge: WorkflowEdge): EdgeParts | undefined {
  const value = record(edge);
  const from = record(value?.from);
  const to = record(value?.to);
  if (typeof value?.id !== 'string' || typeof from?.nodeId !== 'string' || typeof from.port !== 'string'
    || typeof to?.nodeId !== 'string' || typeof to.port !== 'string') return undefined;
  return { id: value.id, fromId: from.nodeId, fromPort: from.port, toId: to.nodeId, toPort: to.port };
}

function addConditionIssues(nodes: WorkflowNode[], add: AddIssue): void {
  for (const [nodeIndex, node] of nodes.entries()) {
    if (record(node)?.type !== 'condition') continue;
    const id = nodeId(node);
    const { cases, defaultPort } = conditionValues(node);
    const seen = new Set<string>();
    if (!cases) add({ code: 'invalid-condition-port', message: 'Condition ports must be unique, nonempty path-safe identifiers.', nodeId: id, path: `nodes.${nodeIndex}.config.cases` });
    for (const [caseIndex, item] of (cases ?? []).entries()) {
      const port = record(item)?.port;
      if (!validConditionPort(port) || seen.has(port)) {
        add({ code: 'invalid-condition-port', message: 'Condition ports must be unique, nonempty path-safe identifiers.', nodeId: id, path: `nodes.${nodeIndex}.config.cases.${caseIndex}.port` });
      } else seen.add(port);
    }
    if (!validConditionPort(defaultPort) || seen.has(defaultPort)) {
      add({ code: 'invalid-condition-port', message: 'Condition ports must be unique, nonempty path-safe identifiers.', nodeId: id, path: `nodes.${nodeIndex}.config.defaultPort` });
    }
  }
}

function checkBinding(value: unknown, path: string, id: string | undefined, context: BindingCheckContext,
  self: 'self-allowed' | 'self-rejected' = 'self-rejected'): void {
  const binding = record(value) as (RecordValue & Partial<Binding>) | undefined;
  if (!binding || binding.source === 'fixed' || typeof binding.path !== 'string') return;
  try { validateBindingPath(binding.path); }
  catch { context.add({ code: 'invalid-binding-path', message: 'Binding path is invalid.', nodeId: id, path }); }
  if (binding.source === 'input' && binding.path.length > 0) {
    const key = binding.path.split('.')[0]!;
    if (!context.declared.has(key)) context.add({ code: 'undeclared-input', message: 'Input binding references an undeclared Workflow input.', nodeId: id, path });
  }
  if (binding.source !== 'node' || typeof binding.nodeId !== 'string' || !id) return;
  if (!context.known.has(binding.nodeId)) {
    context.add({ code: 'unknown-node-binding', message: 'Node binding references an unknown node.', nodeId: id, path });
  } else if (binding.nodeId === id ? self === 'self-rejected' : !walk([id], context.graph.reverse).has(binding.nodeId)) {
    context.add({ code: 'non-predecessor-binding', message: 'Node binding must reference a reachable predecessor.', nodeId: id, path });
  }
}

function addNodeBindingIssues(node: WorkflowNode, nodeIndex: number, context: BindingCheckContext): void {
  const value = record(node);
  const config = record(value?.config);
  const id = nodeId(node);
  const base = `nodes.${nodeIndex}.config`;
  if (value?.type === 'employee') {
    for (const key of ['employee', 'engine', 'model', 'effort']) checkBinding(config?.[key], `${base}.${key}`, id, context);
    const continued = record(config?.continueFrom)?.nodeId;
    if (typeof continued === 'string' && !context.known.has(continued)) context.add({ code: 'unknown-continue-node', message: 'Continuation references an unknown node.', nodeId: id, path: `${base}.continueFrom.nodeId` });
  } else if (value?.type === 'workflow-call') {
    for (const key of ['workflowId', 'items', 'concurrency']) checkBinding(config?.[key], `${base}.${key}`, id, context);
    for (const [key, binding] of Object.entries(record(config?.input) ?? {})) checkBinding(binding, `${base}.input.${key}`, id, context);
    const continueWhile = record(config?.iterate)?.continueWhile;
    for (const [index, predicate] of (Array.isArray(continueWhile) ? continueWhile : []).entries()) {
      const itemPath = `${base}.iterate.continueWhile.${index}`;
      checkBinding(record(predicate)?.left, `${itemPath}.left`, id, context, 'self-allowed');
      checkBinding(record(predicate)?.right, `${itemPath}.right`, id, context, 'self-allowed');
    }
  } else if (value?.type === 'condition') {
    const cases = Array.isArray(config?.cases) ? config.cases : [];
    for (const [caseIndex, item] of cases.entries()) {
      const predicates = Array.isArray(record(item)?.all) ? record(item)!.all as unknown[] : [];
      for (const [predicateIndex, predicate] of predicates.entries()) {
        const itemPath = `${base}.cases.${caseIndex}.all.${predicateIndex}`;
        checkBinding(record(predicate)?.left, `${itemPath}.left`, id, context);
        checkBinding(record(predicate)?.right, `${itemPath}.right`, id, context);
      }
    }
  } else if (value?.type === 'approval') checkBinding(config?.approver, `${base}.approver`, id, context);
  else if (value?.type === 'wait' && config?.mode === 'until') checkBinding(config.timestamp, `${base}.timestamp`, id, context);
  else if (value?.type === 'end') checkBinding(config?.output, `${base}.output`, id, context);
}

function addBindingIssues(definition: WorkflowDefinition, nodes: WorkflowNode[], graph: Graph, add: AddIssue): void {
  const rawInputs = record(definition)?.inputs;
  const declared = new Set((Array.isArray(rawInputs) ? rawInputs : [])
    .map((item) => record(item)?.key).filter((key): key is string => typeof key === 'string'));
  const known = new Set(nodes.map(nodeId).filter((id): id is string => id !== undefined));
  const context = { declared, graph, known, add };
  for (const [nodeIndex, node] of nodes.entries()) addNodeBindingIssues(node, nodeIndex, context);
}

function inspectEdges(nodes: WorkflowNode[], edges: WorkflowEdge[], add: AddIssue): ValidEdge[] {
  const byId = new Map(nodes.map((node) => [nodeId(node), node]).filter((item): item is [string, WorkflowNode] => item[0] !== undefined));
  const routes = new Set<string>();
  const ordinaryIncoming = new Set<string>();
  const valid: ValidEdge[] = [];
  for (const [edgeIndex, edge] of edges.entries()) {
    const part = edgeParts(edge);
    if (!part) continue;
    const source = byId.get(part.fromId);
    const target = byId.get(part.toId);
    if (!source) add({ code: 'unknown-source-node', message: 'Edge source must reference an existing node.', nodeId: part.fromId, edgeId: part.id });
    if (!target) add({ code: 'unknown-target-node', message: 'Edge target must reference an existing node.', nodeId: part.toId, edgeId: part.id });
    const sourcePortValid = source ? portsOf(source).includes(part.fromPort) : false;
    if (source && !sourcePortValid) add({ code: 'invalid-source-port', message: 'Edge source port is not available on its source node.', nodeId: part.fromId, edgeId: part.id });
    const targetPortValid = part.toPort === 'input';
    if (!targetPortValid) add({ code: 'invalid-target-port', message: 'Edge target port must be input.', nodeId: part.toId, edgeId: part.id });
    if (record(source)?.type === 'end') add({ code: 'end-outgoing', message: 'End nodes cannot have outgoing edges.', nodeId: part.fromId, edgeId: part.id });
    if (!source || !target || !sourcePortValid || !targetPortValid) continue;
    const route = JSON.stringify([part.fromId, part.fromPort, part.toId, part.toPort]);
    if (routes.has(route)) {
      add({ code: 'duplicate-edge', message: 'Edge duplicates an earlier authored route.', nodeId: part.fromId, edgeId: part.id });
      continue;
    }
    routes.add(route);
    const targetType = record(target)?.type;
    if (targetType === 'trigger') {
      add({ code: 'trigger-incoming', message: 'Trigger nodes cannot have incoming edges.', nodeId: part.toId, edgeId: part.id });
      continue;
    }
    if (targetType !== 'merge' && ordinaryIncoming.has(part.toId)) {
      add({ code: 'multiple-incoming', message: 'Node accepts at most one incoming edge.', nodeId: part.toId, edgeId: part.id });
      continue;
    }
    if (targetType !== 'merge') ordinaryIncoming.add(part.toId);
    valid.push({ ...part, edgeIndex, source, target });
  }
  return valid;
}

function buildGraph(nodes: WorkflowNode[], edges: ValidEdge[]): Graph {
  const ids = nodes.map(nodeId).filter((id): id is string => id !== undefined);
  const outgoing = new Map(ids.map((id) => [id, [] as ValidEdge[]]));
  const incoming = new Map(ids.map((id) => [id, [] as ValidEdge[]]));
  const forward = new Map(ids.map((id) => [id, [] as string[]]));
  const reverse = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    outgoing.get(edge.fromId)?.push(edge);
    incoming.get(edge.toId)?.push(edge);
    forward.get(edge.fromId)?.push(edge.toId);
    reverse.get(edge.toId)?.push(edge.fromId);
  }
  return { outgoing, incoming, forward, reverse };
}

function walk(starts: string[], links: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const stack = [...starts].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const next = links.get(id) ?? [];
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  return visited;
}

function addCycleIssues(nodes: WorkflowNode[], graph: Graph, add: AddIssue): void {
  const color = new Map<string, 0 | 1 | 2>();
  for (const node of nodes) {
    const start = nodeId(node);
    if (!start || color.has(start)) continue;
    color.set(start, 1);
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const edges = graph.outgoing.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const edge = edges[frame.next++]!;
      if (color.get(edge.toId) === 1) add({ code: 'cycle', message: 'Workflow graph must not contain directed cycles.', nodeId: edge.toId, edgeId: edge.id });
      else if (!color.has(edge.toId)) {
        color.set(edge.toId, 1);
        stack.push({ id: edge.toId, next: 0 });
      }
    }
  }
}

function addCardinalityIssues(nodes: WorkflowNode[], graph: Graph, add: AddIssue): void {
  for (const node of nodes) {
    const id = nodeId(node);
    if (!id) continue;
    const incoming = graph.incoming.get(id) ?? [];
    const type = record(node)?.type;
    if (type === 'merge' && new Set(incoming.map((edge) => edge.fromId)).size < 2) {
      add({ code: 'merge-predecessors', message: 'Merge nodes require at least two distinct predecessor nodes.', nodeId: id });
    }
  }
}

function addReachabilityIssues(nodes: WorkflowNode[], graph: Graph, add: AddIssue): void {
  const triggers = nodes.filter((node): node is Extract<WorkflowNode, { type: 'trigger' }> => node.type === 'trigger');
  const triggerIds = triggers.map(nodeId).filter((id): id is string => id !== undefined);
  const endIds = nodes.filter((node) => record(node)?.type === 'end').map(nodeId).filter((id): id is string => id !== undefined);
  if (triggers.length === 0) add({ code: 'trigger-count', message: 'Workflow must contain at least one Trigger.' });
  const triggerKinds = new Set<string>();
  for (const trigger of triggers) {
    if (triggerKinds.has(trigger.config.kind)) {
      add({ code: 'duplicate-trigger-kind', message: `Workflow must contain at most one ${trigger.config.kind} Trigger.`, nodeId: trigger.id });
    }
    triggerKinds.add(trigger.config.kind);
  }
  const reachable = walk(triggerIds, graph.forward);
  const reachesEnd = walk(endIds, graph.reverse);
  if (!endIds.some((id) => reachable.has(id))) add({ code: 'missing-end-path', message: 'A Trigger must have a directed path to an End.' });
  for (const node of nodes) {
    const id = nodeId(node);
    if (!id) continue;
    const type = record(node)?.type;
    if (type !== 'trigger' && !reachable.has(id)) add({ code: 'unreachable-node', message: 'Node is not reachable from a Trigger.', nodeId: id });
    if (type !== 'end' && reachable.has(id) && !reachesEnd.has(id)) add({ code: 'dead-node', message: 'Reachable non-End node has no path to an End.', nodeId: id });
  }
}

function issueRanks<T extends { id?: unknown }>(items: T[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const id = record(item)?.id;
    if (typeof id === 'string' && !ranks.has(id)) ranks.set(id, index);
  }
  return ranks;
}

function finalizeIssues(issues: WorkflowValidationIssue[], nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowValidationIssue[] {
  const nodeRanks = issueRanks(nodes as Array<{ id?: unknown }>);
  const edgeRanks = issueRanks(edges as Array<{ id?: unknown }>);
  const unique = new Map<string, WorkflowValidationIssue>();
  for (const item of issues) {
    const key = JSON.stringify([item.code, item.nodeId ?? null, item.edgeId ?? null, item.path ?? null]);
    if (!unique.has(key)) unique.set(key, item);
  }
  const rank = (value: string | undefined, ranks: Map<string, number>) => value === undefined ? Number.MAX_SAFE_INTEGER : (ranks.get(value) ?? Number.MAX_SAFE_INTEGER);
  return [...unique.values()].sort((left, right) => {
    const leftGlobal = left.nodeId === undefined && left.edgeId === undefined;
    const rightGlobal = right.nodeId === undefined && right.edgeId === undefined;
    return Number(leftGlobal) - Number(rightGlobal)
      || rank(left.nodeId, nodeRanks) - rank(right.nodeId, nodeRanks)
      || rank(left.edgeId, edgeRanks) - rank(right.edgeId, edgeRanks)
      || left.code.localeCompare(right.code)
      || (left.path ?? '').localeCompare(right.path ?? '')
      || left.message.localeCompare(right.message);
  });
}

/** A Schedule trigger declares the same two strings a Cron job does, so Cron's
 *  validator owns them here too — otherwise `z.string()` lets an unparseable
 *  expression become a durable enabled row that only fails when it is armed. */
export function scheduleTriggerIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  for (const node of safeDefinition(definition)?.nodes ?? []) {
    if (node.type !== 'trigger' || node.config.kind !== 'schedule') continue;
    for (const error of validateCronSchedule({ schedule: node.config.cron, timezone: node.config.timezone })) {
      issues.push({ code: 'invalid-schedule', message: error.message, nodeId: node.id,
        path: error.field === 'schedule' ? 'config.cron' : 'config.timezone' });
    }
  }
  return issues;
}

/** `unlabeled` and `label` contradict each other, so a trigger setting both can
 *  never fire. A silently unarmable definition is worse than a rejected save:
 *  nothing distinguishes it from a Todo that simply has not moved yet. */
export function todoTriggerFilterIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  const safe = safeDefinition(definition);
  if (!safe) return [];
  return safe.nodes.flatMap((node, index) => node.type === 'trigger' && node.config.kind === 'todo-status'
    && node.config.unlabeled !== undefined && node.config.label !== undefined
    ? [{
        code: 'conflicting-todo-filters',
        message: 'A todo-status trigger cannot set both unlabeled and label: a Todo carrying no labels can never carry the one named. Set only one.',
        nodeId: node.id,
        path: `nodes.${index}.config.unlabeled`,
      }]
    : []);
}

/** A `todo-comment` Wait resumes on a comment on the run's bound Todo, and only
 *  some Trigger kinds can bind one. `schedule` and `event` never do, so a node
 *  they alone can reach could only ever time out — refused here rather than at
 *  the run, where the operator sees it days later. A node no Trigger reaches
 *  yet is a mid-edit draft and stays saveable; the `unreachable-node` rule owns
 *  that case. */
export function todoCommentWaitTriggerIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  const safe = safeDefinition(definition);
  if (!safe) return [];
  const nodes = nodesOf(safe);
  const graph = buildGraph(nodes, inspectEdges(nodes, edgesOf(safe), () => {}));
  const bindsTodo = new Map(nodes.filter((node) => node.type === 'trigger')
    .map((node) => [node.id, node.config.kind !== 'schedule' && node.config.kind !== 'event']));
  const issues: WorkflowValidationIssue[] = [];
  for (const [index, node] of nodes.entries()) {
    if (node.type !== 'wait' || node.config.mode !== 'todo-comment') continue;
    const reaching = [...walk([node.id], graph.reverse)].filter((id) => bindsTodo.has(id));
    if (reaching.length === 0 || reaching.some((id) => bindsTodo.get(id))) continue;
    issues.push({ code: 'todo-comment-wait-trigger',
      message: 'A Wait node that waits for a Todo comment must be reachable from a Trigger that binds a Todo.',
      nodeId: node.id, path: `nodes.${index}.config.mode` });
  }
  return issues;
}

export function validateExecutableWorkflow(definition: WorkflowDefinition): { ok: boolean; issues: WorkflowValidationIssue[] } {
  const safe = safeDefinition(definition);
  if (!safe) return {
    ok: false,
    issues: [{ code: 'invalid-definition', message: INVALID_DEFINITION_MESSAGE }],
  };
  const nodes = nodesOf(safe);
  const edges = edgesOf(safe);
  const collected: WorkflowValidationIssue[] = [];
  const add: AddIssue = (item) => { collected.push(item); };
  addConditionIssues(nodes, add);
  const validEdges = inspectEdges(nodes, edges, add);
  const graph = buildGraph(nodes, validEdges);
  addBindingIssues(safe, nodes, graph, add);
  addCycleIssues(nodes, graph, add);
  addCardinalityIssues(nodes, graph, add);
  addReachabilityIssues(nodes, graph, add);
  for (const item of [scheduleTriggerIssues(safe), todoTriggerFilterIssues(safe), workflowCallSaveIssues(safe),
    workflowCallIterationIssues(safe), todoCommentWaitTriggerIssues(safe), endRequirementIssues(safe)].flat()) add(item);
  const issues = finalizeIssues(collected, nodes, edges);
  return { ok: issues.length === 0, issues };
}

export function topologicalOrder(definition: WorkflowDefinition): string[] {
  const safe = safeDefinition(definition);
  if (!safe) throw new Error(INVALID_DEFINITION_MESSAGE);
  const nodes = nodesOf(safe);
  const edges = edgesOf(safe);
  const ids = nodes.map(nodeId);
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) throw new Error(REFERENCE_MESSAGE);
  const authored = new Map((ids as string[]).map((id, index) => [id, index]));
  const outgoing = new Map((ids as string[]).map((id) => [id, [] as string[]]));
  const indegree = new Map((ids as string[]).map((id) => [id, 0]));
  for (const edge of edges) {
    const part = edgeParts(edge);
    if (!part || !authored.has(part.fromId) || !authored.has(part.toId)) throw new Error(REFERENCE_MESSAGE);
    outgoing.get(part.fromId)!.push(part.toId);
    indegree.set(part.toId, indegree.get(part.toId)! + 1);
  }
  const ready = (ids as string[]).filter((id) => indegree.get(id) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id)!) {
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort((left, right) => authored.get(left)! - authored.get(right)!);
      }
    }
  }
  if (ordered.length !== nodes.length) throw new Error(CYCLE_MESSAGE);
  return ordered;
}
