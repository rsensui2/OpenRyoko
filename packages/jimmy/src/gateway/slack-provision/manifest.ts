/**
 * The Slack app manifest OpenRyoko creates for a bot. One definition shared by
 * the automatic setup (apps.manifest.create / update) and anything that shows
 * the manifest for a manual paste.
 */

/** Slack caps display_information.name at 35 characters. */
export const SLACK_APP_NAME_MAX = 35;

export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "assistant:write",
  // Agents View Canvas uses the bot token, including for edits.
  "canvases:read",
  "canvases:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
];

export const SLACK_BOT_EVENTS: readonly string[] = [
  "app_mention",
  "assistant_thread_context_changed",
  "assistant_thread_started",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
];

export interface SlackAppManifest {
  display_information: { name: string; description?: string };
  features: Record<string, unknown>;
  oauth_config: { redirect_urls?: string[]; scopes: { bot: string[] } };
  settings: Record<string, unknown>;
}

/** Trimmed, length-checked app name, or null when it cannot be used. */
export function normalizeSlackAppName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > SLACK_APP_NAME_MAX) return null;
  return name;
}

/**
 * Socket Mode keeps the gateway reachable without a public URL; the redirect
 * URL is only set when the caller has an HTTPS address Slack can send the
 * installer back to (Slack refuses plain http, localhost included).
 */
export function buildSlackAppManifest(name: string, options: { redirectUrl?: string } = {}): SlackAppManifest {
  return {
    display_information: { name, description: `${name} — your AI assistant (OpenRyoko)` },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
      assistant_view: {
        assistant_description: `${name} — your AI assistant`,
        suggested_prompts: [{ title: "What can you do?", message: "What can you help me with?" }],
      },
    },
    oauth_config: {
      ...(options.redirectUrl ? { redirect_urls: [options.redirectUrl] } : {}),
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
