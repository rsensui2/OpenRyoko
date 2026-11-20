/**
 * Thin wrappers around the Slack Web API methods the automatic app setup
 * needs. Every call takes an injectable fetch so the flow can be tested
 * without the network, and every failure surfaces as a SlackProvisionError
 * carrying Slack's own error code (or one of ours) — never a token.
 */
import { SLACK_BOT_SCOPES, type SlackAppManifest } from "./manifest.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 15_000;

export class SlackProvisionError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SlackProvisionError";
  }
}

type SlackPayload = { ok?: boolean; error?: string; [key: string]: unknown };

async function callSlack(method: string, body: URLSearchParams | FormData, token: string | null, fetchImpl: FetchLike): Promise<SlackPayload> {
  let response: Response;
  try {
    response = await fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SlackProvisionError("network_error", err instanceof Error ? err.message : String(err));
  }
  if (response.status === 429) throw new SlackProvisionError("rate_limited");
  if (!response.ok) throw new SlackProvisionError(`http_${response.status}`);
  const payload = (await response.json()) as SlackPayload;
  if (payload.ok !== true) {
    const detail = Array.isArray(payload.errors) ? JSON.stringify(payload.errors).slice(0, 500) : undefined;
    throw new SlackProvisionError(payload.error ?? `${method}_failed`, detail);
  }
  return payload;
}

function requireString(payload: Record<string, unknown> | undefined, key: string, method: string): string {
  const value = payload?.[key];
  if (typeof value !== "string" || !value) throw new SlackProvisionError("unexpected_response", `${method}.${key}`);
  return value;
}

export interface RotatedConfigToken {
  accessToken: string;
  /** Slack hands back a fresh refresh token on every rotation; keep only the newest. */
  refreshToken: string;
  teamId: string;
  userId?: string;
  expiresAt?: number;
}

export async function rotateConfigToken(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<RotatedConfigToken> {
  const payload = await callSlack("tooling.tokens.rotate", new URLSearchParams({ refresh_token: refreshToken }), null, fetchImpl);
  return {
    accessToken: requireString(payload, "token", "tooling.tokens.rotate"),
    refreshToken: requireString(payload, "refresh_token", "tooling.tokens.rotate"),
    teamId: requireString(payload, "team_id", "tooling.tokens.rotate"),
    userId: typeof payload.user_id === "string" ? payload.user_id : undefined,
    expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : undefined,
  };
}

export interface CreatedSlackApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret?: string;
}

export async function createAppFromManifest(accessToken: string, manifest: SlackAppManifest, fetchImpl: FetchLike = fetch): Promise<CreatedSlackApp> {
  const body = new URLSearchParams({ manifest: JSON.stringify(manifest) });
  const payload = await callSlack("apps.manifest.create", body, accessToken, fetchImpl);
  const credentials = payload.credentials as Record<string, unknown> | undefined;
  return {
    appId: requireString(payload, "app_id", "apps.manifest.create"),
    clientId: requireString(credentials, "client_id", "apps.manifest.create"),
    clientSecret: requireString(credentials, "client_secret", "apps.manifest.create"),
    signingSecret: typeof credentials?.signing_secret === "string" ? credentials.signing_secret : undefined,
  };
}

export async function updateAppManifest(accessToken: string, appId: string, manifest: SlackAppManifest, fetchImpl: FetchLike = fetch): Promise<void> {
  const body = new URLSearchParams({ app_id: appId, manifest: JSON.stringify(manifest) });
  await callSlack("apps.manifest.update", body, accessToken, fetchImpl);
}

/** Slack wants a 512–2000px square-ish image; the caller checks the size. */
export async function setAppIcon(accessToken: string, appId: string, png: Buffer, fetchImpl: FetchLike = fetch): Promise<void> {
  const form = new FormData();
  form.set("app_id", appId);
  form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "icon.png");
  await callSlack("apps.icon.set", form, accessToken, fetchImpl);
}

export interface InstalledBot {
  botToken: string;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
}

export async function exchangeOAuthCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<InstalledBot> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const payload = await callSlack("oauth.v2.access", body, null, fetchImpl);
  const botToken = requireString(payload, "access_token", "oauth.v2.access");
  if (!botToken.startsWith("xoxb-")) throw new SlackProvisionError("unexpected_response", "oauth.v2.access token type");
  const team = payload.team as Record<string, unknown> | undefined;
  return {
    botToken,
    teamId: typeof team?.id === "string" ? team.id : undefined,
    teamName: typeof team?.name === "string" ? team.name : undefined,
    botUserId: typeof payload.bot_user_id === "string" ? payload.bot_user_id : undefined,
  };
}

export function buildInstallUrl(input: { clientId: string; redirectUri: string; state: string; teamId?: string }): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  if (input.teamId) url.searchParams.set("team", input.teamId);
  return url.toString();
}

/** The app's own pages, for the steps Slack offers no API for. */
export function slackAppPages(appId: string): { settings: string; appToken: string; install: string; oauth: string } {
  const base = `https://api.slack.com/apps/${encodeURIComponent(appId)}`;
  return {
    settings: base,
    appToken: `${base}/general#app-level-tokens`,
    install: `${base}/install-on-team`,
    oauth: `${base}/oauth`,
  };
}
