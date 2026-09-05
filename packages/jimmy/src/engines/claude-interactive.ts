import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, EngineRateLimitInfo, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";
import { writeSessionSettings } from "../shared/claude-settings.js";
import { awaitFreshClaudeCredentials } from "../shared/claude-oauth-gate.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts } from "./pty-view-engine.js";
import { ptySnapshotStore } from "./pty-snapshot.js";
import { chooseApproval, keystrokesToSelect, parsePermissionPrompt, terminalTextLines } from "./claude-permission-prompt.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
import { SsePtyProxy, type SseDataEvent, type StreamCtx } from "./sse-pty-proxy.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";

export type { PtyControlEvent } from "./pty-view-engine.js";

interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
}

interface TranscriptUsage { inputTokens: number; outputTokens: number; cacheTokens: number; assistantTurns: number; model?: string; }

// Config stores short aliases (opus/sonnet/haiku); the CLI resolves them to
// concrete ids. When the transcript doesn't carry a model id we fall back to
// this map so pricing keys line up with MODEL_PRICES instead of DEFAULT_PRICE.
const CLAUDE_ALIAS_TO_ID: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

function resolveClaudeModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return CLAUDE_ALIAS_TO_ID[model] ?? model;
}

// $/million tokens. Conservative defaults. Older model ids kept so cost can still
// be reconstructed when resuming historical transcripts.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  // https://platform.claude.com/docs/en/models/fable-5-1/overview
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

export function sumTranscriptUsage(content: string, afterMs?: number): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0 };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      // A cumulative transcript may contain every prior turn. Untimestamped
      // lines cannot safely be attributed to the current turn.
      if (ts === undefined || ts < afterMs) continue;
    }
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
    // Concrete model id (e.g. "claude-sonnet-5") emitted by the CLI — the most
    // reliable pricing key. Last one wins if it ever changes mid-session.
    const m = msg?.message?.model;
    if (typeof m === "string" && m) u.model = m;
  }
  return u;
}

/** Most recent turn's input-context size (input + cache-read + cache-creation
 *  tokens) from the transcript — how full the window is. Undefined if no usage. */
function lastTurnContextTokens(transcriptPath: string): number | undefined {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: number | undefined;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const u = msg?.message?.usage;
    if (!u) continue;
    last = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  }
  return last && last > 0 ? last : undefined;
}

export function computeInteractiveCost(transcriptPath: string, model?: string, afterMs?: number): { cost: number; turns: number } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content, afterMs);
  if (u.assistantTurns === 0) return null;
  // Prefer the concrete id from the transcript; fall back to resolving the
  // config alias (opus/sonnet/haiku) so Sonnet/Haiku aren't priced as Opus.
  const modelId = u.model ?? resolveClaudeModelId(model);
  const price = (modelId && MODEL_PRICES[modelId]) || DEFAULT_PRICE;
  const cost = (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out;
  return { cost, turns: u.assistantTurns };
}

/** Claude Code stores per-project transcripts at
 *  ~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl, where the slug is the
 *  cwd with every "/" and "." replaced by "-". Derive that path; fall back to a
 *  scan across project dirs if the slug heuristic misses (defensive). Exported
 *  for the transcript-recovery unit test. (Ported from upstream jinn.) */
