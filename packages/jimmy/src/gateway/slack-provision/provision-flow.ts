/**
 * The automatic Slack setup, modeled on pasting one configuration refresh
 * token: rotate it, create (or update) the bot's Slack app from our manifest,
 * set its picture, and hand back an install link. Slack has no API that mints
 * the Socket Mode app token, so that one paste stays with the person.
 *
 * Slack only sends the installer back to an HTTPS address. A gateway opened
 * over HTTPS uses its own callback; any other gateway uses a static relay page
 * (no server, nothing stored) that forwards the browser to the gateway address
 * carried in the state. The code it forwards is worthless without the client
 * secret, which never leaves the gateway.
 */
import { logger } from "../../shared/logger.js";
import { JINN_HOME } from "../../shared/paths.js";
import { buildSlackAppManifest } from "./manifest.js";
import {
  buildInstallUrl, createAppFromManifest, exchangeOAuthCode, rotateConfigToken, setAppIcon,
  slackAppPages, SlackProvisionError, updateAppManifest, type FetchLike,
} from "./slack-config-api.js";
import {
  botForOAuthState, newOAuthState, readSlackAppRecord, withSlackRecordLock, writeSlackAppRecord, type SlackAppRecord,
} from "./provision-store.js";

export const SLACK_OAUTH_CALLBACK_PATH = "/api/onboarding/slack/oauth/callback";
export const SLACK_CONFIG_REFRESH_PREFIX = "xoxe-";
export const DEFAULT_SLACK_OAUTH_RELAY_URL = "https://rsensui2.github.io/OpenRyoko/slack/callback/";
const ICON_MIN_PX = 512;
const ICON_MAX_PX = 2000;

export interface ProvisionDeps {
  fetchImpl?: FetchLike;
  home?: string;
  now?: () => number;
  /** Which Ryoko's Slack app: omitted or "main" for the main one, else a peer's name. */
  bot?: string;
}

export interface ProvisionInput {
  /** Omitted to reuse the refresh token kept from the last setup. */
  refreshToken?: string;
  name: string;
  iconPng?: Buffer;
  redirectUrl?: string;
  /** The gateway origin as the browser sees it; used with the relay page when there is no redirectUrl. */
  returnTo?: string;
  /** Make a new app even if one from an earlier setup is known (e.g. it cannot be updated). */
  fresh?: boolean;
}

export interface ProvisionResult {
  appId: string;
  teamId: string;
  created: boolean;
  installUrl?: string;
  pages: ReturnType<typeof slackAppPages>;
  icon: "set" | "skipped" | { error: string };
}

/** An HTTPS URL ending in our callback path, or null. Slack refuses http redirects. */
export function normalizeRedirectUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.pathname !== SLACK_OAUTH_CALLBACK_PATH || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The relay page to register when the gateway has no HTTPS address of its own. */
export function slackOAuthRelayUrl(): string {
  return normalizeHttpsUrl(process.env.OPENRYOKO_SLACK_OAUTH_RELAY) ?? DEFAULT_SLACK_OAUTH_RELAY_URL;
}

function normalizeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.search && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The origin of an http(s) gateway address, or null. */
export function normalizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 512) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Width and height from a PNG's IHDR chunk, or null for anything else. */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function slackIconProblem(png: Buffer): string | null {
  const size = readPngSize(png);
  if (!size) return "icon must be a PNG";
  const fits = (px: number) => px >= ICON_MIN_PX && px <= ICON_MAX_PX;
  return fits(size.width) && fits(size.height) ? null : `icon must be ${ICON_MIN_PX}–${ICON_MAX_PX}px`;
}

function keptAppFields(record: SlackAppRecord | null, teamId: string, fresh: boolean): Partial<SlackAppRecord> {
  if (!record || record.teamId !== teamId || fresh) return {};
  const { appId, clientId, clientSecret, name, teamName } = record;
  return { appId, clientId, clientSecret, name, teamName };
}

