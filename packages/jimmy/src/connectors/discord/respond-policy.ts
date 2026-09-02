/**
 * Deterministic response gate for the Discord connector.
 *
 * Port of the Slack `respondTo` gate (see ../slack/respond-policy.ts).
 * Evaluated before the message reaches the session engine, so "mention"-gated
 * scopes cost zero tokens and zero latency for dropped messages.
 *
 * Scope mapping (discord.js channel):
 *   - `isDMBased()` (1:1 DMs and group DMs) → dm
 *   - guild text channels and threads       → channel
 *
 * Unlike Slack there is no LLM triage layer on this connector, so the gate is
 * the only thing between an incoming channel message and a full engine reply.
 */
import type { DiscordRespondMode, DiscordRespondToConfig } from "../../shared/types.js";

export type DiscordRespondScope = "dm" | "channel";

export function scopeForChannel(isDM: boolean): DiscordRespondScope {
  return isDM ? "dm" : "channel";
}

/**
 * Resolve the effective mode for a scope. Unset or unrecognized values fall
 * back to "always" — config files are hand-edited YAML, so an invalid value
 * must degrade to the legacy behavior rather than silence the bot.
 */
export function resolveRespondMode(
  config: DiscordRespondToConfig | undefined,
  scope: DiscordRespondScope,
): DiscordRespondMode {
  const raw = config?.[scope];
  return raw === "mention" || raw === "never" ? raw : "always";
}

/** True when any scope requires an @-mention. */
export function hasMentionScope(config: DiscordRespondToConfig | undefined): boolean {
  if (!config) return false;
  return [config.dm, config.channel].includes("mention");
}

/**
 * True when the policy needs engaged-thread tracking: some scope is
 * mention-gated and engaged-thread continuation (the default) is on.
 */
export function respondPolicyNeedsTracking(config: DiscordRespondToConfig | undefined): boolean {
  return hasMentionScope(config) && config?.engagedThreads !== false;
}

export interface RespondPolicyInput {
  config: DiscordRespondToConfig | undefined;
  isDM: boolean;
  wasMentioned: boolean;
  /** Whether the message sits in a thread the bot has already engaged. */
  isEngagedThread: boolean;
}

export type RespondDecision = { allow: true } | { allow: false; reason: string };

export function evaluateRespondPolicy(input: RespondPolicyInput): RespondDecision {
  const scope = scopeForChannel(input.isDM);
  const mode = resolveRespondMode(input.config, scope);
  if (mode === "never") {
    return { allow: false, reason: `respondTo.${scope}=never` };
  }
  if (mode === "mention" && !input.wasMentioned) {
    if (input.config?.engagedThreads !== false && input.isEngagedThread) {
      return { allow: true };
    }
    return { allow: false, reason: `respondTo.${scope}=mention and message has no @-mention` };
  }
  return { allow: true };
}

/**
 * True when the message addresses the bot: a direct @-mention, or a Discord
 * reply to one of the bot's messages. Reply detection uses the replied-to
 * author from the resolved reference, so it works whether or not the reply
 * pinged ("@ ON"/"@ OFF") — replying to the bot is addressing the bot either
 * way. Role mentions and @everyone/@here deliberately do NOT count, matching
 * the Slack gate where @channel/@here never satisfy "mention".
 */
export function wasBotAddressed(input: {
  botUserId: string | undefined;
  mentionedUserIds: ReadonlySet<string>;
  repliedToUserId: string | undefined;
}): boolean {
  if (!input.botUserId) return false;
  if (input.mentionedUserIds.has(input.botUserId)) return true;
  return input.repliedToUserId === input.botUserId;
}

/**
 * True when the message explicitly addresses somebody else and not the bot:
 * it @-mentions specific user(s), or replies to another user's message, and
 * none of those users is the bot. Such messages stay silent even in "always"
 * scopes — same sibling-mention rule as the Slack connector. Never applies to
 * DMs, and @everyone/@here alone never triggers it (no specific addressee).
 */
export function addressesOnlyOthers(input: {
  botUserId: string | undefined;
  mentionedUserIds: ReadonlySet<string>;
  repliedToUserId: string | undefined;
}): boolean {
  if (!input.botUserId) return false;
  if (wasBotAddressed(input)) return false;
  return input.mentionedUserIds.size > 0 || input.repliedToUserId !== undefined;
}