export function findTranscriptForSession(
  claudeSessionId: string,
  homeDir: string = JINN_HOME,
  projectsDir: string = path.join(os.homedir(), ".claude", "projects"),
): string | undefined {
  if (!claudeSessionId) return undefined;
  const slug = homeDir.replace(/[/.]/g, "-");
  const direct = path.join(projectsDir, slug, `${claudeSessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* projects dir missing — nothing to recover */ }
  return undefined;
}

function transcriptLineTimestampMs(msg: any): number | undefined {
  const raw = msg?.timestamp ?? msg?.created_at ?? msg?.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Last assistant text block from a Claude transcript — the turn's final
 *  message. Used to recover result text when the Stop hook (which normally
 *  carries last_assistant_message) was lost (gateway restart deleting
 *  gateway.json mid-turn, PTY crash, or relay drop), so the reply shows real
 *  output instead of "(no output)". Exported for tests. */
export function lastAssistantTextFromTranscript(transcriptPath: string, afterMs?: number): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      if (ts === undefined || ts < afterMs) continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
    if (text.trim()) last = text;
  }
  return last;
}

/** Strip model reasoning blocks that occasionally leak into
 *  last_assistant_message / transcript text — they are never user-facing. */
export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/```(?:thinking|reasoning|thought)\b[\s\S]*?```/gi, "")
    .trim();
}

/** Suggested next-user turns are model metadata, not operator instructions.
 * Strip them before storage or relay while preserving any genuine answer that
 * appears before or after the block. */
export function stripSuggestionBlocks(text: string): string {
  return text
    .replace(/<\s*suggestion\b[^>]*>[\s\S]*?<\s*\/\s*suggestion\s*>/gi, "")
    .replace(/<\s*suggestion\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\s*s(?:u(?:g(?:g(?:e(?:s(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?)?)?$/i, "")
    .trim();
}

export function sanitizeAssistantText(text: string): string {
  return stripSuggestionBlocks(stripReasoningBlocks(text));
}

/**
 * Map a StopFailure hook payload to an EngineRateLimitInfo.
 * Returns null unless the turn failed specifically with error === "rate_limit".
 * The shape matches what ClaudeEngine produces from `rate_limit_event` JSON, so
 * detectRateLimit() / the wait-retry machinery in manager.ts work unchanged.
 * (error_details may carry a reset time, but its format is unconfirmed — left
 * unparsed; manager.ts computes a default backoff when resetsAt is absent.)
 */
function rateLimitFromStopFailure(payload: HookPayload | undefined): EngineRateLimitInfo | null {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  return { status: "rejected", rateLimitType: "interactive_detected" };
}

function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += buildAttachmentSuffix(o.attachments);
  }
  args.push(prompt); // positional — MUST precede variadic --mcp-config

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--disallowedTools", "AskUserQuestion", "ExitPlanMode");
  args.push("--settings", o.settingsPath);
  if (o.cliFlags?.length) args.push(...o.cliFlags);
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  return args;
}

/**
 * Translate one parsed Anthropic SSE `data:` event into StreamDeltas. This is the
 * live streaming source (replacing the old transcript tailer): word-by-word text
 * in true order, tool markers positioned correctly relative to text, and live
 * context tokens from message_start.usage.
 *  - message_start.usage         → `context` (input + cache_read + cache_creation)
 *  - content_block_start tool_use → `tool_use` marker (in-order with text)
 *  - content_block_delta text_delta → incremental `text` (word-by-word)
 * tool_result is NOT in the assistant SSE stream (tools run between messages); the
 * PostToolUse hook supplies that completion marker. input_json_delta / thinking
 * deltas are intentionally not surfaced to the chat pane.
 */
export function sseEventToDeltas(e: SseDataEvent): StreamDelta[] {
  switch (e.type) {
    case "message_start": {
      const u = (e as any).message?.usage;
      if (!u) return [];
      const ctx = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      return ctx > 0 ? [{ type: "context", content: String(ctx) }] : [];
    }
    case "content_block_start": {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use") {
        return [{ type: "tool_use", content: String(cb.name ?? "tool"), toolName: String(cb.name ?? "tool"), toolId: String(cb.id ?? "") }];
      }
      return [];
    }
    case "content_block_delta": {
      const d = (e as any).delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
        return [{ type: "text", content: d.text }];
      }
      return [];
    }
    default:
      return [];
  }
}

const STOP_FAILURE_GRACE_MS = 20_000;
/** StopFailure errors that must settle immediately. Rate-limit/billing/auth
 *  need the manager fallback machinery right away; everything else gets a grace
 *  window because Claude Code can keep working after a sub-agent/API failure.
 *  (Ported from upstream jinn — this is the fix for "a sub-agent's API error
 *  fails the whole turn even though the main agent keeps going".) */
const IMMEDIATE_STOP_FAILURE_ERRORS = new Set(["rate_limit", "billing_error", "authentication_failed", "max_output_tokens"]);

export interface TurnResolverOpts {
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
  /** Test override for the StopFailure grace window (default 20s). */
  stopFailureGraceMs?: number;
  /** While true, a graced StopFailure keeps waiting instead of settling. */
  shouldDeferStopFailure?: () => boolean;
  /** This turn is a Claude-native local command (see isNativeClaudeCommand). Such
   *  commands produce no new assistant message, so a Stop hook's
   *  last_assistant_message is the PREVIOUS turn's stale text — maybeComplete must
   *  settle empty rather than re-persist it as a duplicate. */
  native?: boolean;
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private graceTimer: NodeJS.Timeout | undefined;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      // A Stop supersedes any pending StopFailure — the CLI retried and finished.
      this.clearGrace();
      this.stopFailurePayload = undefined;
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn. In interactive mode the CLI survives
      // invalid_request/server_error/unknown and usually retries — hold the
      // failure in a grace window instead of settling: a later Stop supersedes
      // it, activity re-arms it, the PTY-death watchdog still fails fast.
      // Other error types (rate_limit, billing, auth) settle immediately.
      // numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      if (!IMMEDIATE_STOP_FAILURE_ERRORS.has(String(h.error ?? "unknown"))) {
        this.armGrace();
      } else {
        this.settleWithFailure();
      }
    } else {
      // PreToolUse/PostToolUse/etc — proof of life while a failure is pending.
      this.noteActivity();
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  get isSettled(): boolean { return this.settled; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    // Native local commands (/usage, /limits, …) produce no new assistant
    // message; the Stop hook's last_assistant_message is the prior turn's stale
    // text. Settling with it would persist a duplicate chat echo — settle empty.
    const text = this.opts.native ? "" : sanitizeAssistantText(String(this.stopPayload.last_assistant_message ?? ""));
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    // PTY died while a StopFailure was held in grace — the API error is the
    // real cause; report it instead of the generic "process exited". Other
    // interrupt reasons (user abort, engine switch, shutdown) keep their
    // "Interrupted: …" text so the quiet-interrupt handling downstream engages.
    if (this.stopFailurePayload && !this.settled && reason === "Interrupted: claude process exited") {
      this.settleWithFailure();
      return;
    }
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  /** Settle a native local command (no Stop hook fires for context mutators). */
  completeNativeCommand(): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", numTurns: 1 });
  }

  /** Settle with text recovered from the transcript (the Stop hook was lost). */
  completeRecovered(text: string, sessionId?: string): void {
    if (sessionId && !this.claudeSessionId) this.claudeSessionId = sessionId;
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: sanitizeAssistantText(text), numTurns: 1 });
  }

  /** Proof of life (SSE delta / tool hook) while a StopFailure is pending —
   *  re-arms the grace window. No-op when no failure is pending. */
  noteActivity(): void {
    if (this.graceTimer) this.armGrace();
  }

  private armGrace(): void {
    this.clearGrace();
    const ms = this.opts.stopFailureGraceMs ?? STOP_FAILURE_GRACE_MS;
    this.graceTimer = setTimeout(() => {
      if (this.opts.shouldDeferStopFailure?.()) {
        this.armGrace();
        return;
      }
      this.settleWithFailure();
    }, ms);
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private settleWithFailure(): void {
    this.settle({
      sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
      result: "",
      error: `Interactive turn failed: ${this.stopFailurePayload?.error ?? "unknown"}`,
      numTurns: 1,
    });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.clearGrace();
    this.resolve(r);
  }
}

const NATIVE_COMMAND_QUIET_MS = 1800;
const NATIVE_COMMAND_MIN_MS = 3000;
const NATIVE_COMMAND_MAX_MS = 90_000;
const LOST_STOP_RECOVERY_QUIET_MS = 60_000;
const LOST_STOP_RECOVERY_MIN_MS = 5 * 60_000;
const TURN_STALL_TIMEOUT_MS = 15 * 60_000;
const TURN_STALL_QUIET_MS = 5 * 60_000;

export function shouldSettleStalledTurn(elapsedMs: number, quietMs: number): boolean {
  return elapsedMs >= TURN_STALL_TIMEOUT_MS && quietMs >= TURN_STALL_QUIET_MS;
}

export function isPermissionPromptNotification(hook: HookPayload): boolean {
  return hook.hook_event_name === "Notification" && hook.notification_type === "permission_prompt";
}

export function recoveryBlockedByWork(activeTools: number, permissionPending: boolean, upstreamInflight: boolean): boolean {
  return upstreamInflight || (activeTools > 0 && !permissionPending);
}

/** Success recovery is stricter than eventual stall release: an unanswered
 * permission prompt must never turn preceding narration into a completed turn. */
export function canRecoverLostStop(activeTools: number, permissionPending: boolean, upstreamInflight: boolean): boolean {
  return activeTools === 0 && !permissionPending && !upstreamInflight;
}

const SUBMIT_CONFIRM_INTERVAL_MS = 1500;
const SUBMIT_CONFIRM_ATTEMPTS = 12;
export const SUBMIT_ACK_HOOKS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure"]);

/** Claude Code built-in slash commands that run locally and never produce a new
 *  assistant API turn. Two behaviours, both handled by the native-command path:
 *   - Context mutators (/compact, /clear, /model) end without firing a Stop hook;
 *     the native-command quiet-window timer settles them with an empty result.
 *   - Info/overlay commands (/usage, /limits, /cost, …) DO fire a Stop hook on
 *     dismiss, but its `last_assistant_message` still carries the PREVIOUS turn's
 *     text. Without native classification that stale text was persisted as a new
 *     assistant message — the duplicate-chat-echo bug. native-aware maybeComplete
 *     settles these empty instead.
 *  Only commands that genuinely yield no persistable assistant output belong here:
 *  misclassifying a real-turn command (/init, /review, skill commands) would drop
 *  its answer. */
const NATIVE_CLAUDE_COMMANDS = new Set([
  "/compact", "/clear", "/model",
  "/usage", "/limits", "/cost", "/status", "/config", "/help", "/doctor",
  "/release-notes", "/vim", "/terminal-setup", "/mcp", "/agents", "/permissions",
  "/hooks", "/memory", "/export", "/login", "/logout", "/bug", "/resume",
]);

export function isNativeClaudeCommand(prompt: string): boolean {
  const first = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return first !== undefined && NATIVE_CLAUDE_COMMANDS.has(first);
}

/** Cap for the per-session PTY scrollback ring buffer (xterm.js reconnect replay). */
const SCROLLBACK_CAP_BYTES = 262144;

/** Bracketed-paste `text` into a PTY then submit with CR after a 50ms beat.
 *  Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
 *  they still trigger the slash-command / mention / bash-mode handlers and the
 *  turn is never submitted. neutralizeForPaste() prepends a space for mentions,
 *  bash-mode, and jinn-skill slash commands, while letting engine-native commands
 *  (/compact, /clear, /model, …) pass through raw so the TUI actually runs them.
 *  Shared by injectPrompt() (warm-PTY first turn) and writeStdin() (raw WS input). */
export function buildAttachmentSuffix(attachments: readonly string[]): string {
  return "\n\nAttached files:\n" + attachments.map((attachment) => {
    // Use a code-span delimiter longer than every backtick run in the path.
    // Escaping with a backslash would change the filesystem path seen by the
    // model; a longer delimiter preserves it byte-for-byte.
    const longestRun = Math.max(0, ...(attachment.match(/`+/g) ?? []).map((run) => run.length));
    const delimiter = "`".repeat(longestRun + 1);
    return `- ${delimiter}${attachment}${delimiter}`;
  }).join("\n");
}