async function createOrUpdateApp(
  accessToken: string, kept: Partial<SlackAppRecord>, input: ProvisionInput, fetchImpl: FetchLike,
): Promise<{ appId: string; clientId: string; clientSecret: string; created: boolean }> {
  const manifest = buildSlackAppManifest(input.name, { redirectUrl: input.redirectUrl });
  if (kept.appId && kept.clientId && kept.clientSecret) {
    try {
      await updateAppManifest(accessToken, kept.appId, manifest, fetchImpl);
      return { appId: kept.appId, clientId: kept.clientId, clientSecret: kept.clientSecret, created: false };
    } catch (err) {
      // The app was deleted in Slack (or this token cannot see it): make a new one.
      const gone = err instanceof SlackProvisionError && ["app_not_found", "invalid_app_id", "invalid_app"].includes(err.code);
      if (!gone) throw err;
    }
  }
  const created = await createAppFromManifest(accessToken, manifest, fetchImpl);
  return { appId: created.appId, clientId: created.clientId, clientSecret: created.clientSecret, created: true };
}

async function trySetIcon(accessToken: string, appId: string, png: Buffer | undefined, fetchImpl: FetchLike): Promise<ProvisionResult["icon"]> {
  if (!png) return "skipped";
  try {
    await setAppIcon(accessToken, appId, png, fetchImpl);
    return "set";
  } catch (err) {
    return { error: err instanceof SlackProvisionError ? err.code : "icon_failed" };
  }
}

export function provisionSlackApp(input: ProvisionInput, deps: ProvisionDeps = {}): Promise<ProvisionResult> {
  return withSlackRecordLock(() => provisionLocked(input, deps))
}

