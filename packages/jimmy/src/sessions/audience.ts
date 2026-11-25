import type { JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/**
 * Who a session is talking to, decided from configured platform IDs.
 *
 * Kept apart from the prompt builder so that the session manager can ask the
 * same question for things that are not prompt text (an engine's own memory).
 */

const warnedIdentityConfig = new Set<string>();

export function warnIdentityConfigOnce(label: string, value: unknown, message: string): void {
  const key = `${label}:${String(value).slice(0, 40)}`;
  if (warnedIdentityConfig.has(key)) return;
  warnedIdentityConfig.add(key);
  logger.warn(message);
}

/** Read a configured platform user ID, accepting NON-EMPTY STRINGS ONLY.
 *  Discord snowflakes exceed Number.MAX_SAFE_INTEGER, so an unquoted YAML
 *  value has already lost precision by parse time — comparing the mangled
 *  value could match the WRONG user. Any present non-string value (number,
 *  null, empty) is ignored with a warning; strict mode stays engaged. */
export function configuredIdString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  warnIdentityConfigOnce(
    label,
    value,
    `[identity] ${label} must be a non-empty QUOTED string (unquoted IDs this long lose precision as YAML numbers). The configured value is ignored — strict mode stays engaged and matches nobody until it is fixed.`,
  );
  return undefined;
}

/** trustedSpeakers entries, STRINGS ONLY (same precision hazard as above). */
export function trustedSpeakerIds(config?: JinnConfig): string[] {
  const raw = config?.portal?.trustedSpeakers ?? [];
  const strings = raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (strings.length < raw.length) {
    warnIdentityConfigOnce(
      "portal.trustedSpeakers",
      raw.length - strings.length,
      `[identity] portal.trustedSpeakers contains non-string entries — unquoted Discord snowflakes lose precision as YAML numbers. Quote each ID; non-string entries are ignored.`,
    );
  }
  return strings;
}

/** Sessions the instance runs for itself: nobody is on the other end. */
export const AUTOMATION_SOURCES = new Set(["cron", "workflow"]);

/**
 * True once the instance has any ID-based trust configured. A value that was
 * meant as an ID but cannot be used as one (an unquoted snowflake, which YAML
 * reads as a number) still counts: falling back to "nobody is an outsider" on
 * a typing mistake would undo exactly the protection the operator asked for.
 *
 * An operator key left empty names nobody. The settings page leaves one behind
 * when its field is cleared, and treating that as "everyone is an outsider"
 * would switch memory off for every conversation on the say-so of a blank.
 */
function hasIdentityConfig(config?: JinnConfig): boolean {
  const portal = config?.portal;
  if (!portal) return false;
  const trusted = portal.trustedSpeakers as unknown;
  const named = (value: unknown) => value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
  return (Array.isArray(trusted) && trusted.length > 0) ||
    named((portal as Record<string, unknown>).operatorSlackId) ||
    named((portal as Record<string, unknown>).operatorDiscordId);
}

/**
 * True when the person speaking on Slack or Discord is neither a trusted
 * speaker nor the operator. Only immutable platform IDs count, bound to the
 * platform the message came from; a message with no ID is not vouched for.
 *
 * An instance with no IDs configured has nothing to compare against and keeps
 * behaving as before. So do connectors that carry no such IDs (Telegram,
 * WhatsApp): their speakers are never classified here.
 */
export function isUntrustedSpeaker(opts: {
  source: string;
  speakerSlackId?: string;
  speakerDiscordId?: string;
  config?: JinnConfig;
}): boolean {
  if (opts.source !== "slack" && opts.source !== "discord") return false;
  if (!hasIdentityConfig(opts.config)) return false;
  const portal = opts.config?.portal;
  const known = new Set([
    ...trustedSpeakerIds(opts.config),
    configuredIdString(portal?.operatorSlackId, "portal.operatorSlackId"),
    configuredIdString(portal?.operatorDiscordId, "portal.operatorDiscordId"),
  ].filter((id): id is string => Boolean(id)));
  const speakerId = opts.source === "slack" ? opts.speakerSlackId : opts.speakerDiscordId;
  return !speakerId || !known.has(speakerId);
}

