import type { EngineRunOpts, StreamDelta } from "../shared/types.js";

/**
 * Antigravity CLI (`agy`) print mode, stream-JSON on both sides.
 *
 * In:  one NDJSON line per turn — `{"event":"user","message":{"content":…}}`.
 * Out: `init` (carries the conversation id), `step_update` (tool progress) and
 *      a single terminal `result` with `status` SUCCESS or ERROR.
 *
 * Ported from upstream jinn's antigravity-headless-protocol.
 */

/**
 * How long a turn may run. agy's print mode has its own wall
 * (`--print-timeout`, default 5m), so the same number is passed down and the
 * two can never disagree about when a turn has gone too long.
 */
export const ANTIGRAVITY_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface AntigravityParsedLine {
  conversationId?: string;
  deltas: StreamDelta[];
  terminal: boolean;
  result?: string;
  error?: string;
  contextTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function resultContextTokens(result: Record<string, unknown>): number | undefined {
  const inputTokens = asRecord(result.usage)?.input_tokens;
  return typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens > 0
    ? inputTokens
    : undefined;
}

function parseToolUpdate(event: Record<string, unknown>): AntigravityParsedLine | null {
  const update = asRecord(event.step_update);
  if (!update || update.step_type !== "tool") return null;
  const toolName = nonEmptyString(update.tool_name) ?? "tool";
  const toolId = typeof update.step_index === "number" ? String(update.step_index) : undefined;
  const base = { conversationId: nonEmptyString(update.conversation_id), terminal: false };
  if (update.state === "ACTIVE") {
    return { ...base, deltas: [{ type: "tool_use", content: `Using ${toolName}`, toolName, toolId }] };
  }
  if (update.state !== "DONE") return null;
  const failed = asRecord(asRecord(update.tool_info)?.error) !== null;
  return {
    ...base,
    deltas: [{ type: "tool_result", content: `${toolName} ${failed ? "failed" : "done"}`, toolName, toolId }],
  };
}

function parseResult(event: Record<string, unknown>): AntigravityParsedLine | null {
  const result = asRecord(event.result);
  if (!result || (result.status !== "SUCCESS" && result.status !== "ERROR")) return null;
  const contextTokens = resultContextTokens(result);
  const common = {
    conversationId: nonEmptyString(result.conversation_id),
    deltas: contextTokens ? [{ type: "context" as const, content: String(contextTokens) }] : [],
    terminal: true,
    ...(contextTokens ? { contextTokens } : {}),
  };
  if (result.status === "SUCCESS") {
    return { ...common, result: typeof result.response === "string" ? result.response : "" };
  }
  return { ...common, error: nonEmptyString(result.error) ?? "Antigravity turn failed" };
}

export function buildAntigravityArgs(opts: EngineRunOpts): string[] {
  return [
    ...(opts.resumeSessionId ? ["--conversation", opts.resumeSessionId] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effortLevel && opts.effortLevel !== "default" ? ["--effort", opts.effortLevel] : []),
    "--dangerously-skip-permissions",
    // --chrome is a Claude Code flag; agy rejects unknown flags.
    ...(opts.cliFlags ?? []).filter((flag) => flag !== "--chrome"),
    "--print-timeout", `${ANTIGRAVITY_TURN_TIMEOUT_MS / 1000}s`,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  ];
}

/** The single stdin line that carries the turn's prompt. */
export function antigravityUserLine(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

export function parseAntigravityStreamLine(line: string): AntigravityParsedLine | null {
  const event = parseJsonRecord(line);
  if (!event) return null;
  if (event.event === "init") {
    return { conversationId: nonEmptyString(event.conversation_id), deltas: [], terminal: false };
  }
  if (event.event === "step_update") return parseToolUpdate(event);
  if (event.event === "result") return parseResult(event);
  return null;
}