async function provisionLocked(input: ProvisionInput, deps: ProvisionDeps): Promise<ProvisionResult> {
  const home = deps.home ?? JINN_HOME;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const bot = deps.bot;
  const record = readSlackAppRecord(home, bot);
  const refreshToken = input.refreshToken ?? record?.configRefreshToken;
  if (!refreshToken) throw new SlackProvisionError("config_token_required");

  const rotated = await rotateConfigToken(refreshToken, fetchImpl);
  // The pasted token is spent the moment Slack rotates it: keep the new one first.
  const kept = keptAppFields(record, rotated.teamId, Boolean(input.fresh));
  const saved = writeSlackAppRecord({ teamId: rotated.teamId, configRefreshToken: rotated.refreshToken, ...kept }, home, bot);

  const returnTo = input.redirectUrl ? undefined : input.returnTo;
  const redirectUrl = input.redirectUrl ?? (returnTo ? slackOAuthRelayUrl() : undefined);
  const app = await createOrUpdateApp(rotated.accessToken, kept, { ...input, redirectUrl }, fetchImpl);
  const oauthState = redirectUrl ? newOAuthState((deps.now ?? Date.now)(), returnTo) : undefined;
  try {
    // The configuration token is kept only until the app exists: it can edit
    // every app the person collaborates on, and this home is readable by the
    // engines. A failed create keeps it, since the pasted one is already spent.
    writeSlackAppRecord({
      ...saved, configRefreshToken: undefined, appId: app.appId, clientId: app.clientId, clientSecret: app.clientSecret,
      name: input.name, redirectUrl, returnTo, oauthState, pendingBotToken: undefined,
    }, home, bot);
  } catch (err) {
    // The app exists in Slack but its secret is lost: name it so it can be deleted there.
    logger.error(`[slack-provision] app ${app.appId} was ${app.created ? "created" : "updated"} but could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  const icon = await trySetIcon(rotated.accessToken, app.appId, input.iconPng, fetchImpl);
  const installUrl = oauthState && redirectUrl
    ? buildInstallUrl({ clientId: app.clientId, redirectUri: redirectUrl, state: oauthState.value, teamId: saved.teamId })
    : undefined;
  return { appId: app.appId, teamId: saved.teamId, created: app.created, installUrl, pages: slackAppPages(app.appId), icon };
}

/** A new install link for the app already made — after an expired or failed
 *  attempt — without rotating the token or touching the app in Slack. */
export function reissueInstallUrl(deps: ProvisionDeps = {}): Promise<string> {
  return withSlackRecordLock(async () => {
    const home = deps.home ?? JINN_HOME;
    const record = readSlackAppRecord(home, deps.bot);
    if (!record?.clientId || !record.redirectUrl) throw new SlackProvisionError("app_not_created");
    const oauthState = newOAuthState((deps.now ?? Date.now)(), record.returnTo);
    writeSlackAppRecord({ ...record, oauthState }, home, deps.bot);
    return buildInstallUrl({ clientId: record.clientId, redirectUri: record.redirectUrl, state: oauthState.value, teamId: record.teamId });
  });
}

/** Slack sends back only the state: the record (main or a peer's) is the
 *  one that issued it. `deps.bot` is not consulted here. */
export async function completeSlackOAuth(
  input: { code: string; state: string }, deps: ProvisionDeps = {},
): Promise<{ teamName?: string }> {
  const home = deps.home ?? JINN_HOME;
  // Spend the state first (one use, whatever Slack answers), then exchange
  // outside the lock, then merge into the record as it is by then.
  const app = await withSlackRecordLock(async () => {
    const bot = botForOAuthState(home, input.state, (deps.now ?? Date.now)());
    if (!bot) throw new SlackProvisionError("invalid_state");
    const record = readSlackAppRecord(home, bot)!;
    const { appId, clientId, clientSecret, redirectUrl, teamId } = record;
    if (!clientId || !clientSecret || !redirectUrl) throw new SlackProvisionError("app_not_created");
    writeSlackAppRecord({ ...record, oauthState: undefined }, home, bot);
    return { bot, appId, clientId, clientSecret, redirectUrl, teamId };
  });
  const installed = await exchangeOAuthCode(
    { clientId: app.clientId, clientSecret: app.clientSecret, code: input.code, redirectUri: app.redirectUrl }, deps.fetchImpl ?? fetch);
  if (installed.teamId !== app.teamId) throw new SlackProvisionError("wrong_workspace");
  return withSlackRecordLock(async () => {
    const latest = readSlackAppRecord(home, app.bot);
    if (!latest || latest.appId !== app.appId) throw new SlackProvisionError("app_changed");
    writeSlackAppRecord({ ...latest, pendingBotToken: installed.botToken, teamName: installed.teamName }, home, app.bot);
    return { teamName: installed.teamName };
  });
}

/** Slack reported the install was not completed (e.g. "Cancel"). Spends the
 *  state; false when it is not one this gateway issued, so a crafted link
 *  cannot make the gateway's own page show anything. */
export function cancelSlackOAuth(state: string, deps: ProvisionDeps = {}): Promise<boolean> {
  const home = deps.home ?? JINN_HOME;
  return withSlackRecordLock(async () => {
    const bot = botForOAuthState(home, state, (deps.now ?? Date.now)());
    if (!bot) return false;
    writeSlackAppRecord({ ...readSlackAppRecord(home, bot)!, oauthState: undefined }, home, bot);
    return true;
  });
}

export interface SlackProvisionStatus {
  hasConfigToken: boolean;
  teamId?: string;
  teamName?: string;
  appId?: string;
  name?: string;
  installed: boolean;
  pages?: ReturnType<typeof slackAppPages>;
}

/** What the wizard may show; never includes a token or secret. */
export function slackProvisionStatus(home: string = JINN_HOME, bot?: string): SlackProvisionStatus {
  const record = readSlackAppRecord(home, bot);
  if (!record) return { hasConfigToken: false, installed: false };
  return {
    hasConfigToken: Boolean(record.configRefreshToken),
    teamId: record.teamId,
    teamName: record.teamName,
    appId: record.appId,
    name: record.name,
    installed: Boolean(record.pendingBotToken),
    pages: record.appId ? slackAppPages(record.appId) : undefined,
  };
}

export function pendingBotToken(home: string = JINN_HOME, bot?: string): string | undefined {
  return readSlackAppRecord(home, bot)?.pendingBotToken;
}

/** Once Slack is connected, keep only what names the app. The configuration
 *  token is the person's own Slack credential (it can edit every app they
 *  collaborate on) and the instance home is readable by the engines, so it,
 *  the client secret and the bot token's second copy are not kept. */
export function forgetSlackSecrets(home: string = JINN_HOME, bot?: string): Promise<void> {
  return withSlackRecordLock(async () => {
    const record = readSlackAppRecord(home, bot);
    if (!record) return;
    writeSlackAppRecord({ teamId: record.teamId, teamName: record.teamName, appId: record.appId, name: record.name }, home, bot);
  });
}
