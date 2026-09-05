import { z } from 'zod';
import { nodeFallbackSchema } from './engine-chain.js';
import { jsonValueSchema, normalizedSchema, pathSegmentSchema } from './json-schema.js';
import type { JsonValue } from './json-schema.js';
import { triggerConfigSchema } from './trigger-config-schema.js';

export { jsonValueSchema } from './json-schema.js';
export type { JsonPrimitive, JsonValue } from './json-schema.js';

const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
/** A round costs a whole child run, so the ceiling is deliberately low: past
 *  this an author wants a different Workflow, not a longer loop. It also keeps
 *  an iterating node inside the reconcile budget in `runner.ts`. */
export const MAX_ITERATION_ROUNDS = 20;
const SOURCE_ROOT_SEGMENTS = new Set(['input', 'trigger', 'run', 'nodes']);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const finiteNumberSchema = z.number().finite();
export const workflowIdSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'Invalid workflow ID')
  .refine((id) => id !== 'events', 'Reserved workflow ID');
export const nodeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Invalid node ID');
const promptSchema = z.string().refine((value) => utf8Bytes(value) <= MAX_PROMPT_BYTES, 'Prompt must be at most 32 KiB');
const edgeIdSchema = z.string().min(1).max(128);
const portSchema = z.string().min(1);

const bindingPathSchema = z.string().min(1).max(256).superRefine((path, context) => {
  const segments = path.split('.');
  if (segments.length > 16) context.addIssue({ code: 'custom', message: 'Binding path may contain at most 16 segments' });
  if (segments.length > 1 && SOURCE_ROOT_SEGMENTS.has(segments[0]!)) {
    context.addIssue({ code: 'custom', message: 'Binding paths are relative to their source' });
  }
  for (const [index, segment] of segments.entries()) {
    const result = pathSegmentSchema.safeParse(segment);
    if (!result.success) context.addIssue({ code: 'custom', message: result.error.issues[0]!.message, path: [index] });
  }
});

function bindingWithFixed<T extends z.ZodType>(fixedValueSchema: T) {
  return z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('fixed'), value: fixedValueSchema }),
    z.strictObject({ source: z.literal('input'), path: bindingPathSchema }),
    z.strictObject({ source: z.literal('trigger'), path: bindingPathSchema }),
    z.strictObject({ source: z.literal('run'), path: bindingPathSchema }),
    z.strictObject({ source: z.literal('node'), nodeId: nodeIdSchema, path: bindingPathSchema }),
  ]);
}

export const bindingSchema = bindingWithFixed(jsonValueSchema);
const stringBindingSchema = bindingWithFixed(z.string());
const effortBindingSchema = bindingWithFixed(z.enum(['low', 'medium', 'high', 'xhigh']));
const concurrencySchema = finiteNumberSchema.int().min(1).max(16);
type InferredBinding = z.infer<typeof bindingSchema>;
export type Binding<T extends JsonValue = JsonValue> =
  | (Omit<Extract<InferredBinding, { source: 'fixed' }>, 'value'> & { value: T })
  | Exclude<InferredBinding, { source: 'fixed' }>;
const workflowOutputFieldSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean', 'string[]', 'attachment', 'attachment[]']),
  required: z.boolean(),
  description: z.string().optional(),
});
const workflowOutputSchema = z.strictObject({
  fields: z.record(pathSegmentSchema, workflowOutputFieldSchema),
  allowAdditionalFields: z.boolean(),
});
const workflowRetrySchema = z.strictObject({
  attempts: z.number().int().min(1).max(5),
  delaySeconds: finiteNumberSchema.int().nonnegative(),
  backoff: z.enum(['fixed', 'exponential']),
});
const triggerNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('trigger'),
  name: z.string().min(1).max(80),
  config: triggerConfigSchema,
});
const employeeNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('employee'),
  name: z.string().min(1).max(80),
  config: z.strictObject({
    employee: stringBindingSchema,
    prompt: promptSchema,
    /** Continue the engine session of a completed attempt of `nodeId` instead of dispatching cold; naming this node itself continues its own previous run for the same Todo. Its `prompt` replaces the one above whenever a continuation is found, so it carries the delta rather than the whole brief. */
    continueFrom: z.strictObject({ nodeId: nodeIdSchema, prompt: promptSchema }).optional(),
    engine: stringBindingSchema.optional(), model: stringBindingSchema.optional(), effort: effortBindingSchema.optional(), fallback: nodeFallbackSchema.optional(),
    output: workflowOutputSchema.optional(), retry: workflowRetrySchema.optional(), timeoutMinutes: finiteNumberSchema.int().min(1).max(1440).optional(), mutex: z.string().min(1).max(60).optional(), // one live node at a time per mutex key, held only while a node run carrying it is live (node-mutex.ts)
  }),
});
const conditionPredicateSchema = z.strictObject({
  left: bindingSchema,
  operator: z.enum(['equals', 'not-equals', 'exists', 'not-exists', 'contains', 'gt', 'gte', 'lt', 'lte', 'in']),
  right: bindingSchema.optional(),
});
const workflowIterationSchema = z.strictObject({
  /** The ceiling on rounds, and the whole reason iteration is safe to have. A
   *  literal, never a binding: a number that only exists once the run is under
   *  way is not a bound anyone can read off the definition. Optional here only
   *  so that omitting it still parses and so reaches `validateExecutableWorkflow`,
   *  which rejects it as `unbounded-iteration` naming the node — a definition
   *  that fails to parse can only say "invalid". */
  maxRounds: z.number().int().min(1).max(MAX_ITERATION_ROUNDS).optional(),
  /** Another round runs only while every predicate holds against the round that
   *  just finished. While these are read the node stands for its own latest
   *  round, so `{ source: 'node', nodeId: <this node> }` asks what it returned. */
  continueWhile: z.array(conditionPredicateSchema).min(1).max(10),
});
const workflowCallNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('workflow-call'),
  name: z.string().min(1).max(80),
  config: z.strictObject({
    workflowId: stringBindingSchema,
    items: bindingSchema.optional(),
    input: z.record(pathSegmentSchema, bindingSchema).optional(),
    concurrency: z.union([concurrencySchema, bindingWithFixed(concurrencySchema)]).default(2), // children at once: a number, or a binding a planner node fills in; clamped at run time by `systemConcurrencyCeiling` (capacity.ts)
    /** Call the target again, up to `maxRounds` times, while the round that just
     *  finished still asks for another. Each round is its own child run, so it
     *  keeps its own status, output and sessions. Mutually exclusive with `items`:
     *  fan-out is width decided up front, iteration is depth decided as it goes. */
    iterate: workflowIterationSchema.optional(),
  }),
});
const conditionCaseSchema = z.strictObject({
  port: portSchema,
  label: z.string(),
  all: z.array(conditionPredicateSchema).max(10),
});
const conditionConfigSchema = z.strictObject({
  cases: z.array(conditionCaseSchema).max(10),
  defaultPort: portSchema,
}).superRefine((config, context) => {
  const ports = new Set<string>();
  for (const [index, item] of config.cases.entries()) {
    if (ports.has(item.port)) context.addIssue({ code: 'custom', message: 'Duplicate Condition port', path: ['cases', index, 'port'] });
    ports.add(item.port);
  }
  if (ports.has(config.defaultPort)) context.addIssue({ code: 'custom', message: 'Condition default port must be unique', path: ['defaultPort'] });
});
const conditionNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('condition'),
  name: z.string().min(1).max(80),
  config: conditionConfigSchema,
});
const mergeNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('merge'),
  name: z.string().min(1).max(80),
  config: z.strictObject({ mode: z.literal('wait-all') }),
});
const approvalNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('approval'),
  name: z.string().min(1).max(80),
  config: z.strictObject({
    description: z.string(),
    approver: stringBindingSchema.optional(),
    // Reserves the gate for the human operator. Default routing sends an
    // approval up the org hierarchy to its root, which means the COO can
    // approve a pipeline the COO started — fine for ordinary gates, a
    // governance hole for one that authorizes something irreversible.
    operatorOnly: z.boolean().optional(),
    // Variant-picking: the labels mirror onto the bound Todo's approval and the
    // pick reads back as `{{ node.<id>.choice }}`. Fixed labels, not bindings, and
    // trimmed as the mirror trims — two spellings is a gate neither door can decide.
    options: z.array(z.string().trim().min(1).max(80)).min(2).max(8)
      .refine((values) => new Set(values).size === values.length, 'Approval options must be unique').optional(),
  }).refine((config) => !(config.operatorOnly && config.approver !== undefined),
    'An operator-only approval cannot also name an approver.'),
});
const waitConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('duration'), minutes: finiteNumberSchema.int().min(1).max(43_200) }),
  z.strictObject({ mode: z.literal('until'), timestamp: stringBindingSchema }),
  // Parks a Todo-bound run until the operator comments on that Todo. The
  // timeout is a ceiling, not a schedule: a reply resumes the node early, and
  // the default gives a conversation a working week to happen in.
  z.strictObject({ mode: z.literal('todo-comment'),
    timeoutMinutes: finiteNumberSchema.int().min(1).max(43_200).default(10_080) }),
]);
const waitNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('wait'),
  name: z.string().min(1).max(80),
  config: waitConfigSchema,
});
/** What a success End demands of the work it authorizes before a bound Todo may close: the output field the named node has to have reported the landed commit in, and optionally the node field naming the checkout that commit must be on `main` in. Reaching an End is not evidence that anything landed; this is. */
const landingRequirementSchema = z.strictObject({ nodeId: nodeIdSchema, field: pathSegmentSchema, commitIn: z.strictObject({ nodeId: nodeIdSchema, field: pathSegmentSchema }).optional() });
const endNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('end'),
  name: z.string().min(1).max(80),
  config: z.strictObject({ result: z.enum(['success', 'failure']), message: z.string().optional(), output: bindingSchema.optional(), requires: landingRequirementSchema.optional() }),
});
const rawWorkflowNodeSchema = z.discriminatedUnion('type', [
  triggerNodeSchema,
  employeeNodeSchema,
  workflowCallNodeSchema,
  conditionNodeSchema,
  mergeNodeSchema,
  approvalNodeSchema,
  waitNodeSchema,
  endNodeSchema,
]);
export const workflowNodeSchema = normalizedSchema(rawWorkflowNodeSchema);
const workflowEdgeSchema = z.strictObject({
  id: edgeIdSchema,
  from: z.strictObject({ nodeId: nodeIdSchema, port: portSchema }),
  to: z.strictObject({ nodeId: nodeIdSchema, port: z.literal('input') }),
});
const workflowInputFieldSchema = z.strictObject({
  key: pathSegmentSchema,
  label: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'employee', 'engine', 'model']),
  required: z.boolean(),
  default: z.union([z.string(), finiteNumberSchema, z.boolean(), z.null()]).optional(),
  description: z.string().optional(),
});
const workflowUiSchema = z.strictObject({
  positions: z.record(nodeIdSchema, z.strictObject({ x: finiteNumberSchema, y: finiteNumberSchema })),
  /** Set only by the editor, when a person arranged the canvas. Positions
   *  authored any other way are a guess, so absence means "lay this out". */
  layout: z.literal('manual').optional(),
});
const graphShape = {
  inputs: z.array(workflowInputFieldSchema).optional(),
  nodes: z.array(rawWorkflowNodeSchema).max(100),
  edges: z.array(workflowEdgeSchema).max(300),
  ui: workflowUiSchema.optional(),
} as const;
type GraphValue = {
  inputs?: Array<{ key: string }>;
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string }>;
};

