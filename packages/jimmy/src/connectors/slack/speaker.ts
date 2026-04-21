/**
 * Speaker identity resolution for Slack messages.
 *
 * Slack events only give a user ID (e.g. "U12345"). To distinguish
 * the current speaker from the Jinn operator, we resolve the user's
 * display name and real name via users.info, cache the result, and
 * pass the normalized info through transportMeta so buildContext can
 * render "Current speaker: X" separately from the operator identity.
 */

export interface SpeakerInfo {
  /** Best display name (display_name → real_name → handle → id) */
  name: string;
  /** Real name as configured in Slack profile */
  realName?: string;
  /** Self-chosen display name in Slack profile */
  displayName?: string;
  /** Slack handle (users.name) — legacy but stable */
  handle?: string;
  /** Whether this user is a bot/integration */
  isBot?: boolean;
  /** IANA timezone (e.g. "Asia/Tokyo") */
  tz?: string;
}

/**
 * Pure normalization: convert a Slack users.info response user object
 * into a SpeakerInfo record. Exposed for testing without the Slack client.
 */
export function normalizeSpeakerInfo(
  user: {
    id?: string;
    name?: string;
    real_name?: string;
    is_bot?: boolean;
    tz?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  } | null | undefined,
  fallbackId: string,
): SpeakerInfo {
  if (!user) {
    return { name: fallbackId };
  }

  const displayName = user.profile?.display_name?.trim() || undefined;
  const realName = user.real_name?.trim() || user.profile?.real_name?.trim() || undefined;
  const handle = user.name || undefined;

  return {
    name: displayName || realName || handle || user.id || fallbackId,
    realName,
    displayName,
    handle,
    isBot: user.is_bot ?? undefined,
    tz: user.tz || undefined,
  };
}
