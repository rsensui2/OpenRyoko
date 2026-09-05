/**
 * Deterministic response gate for the Slack connector.
 *
 * Evaluated before any network fetches and before the LLM triage layer, so
 * "mention"-gated scopes cost zero tokens and zero latency for dropped
 * messages. This is the hard guarantee triage cannot give: triage is
 * probabilistic air-reading, while respondTo is policy.
 *
 * Scope mapping (Slack `channel_type`):
 *   - "im"    → im     (1:1 DM)
 *   - "mpim"  → mpim   (group DM)
 *   - "channel", "group" (legacy private channel), unknown → channel
 */
import type { SlackRespondMode, SlackRespondToConfig } from "../../shared/types.js";

export type RespondScope = "im" | "mpim" | "channel";

export function scopeForChannelType(channelType: string | undefined): RespondScope {
  if (channelType === "im") return "im";
  if (channelType === "mpim") return "mpim";
  return "channel";
}

/**
 * Resolve the effective mode for a scope. Unset or unrecognized values fall
 * back to "always" — config files are hand-edited YAML, so an invalid value
 * must degrade to the legacy behavior rather than silence the bot.
 */
export function resolveRespondMode(
  config: SlackRespondToConfig | undefined,
  scope: RespondScope,
): SlackRespondMode {
  const raw = config?.[scope];
  return raw === "mention" || raw === "never" ? raw : "always";
}

/** True when any scope requires an @-mention. */
export function hasMentionScope(config: SlackRespondToConfig | undefined): boolean {
  if (!config) return false;
  return [config.im, config.mpim, config.channel].includes("mention");
}

/**
 * True when the policy needs the ConversationTracker: some scope is
 * mention-gated and engaged-thread continuation (the default) is on.
 */
export function respondPolicyNeedsTracking(config: SlackRespondToConfig | undefined): boolean {
  return hasMentionScope(config) && config?.engagedThreads !== false;
}

export interface RespondPolicyInput {
  config: SlackRespondToConfig | undefined;
  channelType: string | undefined;
  wasMentioned: boolean;
  /** Whether the message sits in a thread the bot has already engaged. */
  isEngagedThread: boolean;
}

export type RespondDecision = { allow: true } | { allow: false; reason: string };

export function evaluateRespondPolicy(input: RespondPolicyInput): RespondDecision {
  const scope = scopeForChannelType(input.channelType);
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
 * True when a reaction event should be handled at all.
 *
 * Reactions carry no @-mention, so a channel scope of "mention" (or "never")
 * can never be satisfied here — the message-path gate in
 * `evaluateRespondPolicy` has no equivalent on the reaction path. Without this
 * check a secondary bot sharing channels with the primary bot double-handles
 * every channel reaction; the primary bot (channel="always") owns them.
 *
 * `reaction_added` reports only `item.channel`, with no `channel_type`, so the
 * scope has to be inferred from the id prefix. Only DMs ("D…") are
 * distinguishable; group DMs fall under the channel scope rather than mpim.
 * That is deliberate — the conservative side of the gate — and matches how
 * the reaction path behaved before this scope existed.
 */
export function shouldHandleReaction(
  config: SlackRespondToConfig | undefined,
  itemChannel: string,
): boolean {
  if (itemChannel.startsWith("D")) return true;
  return resolveRespondMode(config, "channel") === "always";
}
