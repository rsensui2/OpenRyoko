import { jsonValueSchema, nodeIdSchema, workflowIdSchema, type JsonValue } from "./model.js";
import { WorkflowRepositoryError } from "./repository.js";
import type { WorkflowCallInput } from "./service.js";

/**
 * Shape guards for the Workflow service's public methods: whether a caller's
 * argument is a Workflow input at all. Pure and decision-free — what the
 * service then DOES with a valid input stays in the service.
 */

export function fail(code: "bad-input" | "not-found", message: string): never {
  throw new WorkflowRepositoryError(code, message);
}

export function boundedRecord(value: unknown, subject: string): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    fail("bad-input", `${subject} must be a JSON object.`);
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 64 * 1024) fail("bad-input", `${subject} is too large.`);
  return parsed.data as Record<string, JsonValue>;
}

export function callerIdentity(value: unknown): value is WorkflowCallInput["caller"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return workflowIdSchema.safeParse(record.workflowId).success
    && typeof record.runId === "string" && /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.runId)
    && nodeIdSchema.safeParse(record.nodeId).success;
}