/**
 * A direct message between the assistant and exactly one person: a Slack `im`
 * (channel IDs starting with "D"; group DMs do not), or a Discord DM that is
 * not a group DM. Fails closed: anything it cannot tell is not one.
 */
export function isOneToOneDm(opts: {
  source: string;
  channel?: string;
  isDM?: boolean;
  isGroupDM?: boolean;
}): boolean {
  if (opts.source === "slack") return !!opts.channel && opts.channel.startsWith("D");
  if (opts.source === "discord") return opts.isDM === true && opts.isGroupDM !== true;
  return false;
}

/**
 * True when what is said in this Slack or Discord conversation should not be
 * taken as coming from someone the instance trusts.
 *
 * In a one-to-one direct message there is one person, so the current speaker
 * alone decides. Everything said there earlier was said by the same person,
 * and correcting a mistyped ID, or adding the person to the trusted speakers,
 * takes effect on their next message.
 *
 * Anywhere else it is true when
 * - the current speaker is untrusted (isUntrustedSpeaker), or
 * - an untrusted speaker has already spoken in this session (`externalSpeakerSeen`,
 *   kept on the session: their words stay in the thread a later turn reads), or
 * - the connector reports the channel as shared beyond the workspace, or could
 *   not tell (`channelExternal`).
 *
 * It answers "who has spoken here", not "who can read the reply": a trusted
 * speaker in an ordinary channel is not external, whoever else is a member.
 * What an external conversation says is material to answer, not grounds for
 * changing long-term memory, and the engine's own memory is kept out of it.
 */
export function isExternalAudience(opts: {
  source: string;
  speakerSlackId?: string;
  speakerDiscordId?: string;
  channelExternal?: boolean;
  externalSpeakerSeen?: boolean;
  channel?: string;
  isDM?: boolean;
  isGroupDM?: boolean;
  /** Set by callers that know the conversation is one without holding its raw channel ID. */
  oneToOneDm?: boolean;
  config?: JinnConfig;
}): boolean {
  if (opts.source !== "slack" && opts.source !== "discord") return false;
  if (!hasIdentityConfig(opts.config)) return false;
  if (opts.oneToOneDm === true || isOneToOneDm(opts)) return isUntrustedSpeaker(opts);
  return opts.externalSpeakerSeen === true || opts.channelExternal === true || isUntrustedSpeaker(opts);
}

/** The key under which a session remembers that an untrusted speaker took part. */
export const EXTERNAL_SPEAKER_SEEN = "externalSpeakerSeen";

/** The audience fields of a stored session's transport metadata. */
export function audienceFromTransportMeta(meta: unknown): {
  speakerSlackId?: string;
  speakerDiscordId?: string;
  channelExternal?: boolean;
  externalSpeakerSeen?: boolean;
} {
  const record = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    speakerSlackId: text(record.speakerSlackId),
    speakerDiscordId: text(record.speakerDiscordId),
    channelExternal: record.channelExternal === true,
    externalSpeakerSeen: record[EXTERNAL_SPEAKER_SEEN] === true,
  };
}

/**
 * The audience of a stored session, for the paths that run it without a new
 * message from its connector (a wake-up, a restart replay, the web terminal).
 * The channel it replies to tells a one-to-one direct message from the rest.
 */
export function audienceOfSession(session: { source?: string | null; transportMeta?: unknown; replyContext?: unknown }): {
  speakerSlackId?: string;
  speakerDiscordId?: string;
  channelExternal?: boolean;
  externalSpeakerSeen?: boolean;
  oneToOneDm: boolean;
} {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const meta = record(session.transportMeta);
  const channel = record(session.replyContext).channel;
  return {
    ...audienceFromTransportMeta(session.transportMeta),
    oneToOneDm: isOneToOneDm({
      source: session.source ?? "",
      channel: typeof channel === "string" ? channel : undefined,
      isDM: meta.isDM === true,
      isGroupDM: meta.isGroupDM === true,
    }),
  };
}