export interface SubmitConfirmation {
  submitted: () => boolean;
  busy?: () => boolean;
  intervalMs?: number;
  attempts?: number;
  onRetry?: (attempt: number) => void;
  onUnconfirmed?: (attempts: number) => void;
}

export function pasteAndSubmit(proc: Pick<pty.IPty, "write">, text: string, confirm?: SubmitConfirmation): () => void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~`);
  // 150ms beat (upstream finding): 50ms occasionally raced the TUI's paste
  // handling and the CR landed before the paste was consumed.
  let retryTimer: NodeJS.Timeout | undefined;
  const submitTimer = setTimeout(() => {
    proc.write("\r");
    if (!confirm) return;
    let attempt = 0;
    const maxAttempts = confirm.attempts ?? SUBMIT_CONFIRM_ATTEMPTS;
    retryTimer = setInterval(() => {
      if (confirm.submitted()) {
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = undefined;
        return;
      }
      if (confirm.busy?.()) return;
      if (attempt >= maxAttempts) {
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = undefined;
        confirm.onUnconfirmed?.(attempt);
        return;
      }
      attempt += 1;
      confirm.onRetry?.(attempt);
      proc.write("\r");
    }, confirm.intervalMs ?? SUBMIT_CONFIRM_INTERVAL_MS);
    retryTimer.unref?.();
  }, 150);
  return () => {
    clearTimeout(submitTimer);
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = undefined;
  };
}

export function buildClaudePtyEnv(
  proxyPort?: number,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_BASE_URL") continue;
    if (v !== undefined) env[k] = v;
  }
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
  env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999";
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = sourceEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "1000000";
  if (proxyPort) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
    env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = "1";
  }
  return env;
}

export class InteractiveClaudeEngine implements InterruptibleEngine, PtyViewEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. `boundProc` is the specific
   *  PTY serving this turn (captured at spawn / warm-reuse). A PTY's onExit only
   *  interrupts the active resolver when it IS that bound proc — so a stale PTY
   *  released by a kill->respawn race can't poison the freshly-started turn.
   *  `onStream` is the current turn's delta callback; the per-PTY SSE proxy routes
   *  parsed events here (a PTY outlives its turn, so the proxy looks this up live). */
  private active = new Map<string, { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: pty.IPty; activeTools: number; permissionPromptPending: boolean; permissionTimer?: NodeJS.Timeout; submitConfirmationArmed: boolean; submitAcknowledged: boolean; cancelSubmitConfirm?: () => void }>();
  /** Epoch ms of the most recent PTY output per session — the quiet-window
   *  signal for native-command settle and lost-Stop recovery. */
  private lastOutputAt = new Map<string, number>();
  /** Sessions with an in-flight async idle-spawn (proxy.start awaited) — prevents
   *  a second ensureIdleSpawn from racing in a duplicate PTY during that gap. */
  private idleSpawning = new Set<string>();
  /** Per-session PTY output streams: scrollback ring buffer (chunk list + running byte total)
   *  + live subscribers. Survives PTY respawn. The chunk-list ring avoids the O(N) realloc
   *  that a `(buffer + d).slice(-CAP)` per data event would cause at hot output. */
  private streams = new Map<string, {
    chunks: Buffer[];
    totalBytes: number;
    subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
    /** Set to true the first time a PTY is wired to this stream entry. Subsequent
     *  wires (subscribers attached or not) are PTY respawns — clients need a reset
     *  so their xterm doesn't render the new alt-screen atop the old one's cells. */
    hasSeenPty: boolean;
  }>();
  /** Last terminal geometry reported by the client per session. Used to spawn
   *  follow-up PTYs at the correct dimensions when a turn comes in after the
   *  warm PTY was reaped — otherwise spawn() falls back to 120×40 and the TUI
   *  text body is locked in at the wrong width. */
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  /** Model/effort the live PTY was spawned with, per session. `--model`/`--effort`
   *  apply only at spawn, so a mid-chat switch must cold-respawn rather than reuse
   *  the warm PTY (which would keep running the old model). */
  private spawnParams = new Map<string, { model?: string; effortLevel?: string }>();
  /** PTY handles already torn down by handlePtyDeath(). A socket `error` (EIO) and
   *  the proc's `onExit` can both fire for the same PTY (in either order, or only
   *  one of them), and run()'s warm-reuse guard may also report it dead — so death
   *  handling must be idempotent. Membership = "already handled"; checked first. */
  private deadHandles = new WeakSet<PtyHandle>();

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
    /** Headless `claude -p` engine used as a fallback for remote (sshHost) turns.
     *  A PTY runs Claude locally for the Max subsidy, so it cannot drive a remote
     *  engine over SSH; OpenRyoko's sshHost employees delegate to `-p` instead. */
    private remoteFallback?: InterruptibleEngine,
    /** Hard ceiling on a single turn. The Stop-hook resolution loop has no inherent
     *  timeout, and the proc-exit watchdog only catches a DEAD pty — a pty that hangs
     *  while still alive (e.g. a wedged upstream request, a boot-time race) would
     *  never resolve and would zombie the session as status:"running" forever. This
     *  deadline force-settles such a turn with an error so manager.ts runs its normal
     *  completion/recovery path. Default 90 min — long enough for heavy autonomous
     *  batch runs (e.g. the seminar-demo generator) to complete in a single turn. */
    private turnTimeoutMs = 90 * 60 * 1000,
    private autoApproveSafetyPrompts = false,
  ) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    // Remote (SSH) execution can't use a local PTY — delegate to headless `claude -p`,
    // which OpenRyoko runs over SSH. Falls through to local PTY when no fallback wired.
    if (opts.sshHost && this.remoteFallback) {
      return this.remoteFallback.run(opts);
    }
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      appendSystemPrompt: opts.systemPrompt,
    });

    let warm = this.lifecycle.getWarm(jinnSessionId);
    // Mid-chat model/effort switch: `--model`/`--effort` bind at spawn, so a warm
    // PTY would silently keep the OLD model. If the request differs from what this
    // PTY was spawned with, drop the warm PTY and cold-respawn (--resume keeps the
    // conversation) so the new model/effort actually takes effect.
    if (warm) {
      const prev = this.spawnParams.get(jinnSessionId);
      const norm = (v?: string) => (!v || v === "default" ? "" : v);
      if (prev && (norm(opts.model) !== norm(prev.model) || norm(opts.effortLevel) !== norm(prev.effortLevel))) {
        logger.info(`InteractiveClaudeEngine: model/effort changed for ${jinnSessionId} (model ${prev.model ?? "default"}→${opts.model ?? "default"}, effort ${prev.effortLevel ?? "default"}→${opts.effortLevel ?? "default"}) — cold respawn`);
        this.lifecycle.releaseSession(jinnSessionId);
        warm = undefined;
      }
    }
    const turnStartedAtMs = Date.now();
    // Claude-native local command (/compact, /usage, …): no new assistant turn is
    // produced; completion is detected by output quiet-window, and a Stop hook's
    // stale last_assistant_message must not be persisted as a duplicate reply.
    const nativeCommand = isNativeClaudeCommand(opts.prompt);
    const resolver = new TurnResolver({
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
      // Defer a graced StopFailure while upstream API requests are in flight —
      // a sub-agent's failure must not fail the turn the main agent is still
      // working on.
      shouldDeferStopFailure: () => this.hasInflightUpstream(jinnSessionId),
      native: nativeCommand,
    });
    const entry = { resolver, onStream: opts.onStream, activeTools: 0, permissionPromptPending: false, submitConfirmationArmed: false, submitAcknowledged: false } as {
      resolver: TurnResolver;
      onStream?: (d: StreamDelta) => void;
      boundProc?: pty.IPty;
      activeTools: number;
      permissionPromptPending: boolean;
      permissionTimer?: NodeJS.Timeout;
      submitConfirmationArmed: boolean;
      submitAcknowledged: boolean;
      cancelSubmitConfirm?: () => void;
    };
    this.active.set(jinnSessionId, entry);

    // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
    this.hookRegistry.register(jinnSessionId, (h, delivery) => {
      resolver.onHook(h);
      const buffered = delivery?.buffered === true;
      // register() synchronously drains hooks buffered after the previous turn.
      // They must not acknowledge a prompt that has not been pasted yet.
      if (entry.submitConfirmationArmed && SUBMIT_ACK_HOOKS.has(h.hook_event_name)) {
        entry.submitAcknowledged = true;
      }
      // Track local tool executions: lost-Stop recovery must never fire while a
      // tool is mid-run (transcript text exists but the turn isn't done).
      if (!buffered && h.hook_event_name === "PreToolUse") entry.activeTools += 1;
      if (!buffered && h.hook_event_name === "PostToolUse") entry.activeTools = Math.max(0, entry.activeTools - 1);
      if (!buffered && h.hook_event_name === "PostToolUse" && entry.permissionPromptPending && entry.activeTools === 0) {
        // Permission Notification follows the gated tool's PreToolUse. Only
        // clear after every then-in-flight tool has posted completion; clearing
        // on an unrelated parallel tool's PostToolUse can hide a still-blocked
        // prompt and fabricate lost-Stop success.
        entry.permissionPromptPending = false;
        if (entry.permissionTimer) {
          clearTimeout(entry.permissionTimer);
          entry.permissionTimer = undefined;
        }
      }
      if (!buffered && isPermissionPromptNotification(h)) {
        entry.permissionPromptPending = true;
        opts.onStream?.({ type: "permission", content: "Claude is waiting for approval in the CLI safety prompt." });
        if (this.autoApproveSafetyPrompts) {
          if (entry.permissionTimer) clearTimeout(entry.permissionTimer);
          // The hook may arrive before the PTY has finished drawing the prompt (or
          // during the narrow spawn→boundProc handoff). Give the terminal one frame
          // to settle, then re-check identity and parse the completed screen once.
          entry.permissionTimer = setTimeout(() => {
            entry.permissionTimer = undefined;
            if (this.active.get(jinnSessionId) !== entry || !entry.permissionPromptPending) return;
            const proc = entry.boundProc;
            const prompt = proc ? parsePermissionPrompt(terminalTextLines(this.getScrollback(jinnSessionId))) : null;
            const approval = prompt ? chooseApproval(prompt) : null;
            if (proc && prompt && approval) {
              for (const key of keystrokesToSelect(prompt.selectedPosition, approval.position)) proc.write(key);
              // Key delivery is not proof of approval. Keep pending until the
              // gated tool (and any parallel tools) posts completion.
              logger.warn(`InteractiveClaudeEngine: auto-approved a strict safety prompt for ${jinnSessionId}: ${prompt.reason ?? "reason unavailable"}`);
            } else {
              logger.warn(`InteractiveClaudeEngine: permission prompt for ${jinnSessionId} was not recognized unambiguously; no keys sent`);
            }
          }, 500);
          entry.permissionTimer.unref?.();
        }
      }
      // tool_use markers + intermediate text now stream from the per-PTY SSE proxy
      // (content_block_start / content_block_delta) in true order. The hook only
      // supplies tool_result — the assistant SSE stream has no tool_result event
      // (tools execute locally between assistant messages).
      if (!buffered && h.hook_event_name === "PostToolUse" && opts.onStream) {
        opts.onStream({
          type: "tool_result",
          content: String(h.tool_name ?? ""),
          toolName: typeof h.tool_name === "string" ? h.tool_name : undefined,
        });
      }
    });

    // Liveness guard: a socket error (EIO) between getWarm() above and here may have
    // already torn this handle down (handlePtyDeath → deadHandles + evict). Never inject
    // into a corpse — fall through to a cold respawn. This is the silent-drop / queue-
    // stall path of issue #18 (warm reuse of a dead PTY → no SessionStart/Stop → hang).
    if (warm && (this.deadHandles.has(warm) || warm.killed)) {
      warm = undefined;
    }
    if (warm) {
      logger.info(`InteractiveClaudeEngine reusing warm PTY for ${jinnSessionId}`);
      // Bind the proc BEFORE injecting: handlePtyDeath only interrupts the active turn
      // when entry.boundProc === proc, so a death during/around inject must find it set.
      entry.boundProc = (warm as any)._proc as pty.IPty | undefined;
      // Mark the turn started BEFORE injecting so the sweep timer can't release the PTY
      // mid-paste if its grace window expired between getWarm() and the proc.write().
      this.lifecycle.turnStarted(jinnSessionId);
      try {
        this.injectPrompt(warm, opts);
      } catch (err) {
        // Writing to a dead PTY socket throws — treat as a PTY death so the turn settles
        // (and the corpse is evicted) instead of hanging until the turn watchdog.
        const msg = err instanceof Error ? err.message : String(err);
        if (entry.boundProc) this.handlePtyDeath(jinnSessionId, entry.boundProc, warm, `PTY inject failed (${msg})`);
      }
    } else {
      const handle = await this.spawn(jinnSessionId, opts, settingsPath);
      // Bind the proc before adopt/turnStarted so an early error/exit (before the
      // watchdog arms) still settles the turn via handlePtyDeath's boundProc gate.
      entry.boundProc = (handle as any)._proc as pty.IPty | undefined;
      this.lifecycle.adopt(jinnSessionId, handle);
      this.lifecycle.turnStarted(jinnSessionId);
    }

    // Watchdog: if the bound PTY dies without the resolver settling (e.g. the
    // onExit identity-guard didn't match in a kill→respawn race), the turn would
    // hang forever — runWebSession's 5s heartbeat would zombie status:"running"
    // and the completion (session:completed + notifyParentSession parent callback)
    // would never fire. Both the stuck "in progress" badge and lost child-session
    // callbacks trace to this. Force-settle once the proc is provably dead so
    // run() always resolves and the normal completion path runs.
    const watchdog = setInterval(() => {
      const p = entry.boundProc as { _exitCode?: number | null } | undefined;
      if (p && p._exitCode != null) {
        resolver.interrupt("Interrupted: claude process exited");
        return;
      }
      // Turn-level deadline: a pty that hangs while still alive (no Stop hook, no
      // exit) would otherwise never resolve. Force-settle and release the pty so the
      // session can't zombie as status:"running". Skipped while the engine is
      // demonstrably still working (API requests streaming through the SSE proxy) —
      // the deadline exists to catch WEDGED turns, not to cap long legitimate
      // autonomous runs; a truly hung pty goes quiet and gets reaped on a later tick.
      if (Date.now() - turnStartedAtMs > this.turnTimeoutMs && !this.isEngineBusy(jinnSessionId)) {
        logger.warn(`InteractiveClaudeEngine: turn for ${jinnSessionId} exceeded ${Math.round(this.turnTimeoutMs / 1000)}s with no engine activity — force-settling as timed out`);
        resolver.interrupt("Interrupted: interactive turn timed out");
        this.lifecycle.releaseSession(jinnSessionId);
      }
    }, 5000);
    watchdog.unref?.();

    // Native local command: no Stop hook fires for context mutators (/compact,
    // /clear, /model) — settle on an output quiet-window instead of hanging
    // until the turn watchdog.
    let nativeCommandTimer: NodeJS.Timeout | undefined;
    if (nativeCommand) {
      nativeCommandTimer = setInterval(() => {
        const now = Date.now();
        const quietFor = now - (this.lastOutputAt.get(jinnSessionId) ?? turnStartedAtMs);
        const elapsed = now - turnStartedAtMs;
        if ((elapsed >= NATIVE_COMMAND_MIN_MS && quietFor >= NATIVE_COMMAND_QUIET_MS) || elapsed >= NATIVE_COMMAND_MAX_MS) {
          resolver.completeNativeCommand();
        }
      }, 500);
      nativeCommandTimer.unref?.();
    }

    // Lost-Stop recovery: the Stop hook can be lost outright (relay failure,
    // gateway.json replaced mid-turn, hook process killed). If the turn has run
    // ≥5 min, the PTY has been quiet ≥60s, no tool is executing and no API
    // request is in flight, and the transcript has a fresh assistant message —
    // the turn actually finished; recover its text instead of hanging until the
    // watchdog fails it. (Ported from upstream jinn.)
    let lostStopRecoveryTimer: NodeJS.Timeout | undefined;
    if (!nativeCommand) {
      lostStopRecoveryTimer = setInterval(() => {
        if (resolver.isSettled) return;
        // A StopFailure is held in the grace window — the turn's fate is the
        // grace timer's call (Stop supersedes / expiry fails). Recovering
        // intermediate transcript text here would fabricate a wrong success.
        if (resolver.stopFailure) return;
        const upstreamInflight = this.hasInflightUpstream(jinnSessionId);
        const now = Date.now();
        const elapsed = now - turnStartedAtMs;
        const quietFor = now - (this.lastOutputAt.get(jinnSessionId) ?? turnStartedAtMs);
        if (
          canRecoverLostStop(entry.activeTools, entry.permissionPromptPending, upstreamInflight)
          && elapsed >= LOST_STOP_RECOVERY_MIN_MS
          && quietFor >= LOST_STOP_RECOVERY_QUIET_MS
        ) {
          const sid = resolver.sessionId ?? opts.resumeSessionId;
          const transcript = sid ? findTranscriptForSession(sid) : undefined;
          let fresh = false;
          if (transcript) {
            try { fresh = fs.statSync(transcript).mtimeMs >= turnStartedAtMs - 1000; } catch { /* unreadable */ }
          }
          const recovered = transcript && fresh ? lastAssistantTextFromTranscript(transcript, turnStartedAtMs) : undefined;
          if (recovered?.trim()) {
            logger.warn(`InteractiveClaudeEngine: recovered completed turn for ${jinnSessionId} after missing Stop hook`);
            resolver.completeRecovered(recovered, sid);
            return;
          }
        }
        // An abandoned permission dialog may eventually be failed as stalled,
        // but active work without one and live upstream requests may not.
        if (recoveryBlockedByWork(entry.activeTools, entry.permissionPromptPending, upstreamInflight)) return;
        if (shouldSettleStalledTurn(elapsed, quietFor)) {
          logger.warn(`InteractiveClaudeEngine: turn for ${jinnSessionId} stalled after ${Math.round(elapsed / 60_000)}m (${Math.round(quietFor / 60_000)}m quiet) — settling so the session queue can continue`);
          resolver.interrupt("Turn stalled: the engine produced no completion signal and no recoverable transcript");
          // A PTY quiet enough to meet the stall predicate is not safe to reuse:
          // an eventual late completion could mix with the next prompt/transcript.
          this.lifecycle.releaseSession(jinnSessionId);
        }
      }, 2000);
      lostStopRecoveryTimer.unref?.();
    }

    let result: EngineResult;
    try {
      result = await resolver.promise;
    } finally {
      clearInterval(watchdog);
      if (nativeCommandTimer) clearInterval(nativeCommandTimer);
      if (lostStopRecoveryTimer) clearInterval(lostStopRecoveryTimer);
      if (entry.permissionTimer) clearTimeout(entry.permissionTimer);
      entry.cancelSubmitConfirm?.();
      this.hookRegistry.unregister(jinnSessionId);
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId); // manager decides kill vs keep-warm
    }

    // Recover lost result text: if the turn settled with no text and no API-level
    // failure, the Stop hook (which carries last_assistant_message) was dropped or
    // arrived empty. The real final message is still on disk in the transcript;
    // backfill it so the reply shows real output instead of "(no output)".
    // stopFailure turns are a genuine no-output API error — leave those alone.
    if (!nativeCommand && !result.error && !result.result?.trim() && !resolver.stopFailure) {
      const sid = resolver.sessionId ?? opts.resumeSessionId ?? result.sessionId;
      const recoveryPath = sid ? findTranscriptForSession(sid) : undefined;
      const recovered = recoveryPath ? lastAssistantTextFromTranscript(recoveryPath, turnStartedAtMs) : undefined;
      if (recovered) {
        logger.info(`Recovered ${recovered.length} chars of lost turn text for session ${jinnSessionId} from transcript (Stop hook missing)`);
        result.result = sanitizeAssistantText(recovered);
      }
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      const cost = computeInteractiveCost(transcriptPath, opts.model, turnStartedAtMs);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
      // Context-meter: most recent turn's input context (input + cache), mirroring
      // headless claude.ts so interactive/CLI-view turns also populate the meter.
      const ctx = lastTurnContextTokens(transcriptPath);
      if (ctx) result.contextTokens = ctx;
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    return result;
  }

  /** Build the env passed to the claude PTY: inherits process.env but strips
   *  CLAUDECODE / CLAUDE_CODE_* so the child doesn't think it's nested, then
   *  enables fullscreen rendering. Shared by spawn() and ensureIdleSpawn().
   *  When `proxyPort` is given, points ANTHROPIC_BASE_URL at the per-PTY SSE
   *  forward proxy on 127.0.0.1 — subscription OAuth token is passed separately
   *  by claude, so this stays cc_entrypoint=cli / subsidy-safe (verified Item A). */
  private buildPtyEnv(proxyPort?: number): Record<string, string> {
    return buildClaudePtyEnv(proxyPort);
  }

  /** Translate parsed SSE events from a PTY's proxy into StreamDeltas and route
   *  them to the active turn's onStream. A PTY outlives its turn, so we look up
   *  the live active entry here rather than capturing onStream at spawn. */
  private handleSseEvent(jinnSessionId: string, e: SseDataEvent, ctx: StreamCtx): void {
    const activeEntry = this.active.get(jinnSessionId);
    // SSE deltas are proof of life — re-arm a pending StopFailure grace window.
    activeEntry?.resolver.noteActivity();
    const onStream = activeEntry?.onStream;
    if (!onStream) return; // idle PTY / no turn in flight — nothing to stream
    // Tag sub-agent deltas so the chat pane routes them into a collapsible card
    // instead of the main transcript; main-agent deltas pass through untagged.
    for (const d of sseEventToDeltas(e)) onStream(ctx.subAgent ? { ...d, subAgent: ctx.subAgent } : d);
  }

  /** Allocate + start a per-PTY SSE forward proxy. Returns the proxy and its port,
   *  or {port:0} if it failed to bind — in which case the PTY is spawned WITHOUT
   *  ANTHROPIC_BASE_URL (direct to Anthropic): the turn still works, only live
   *  word-by-word streaming degrades. */
  private async startProxy(jinnSessionId: string): Promise<{ proxy: SsePtyProxy; port: number }> {
    const proxy = new SsePtyProxy(jinnSessionId, (e, ctx) => this.handleSseEvent(jinnSessionId, e, ctx));
    try {
      const port = await proxy.start();
      return { proxy, port };
    } catch (err) {
      logger.warn(`SSE proxy failed to start for session ${jinnSessionId} (streaming degraded): ${err instanceof Error ? err.message : String(err)}`);
      proxy.stop();
      return { proxy, port: 0 };
    }
  }

  /** Idempotent teardown for a dead PTY — shared by the socket-`error` handler, the
   *  proc `onExit` handler, and run()'s warm-reuse failure path. A broken PTY can raise
   *  `error` WITHOUT ever firing `onExit` (and both can fire, in either order), so no
   *  single trigger is sufficient; `deadHandles` makes the first caller win and the rest
   *  no-op. Steps: (1) identity-gated lifecycle cleanup (evict the warm corpse + clear
   *  scrollback) only if this is still the session's current handle; (2) stop the per-PTY
   *  SSE proxy; (3) interrupt the active turn iff this proc is the bound one, so run()'s
   *  promise resolves instead of hanging until the turn watchdog (issue #18). */
  private handlePtyDeath(jinnSessionId: string, proc: pty.IPty, handle: PtyHandle, cause: string): void {
    if (this.deadHandles.has(handle)) return;
    this.deadHandles.add(handle);
    // Identity gate: in a kill->respawn race the lifecycle/stream entries already point
    // at the NEW PTY by the time THIS (old) PTY dies. Only touch shared state when this
    // handle is still the session's current warm one — else we'd evict the live PTY.
    const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
    if (isCurrent) {
      // Clear scrollback so a stale farewell (Claude's "Resume this session…" hint on
      // SIGHUP shutdown) doesn't persist into the next PTY incarnation.
      const s = this.streams.get(jinnSessionId);
      if (s) {
        s.chunks = [];
        s.totalBytes = 0;
        // Drop the entry if no WS subscribers — otherwise it leaks one per ran session.
        if (s.subscribers.size === 0) this.streams.delete(jinnSessionId);
      }
      // Evict so a future run() can't pick this dead handle up as "warm" and inject
      // into a corpse.
      this.lifecycle.releaseSession(jinnSessionId);
      this.lastOutputAt.delete(jinnSessionId);
    }
    // Tear down THIS PTY's SSE forward proxy (one per PTY) regardless of identity.
    ((handle as any)._proxy as SsePtyProxy | undefined)?.stop();
    // Settle the active turn as interrupted so run()'s promise doesn't hang — but only
    // if this dying proc is the one bound to the active turn. After a kill->respawn race
    // the active entry holds the NEW turn's resolver+proc; identity mismatch => no-op.
    const e = this.active.get(jinnSessionId);
    if (e && e.boundProc === proc) {
      e.resolver.interrupt(`Interrupted: claude ${cause}`);
    }
  }

  /** Wrap a freshly-spawned pty.IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. On PTY exit, if this
   *  proc is the one bound to the active turn, the resolver is interrupted (a crash
   *  with no Stop hook); a stale proc replaced by a respawn is treated as benign.
   *  `proxy` (the per-PTY SSE forward proxy) is torn down when this PTY exits. */
  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, proxy?: SsePtyProxy): PtyHandle {
    const handle: PtyHandle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
    } as PtyHandle;
    const stream = this.streamFor(jinnSessionId);
    // Distinguish initial spawn from respawn via a per-stream flag rather than
    // subscriber count — CliTerminal opens its WS on mount (before the user
    // sends the first message that triggers spawn), so subscriber-count gating
    // would spuriously reset on the very first PTY for the session.
    // On respawn, clear the prior terminal state even if nobody is subscribed.
    if (!stream.hasSeenPty) {
      stream.hasSeenPty = true;
    } else {
      // A restored snapshot (or the previous PTY incarnation) is a complete old
      // terminal state. Never append a new TUI byte stream to it.
      stream.chunks = [];
      stream.totalBytes = 0;
      ptySnapshotStore.deleteSync(jinnSessionId);
      if (stream.subscribers.size > 0) {
        for (const sub of stream.subscribers) {
          try { sub.control?.({ type: "reset" }); } catch { /* ignore */ }
        }
      }
    }
    // node-pty's internal socket error handler (unixTerminal.js) throws synchronously when
    // proc.listeners('error').length < 2. Without this listener the count stays at 1 (the
    // internal handler), so any socket error (EIO on claude exit, EPIPE, etc.) propagates as
    // an uncaught exception and kills the daemon. Adding a handler here bumps the count to 2
    // and prevents the throw; we log it and let the onExit path handle cleanup.
    // A PTY-master socket `error` (EIO on claude exit, EPIPE, EBADF, …) means the
    // interactive transport is broken: reads/writes fail and `onExit` is NOT
    // guaranteed to follow. Treat ANY error as terminal — log the code, then run the
    // same teardown as onExit. Leaving a broken PTY warm is what zombied a sessionKey:
    // the next run() reused the corpse, injected into a dead socket, and the turn hung
    // until the 90-min watchdog (see issue #18). Cleanup is idempotent (deadHandles).
    (proc as any).on?.("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code ?? err.message;
      logger.warn(`PTY socket error for session ${jinnSessionId}: ${err.message}`);
      this.handlePtyDeath(jinnSessionId, proc, handle, `PTY socket error (${code})`);
    });

    proc.onData((d) => {
      this.lastOutputAt.set(jinnSessionId, Date.now());
      // Convert string to Buffer once; push to ring; evict head until under cap.
      const chunk = Buffer.from(d, "utf-8");
      stream.chunks.push(chunk);
      stream.totalBytes += chunk.length;
      while (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length > 1) {
        const head = stream.chunks.shift()!;
        stream.totalBytes -= head.length;
      }
      // If a single chunk exceeds the cap, slice it down (rare; keeps invariant tight).
      if (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length === 1) {
        const only = stream.chunks[0]!;
        const sliced = only.subarray(only.length - SCROLLBACK_CAP_BYTES);
        stream.chunks[0] = sliced;
        stream.totalBytes = sliced.length;
      }
      ptySnapshotStore.schedule(jinnSessionId, () => this.getScrollback(jinnSessionId));
      for (const sub of stream.subscribers) {
        try { sub.data(chunk); } catch { /* ignore subscriber errors */ }
      }
    });
    proc.onExit(() => {
      this.handlePtyDeath(jinnSessionId, proc, handle, "process exited");
    });
    (handle as any)._proc = proc;
    // Keep the per-PTY proxy reachable from the handle so handlePtyDeath can tear it
    // down even when invoked from run()'s warm-reuse path (which has no proxy closure).
    (handle as any)._proxy = proxy;
    return handle;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli).
   *  Allocates a per-PTY SSE forward proxy first and points the child at it. */
  private async spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string): Promise<PtyHandle> {
    const args = buildInteractiveArgs({
      prompt: opts.prompt,
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
    });
    // Serialize the spawn herd across the shared-OAuth near-expiry window so only
    // one child triggers the (single-use) token refresh — others wait for it.
    await awaitFreshClaudeCredentials();
    const { proxy, port } = await this.startProxy(jinnSessionId);
    const env = this.buildPtyEnv(port || undefined);
    const bin = opts.bin || "claude";
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"}, sseProxy: ${port || "off"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel });
    return this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
  }

  /** Spawn an idle PTY for the CLI/xterm view. If an engineSessionId is provided,
   *  resumes that session; otherwise spawns a fresh `claude` so a brand-new CLI-mode
   *  session shows the TUI before the user types anything.
   *  Does NOTHING if a warm PTY already exists or a turn is starting.
   *  Fire-and-forget (void): allocating the per-PTY SSE proxy is async, so the
   *  actual spawn happens after a microtask; `idleSpawning` guards re-entrancy. */
  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting/running — let run() spawn
    if (this.idleSpawning.has(jinnSessionId)) return; // an idle spawn is already in flight
    this.idleSpawning.add(jinnSessionId);

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
    });
    const args: string[] = [
      "--chrome",
      "--dangerously-skip-permissions",
      "--disallowedTools", "AskUserQuestion", "ExitPlanMode",
      "--settings", settingsPath,
    ];
    if (opts.engineSessionId) args.unshift("--resume", opts.engineSessionId);
    if (opts.model) args.push("--model", opts.model);
    const bin = opts.bin || "claude";
    // Caller (pty-ws) passes the client's current cols/rows. Cache them so a
    // future cold spawn through run() picks up the right geometry too.
    const cols = opts.cols ?? this.lastGeom.get(jinnSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(jinnSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) this.lastGeom.set(jinnSessionId, { cols: opts.cols, rows: opts.rows });

    void (async () => {
      try {
        await awaitFreshClaudeCredentials();
        const { proxy, port } = await this.startProxy(jinnSessionId);
        // Re-check after the async gap: a real turn (run) or another idle spawn may
        // have claimed the session while we awaited the proxy bind. If so, don't
        // adopt a duplicate PTY — drop our proxy and bail.
        if (this.lifecycle.getWarm(jinnSessionId) || this.active.has(jinnSessionId)) {
          proxy.stop();
          return;
        }
        const env = this.buildPtyEnv(port || undefined);
        logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows}, sseProxy: ${port || "off"})`);
        const proc = pty.spawn(bin, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: opts.cwd || JINN_HOME,
          env,
        });
        const handle = this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
        this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: undefined });
        this.lifecycle.adopt(jinnSessionId, handle);
      } catch (err) {
        logger.warn(`ensureIdleSpawn failed for session ${jinnSessionId}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.idleSpawning.delete(jinnSessionId);
      }
    })();
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let text = opts.prompt;
    if (opts.attachments?.length) {
      text += buildAttachmentSuffix(opts.attachments);
    }
    const entry = opts.sessionId ? this.active.get(opts.sessionId) : undefined;
    entry?.cancelSubmitConfirm?.();
    if (entry) {
      entry.submitAcknowledged = false;
      entry.submitConfirmationArmed = true;
    }
    const cancel = pasteAndSubmit(proc, text, entry ? {
      submitted: () => entry.submitAcknowledged,
      busy: () => opts.sessionId ? this.hasInflightUpstream(opts.sessionId) : false,
      onRetry: (attempt) => logger.warn(`InteractiveClaudeEngine: submit for ${opts.sessionId} unconfirmed — retrying Enter (${attempt}/${SUBMIT_CONFIRM_ATTEMPTS})`),
      onUnconfirmed: () => logger.warn(`InteractiveClaudeEngine: submit for ${opts.sessionId} remained unconfirmed; stall recovery remains armed`),
    } : undefined);
    if (entry) entry.cancelSubmitConfirm = cancel;
  }

  /** Lazily create (or fetch) the output stream entry for a Jinn session id. */
  private streamFor(sessionId: string): {
    chunks: Buffer[];
    totalBytes: number;
    subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
    hasSeenPty: boolean;
  } {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      const restored = ptySnapshotStore.loadSync(sessionId);
      stream = {
        chunks: restored ? [restored] : [],
        totalBytes: restored?.length ?? 0,
        subscribers: new Set(),
        // Restored bytes came from an earlier PTY incarnation. The next spawn
        // must reset rather than append a fresh TUI stream to this screen.
        hasSeenPty: restored !== undefined,
      };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /** Append-only capped output buffer for the session's current/most-recent PTY (for xterm.js reconnect replay).
   *  Returns a concatenated Buffer — pty-ws.ts forwards it directly without re-encoding. */
  getScrollback(sessionId: string): Buffer {
    const s = this.streams.get(sessionId);
    if (!s || s.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(s.chunks, s.totalBytes);
  }

  /** Subscribe to live PTY output for a session. Returns an unsubscribe fn. Survives PTY respawn within the session.
   *  Optional `onControl` receives out-of-band events (currently just `{type:"reset"}`
   *  when the PTY is replaced mid-session — the WS should forward this to the client xterm). */
  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    const stream = this.streamFor(sessionId);
    const sub = { data: cb, control: onControl };
    stream.subscribers.add(sub);
    return () => {
      stream.subscribers.delete(sub);
      // If this was the last subscriber AND there's no warm PTY producing data,
      // the streams entry is dead weight — drop it. Mirrors the onExit cleanup
      // path for sessions whose WS outlived the PTY.
      if (stream.subscribers.size === 0 && !this.lifecycle.getWarm(sessionId)) {
        this.streams.delete(sessionId);
      }
    };
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  /** Resize the warm PTY + remember the geometry for the next cold spawn. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    this.lastGeom.set(sessionId, { cols, rows });
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
    // A remote (sshHost) turn ran on the headless fallback — kill it there too.
    this.remoteFallback?.kill(sessionId, reason);
  }

  killAll(): void {
    // Graceful gateway shutdown must be as recoverable as a crash. Flush the
    // debounced tail before SIGTERM so the next process can replay the latest
    // complete screen, including output produced in the last 250ms.
    for (const id of this.streams.keys()) {
      ptySnapshotStore.flushSync(id, () => this.getScrollback(id));
    }
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
    this.remoteFallback?.killAll();
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Grace bridging local tool executions between API calls: the PTY counts as
   *  busy this long after the last upstream activity even with nothing in flight. */
  private static readonly BUSY_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

  /** True while the warm PTY's claude is demonstrably working OUTSIDE a managed
   *  turn (autonomous background continuation): an API request is streaming
   *  through its SSE proxy, or did so within the activity window. Wired into
   *  PtyLifecycleManager.isBusy so the keep-warm reaper / LRU eviction never
   *  kills a PTY mid-work. */
  isEngineBusy(sessionId: string): boolean {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return false;
    const proxy = (handle as any)._proxy as SsePtyProxy | undefined;
    return proxy?.isBusy(InteractiveClaudeEngine.BUSY_ACTIVITY_WINDOW_MS) ?? false;
  }

  /** True while an upstream API request is streaming through the session's SSE
   *  proxy RIGHT NOW (no recency window — strictly in-flight). Used to defer a
   *  graced StopFailure (a sub-agent error while the main agent still works)
   *  and to hold lost-Stop recovery while the model is mid-request. */
  private hasInflightUpstream(sessionId: string): boolean {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return false;
    const proxy = (handle as any)._proxy as SsePtyProxy | undefined;
    return proxy?.hasInflight() ?? false;
  }

  /** Out-of-turn engine activity observed via an orphan hook (a background
   *  continuation firing PreToolUse/PostToolUse/Stop after its turn settled).
   *  Restarts the PTY keep-warm grace window so active background work — which
   *  the lifecycle can't see as a turn — isn't reaped mid-flight. */
  noteBackgroundActivity(sessionId: string): void {
    this.lifecycle.touch(sessionId);
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Track viewing state from the frontend. Called by pty-ws on `viewing` messages
   *  from CliTerminal (mount/unmount + Page Visibility). Ref-counted so multiple tabs
   *  viewing the same session keep it warm until the last one leaves. */
  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists (or a
   *  remote fallback turn is live for this session). */
  isAlive(sessionId: string): boolean {
    return (
      this.active.has(sessionId) ||
      this.lifecycle.getWarm(sessionId) !== undefined ||
      this.remoteFallback?.isAlive(sessionId) === true
    );
  }
}