function addDuplicateIssues(value: GraphValue, context: z.RefinementCtx): void {
  for (const [items, label, path] of [
    [value.nodes, 'node ID', 'nodes'],
    [value.edges, 'edge ID', 'edges'],
    [value.inputs ?? [], 'input key', 'inputs'],
  ] as const) {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const key = 'key' in item ? item.key : item.id;
      if (seen.has(key)) context.addIssue({ code: 'custom', message: `Duplicate ${label}: ${key}`, path: [path, index] });
      seen.add(key);
    }
  }
}

function addSizeIssue(value: unknown, context: z.RefinementCtx, label: string): void {
  let bytes: number;
  try {
    bytes = utf8Bytes(JSON.stringify(value));
  } catch {
    context.addIssue({ code: 'custom', message: `${label} must be serializable JSON` });
    return;
  }
  if (bytes > MAX_DEFINITION_BYTES) {
    context.addIssue({ code: 'custom', message: `${label} must be at most 256 KiB` });
  }
}

const rawWorkflowDraftSchema = z.strictObject(graphShape).superRefine((value, context) => {
  addDuplicateIssues(value, context);
  addSizeIssue(value, context, 'Workflow draft');
});
export const workflowDraftSchema = normalizedSchema(rawWorkflowDraftSchema);

const rawWorkflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: workflowIdSchema,
  title: z.string().min(1).max(120),
  description: z.string().optional(),
  revision: z.number().int().min(1),
  enabled: z.boolean(),
  retiredAt: z.string().optional(),
  ...graphShape,
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((value, context) => {
  addDuplicateIssues(value, context);
  if (value.enabled && value.retiredAt !== undefined) {
    context.addIssue({ code: 'custom', message: 'A retired Workflow cannot be enabled', path: ['enabled'] });
  }
  addSizeIssue(value, context, 'Workflow definition');
});
export const workflowDefinitionSchema = normalizedSchema(rawWorkflowDefinitionSchema);

export type WorkflowOutputSchema = z.infer<typeof workflowOutputSchema>;
export type WorkflowInputField = z.infer<typeof workflowInputFieldSchema>;
export type TriggerNode = z.infer<typeof triggerNodeSchema>;
export type EmployeeNode = z.infer<typeof employeeNodeSchema>;
export type WorkflowCallNode = z.infer<typeof workflowCallNodeSchema>;
export type ConditionPredicate = z.infer<typeof conditionPredicateSchema>;
export type WorkflowIteration = z.infer<typeof workflowIterationSchema>;
export type ConditionNode = z.infer<typeof conditionNodeSchema>;
export type MergeNode = z.infer<typeof mergeNodeSchema>;
export type ApprovalNode = z.infer<typeof approvalNodeSchema>;
export type WaitNode = z.infer<typeof waitNodeSchema>;
export type EndNode = z.infer<typeof endNodeSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowId = WorkflowDefinition['id'];

export interface WorkflowNodeOutput {
  text: string;
  fields: Record<string, JsonValue>;
  /** The option picked on an Approval node that offered a choice — read
   *  downstream as `{{ node.<approvalNodeId>.choice }}`. */
  choice?: string;
  employeeId?: string;
  engine?: string;
  model?: string;
  sessionId?: string;
}
