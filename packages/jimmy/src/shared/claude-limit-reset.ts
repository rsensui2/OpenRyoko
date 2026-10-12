/**
 * When the Claude allowance a turn just ran out of reopens.
 *
 * The usage collector next door answers for a person looking at a dashboard.
 * This asks one question on behalf of a turn that has already failed, so it is
 * best effort by construction: an unreachable source, a slow one, or one that
 * shows no spent window resolves to `undefined` rather than throwing or
 * stalling, and the caller keeps the backoff it had before.
 */

import { collectClaudeUsage, type ClaudeUsageResponse, type ClaudeUsageWindow } from "./claude-usage.js";

/** The whole lookup — credential read and request together — may hold a failed
 *  turn back by this much and no more. */
export const CLAUDE_LIMIT_RESET_TIMEOUT_MS = 2_500;

export interface ClaudeLimitReset {
  /** Unix seconds. */
  resetsAt: number;
  /** The spent window as usage telemetry names it (`5h`, `7d`, `7d Fable`). */
  window: string;
}

/** Windows every model draws on. Any other window is scoped to what it names. */
const SHARED_WINDOWS: readonly string[] = ["5h", "7d"];

/** Words in a window name that say nothing about which model it covers. */
const UNSCOPED_WORDS: readonly string[] = ["claude", "scoped", "weekly", "session", "limit"];

/**
 * Whether a quota window counts against a turn on `model`.
 *
 * The shared windows bind every model, and so does a record that names no
 * window at all. A scoped window binds only the model family it names; one that
 * cannot be attributed binds no one, because holding an allowance against the
 * wrong model is the failure this exists to prevent.
 */
export function limitWindowBindsModel(window: string | undefined, model: string | null | undefined): boolean {
  if (window === undefined || SHARED_WINDOWS.includes(window)) return true;
  if (!model) return false;
  const families = (window.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !UNSCOPED_WORDS.includes(word));
  const id = model.toLowerCase();
  return families.some((family) => id.includes(family));
}

/**
 * The spent window a turn on `model` is waiting for. When several are spent the
 * model is back only once the last of them reopens, so that is the one named.
 * A window without a reset still ahead of `nowMs` states nothing to wait for.
 */
export function spentClaudeWindow(
  windows: readonly ClaudeUsageWindow[],
  model: string | null | undefined,
  nowMs: number = Date.now(),
): ClaudeUsageWindow | undefined {
  let binding: ClaudeUsageWindow | undefined;
  for (const window of windows) {
    if (window.usedPercent < 100 || !limitWindowBindsModel(window.name, model)) continue;
    const resetsAt = window.resetsAt;
    if (resetsAt === undefined || resetsAt * 1000 <= nowMs) continue;
    if (binding?.resetsAt !== undefined && resetsAt <= binding.resetsAt) continue;
    binding = window;
  }
  return binding;
}

export interface ClaudeLimitResetOptions {
  /** The model the limited turn ran on; decides which scoped windows apply. */
  model?: string | null;
  timeoutMs?: number;
  nowMs?: number;
  collect?: (options: { timeoutMs: number }) => Promise<ClaudeUsageResponse>;
}

/** The real reset of the window `model` ran out of, or `undefined` when no
 *  source could say within the deadline. Never rejects. */
export async function claudeLimitReset(options: ClaudeLimitResetOptions = {}): Promise<ClaudeLimitReset | undefined> {
  const timeoutMs = options.timeoutMs ?? CLAUDE_LIMIT_RESET_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    // The collector outlives a lost race, so its own failure is absorbed here
    // rather than left to surface as an unhandled rejection.
    const reading = Promise.resolve()
      .then(() => (options.collect ?? collectClaudeUsage)({ timeoutMs }))
      .catch(() => undefined);
    const usage = await Promise.race([reading, deadline]);
    if (!usage?.available) return undefined;
    const spent = spentClaudeWindow(usage.windows, options.model, options.nowMs);
    return spent?.resetsAt === undefined ? undefined : { resetsAt: spent.resetsAt, window: spent.name };
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
