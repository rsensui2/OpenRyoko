/**
 * Per-message speaker attribution for group conversations.
 *
 * The system prompt names the speaker only at engine-spawn time. In a
 * multi-user thread (or a warm-PTY follow-up from a DIFFERENT person) the
 * model has no per-turn signal of who is talking and defaults to the
 * conversation's habitual addressee — which is how non-operators ended up
 * being addressed as the operator. This helper builds a short
 * `[Speaker: …]` prefix that is prepended to the raw user message so every
 * turn carries an explicit "who is talking now" signal.
 *
 * It lives in its own module (rather than inline in the session manager) so
 * the exact identity path that caused the misattribution incident can be
 * unit-tested directly.
 */
import { resolveOperatorIdentity } from "./context.js";
import type { JinnConfig } from "../shared/types.js";

/** Speaker identity fields carried on a message's transportMeta. */
export interface SpeakerPrefixMeta {
  speakerName?: unknown;
  speakerRealName?: unknown;
  speakerDisplayName?: unknown;
  speakerHandle?: unknown;
  channelType?: unknown;
  isDM?: unknown;
  speakerSlackId?: unknown;
  speakerDiscordId?: unknown;
}

/** Coerce to a trimmed non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Build the `[Speaker: …]` prefix for a group message, or return null when no
 * prefix should be added (1:1 IM channel, or no identifiable speaker name).
 *
 * The display name falls back across every known identity field
 * (name → real name → display name → handle). Previously only `speakerName`
 * was consulted: when a connector reported that field as null but still had a
 * real/display name (Slack sets `name` from the legacy `users.name`, which can
 * be empty), the whole attribution was silently skipped and the model fell
 * back to the operator-default — re-exposing the very misattribution this
 * feature exists to prevent.
 */
export function buildSpeakerPrefix(
  meta: SpeakerPrefixMeta,
  context: { source: string; operatorName?: string; config?: JinnConfig },
): string | null {
  // 1:1 DMs are unambiguous — never attribute.
  if (meta.channelType === "im" || meta.isDM === true) return null;

  const aliases = [
    str(meta.speakerName),
    str(meta.speakerRealName),
    str(meta.speakerDisplayName),
    str(meta.speakerHandle),
  ];
  // First identifiable name across all fields — not just speakerName.
  const name = aliases.find((v): v is string => !!v);
  if (!name) return null;

  // Keep per-turn attribution aligned with the system prompt: configured
  // platform IDs take precedence over display names, and IDs from another
  // transport must never verify the speaker.
  const { speakerIsOperator: isOp } = resolveOperatorIdentity({
    speakerNames: aliases,
    speakerSlackId: str(meta.speakerSlackId),
    speakerDiscordId: str(meta.speakerDiscordId),
    ...context,
  });
  const safeName = name.replace(/[\[\]\r\n]/g, "").slice(0, 60);
  const operator = context.operatorName?.trim();
  const tag = operator
    ? isOp
      ? " (the operator)"
      : ` — NOT the operator; do not address this person as "${operator}"`
    : "";
  return `[Speaker: ${safeName}${tag}]`;
}
