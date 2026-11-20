/**
 * HTTP surface of the automatic Slack setup. Returns false for any path it
 * does not own so api.ts can keep routing.
 *
 *   GET  /api/onboarding/slack/app             what has been set up (no secrets)
 *   POST /api/onboarding/slack/app             create/update the app from a config token
 *   POST /api/onboarding/slack/install-url     a new install link for the app already made
 *   GET  /api/onboarding/slack/oauth/callback  Slack's redirect after "Allow" (no gateway auth: the state is the capability)
 *   POST /api/onboarding/slack/finish          app token (+ bot token) → connect
 *
 * Every route but the callback takes an optional `bot` (`?bot=` on GET, a
 * body field on POST): omitted or "main" is the main Ryoko, any other value
 * names a peer Ryoko whose record is `slack-apps/<name>.json`. The callback
 * finds its record from the state alone.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../../shared/logger.js";
import { JINN_HOME } from "../../shared/paths.js";
import { isPeerName, MAIN_RYOKO } from "../../shared/peer-ryoko.js";
import { readJsonBody } from "../http-helpers.js";
import { normalizeSlackAppName } from "./manifest.js";
import {
  cancelSlackOAuth, completeSlackOAuth, forgetSlackSecrets, normalizeRedirectUrl, normalizeReturnTo, pendingBotToken, provisionSlackApp, reissueInstallUrl,
  SLACK_CONFIG_REFRESH_PREFIX, SLACK_OAUTH_CALLBACK_PATH, slackIconProblem, slackProvisionStatus,
} from "./provision-flow.js";
import { SlackProvisionError } from "./slack-config-api.js";

export interface SlackProvisionRouteDeps {
  /** The existing verify → save → reload (→ rollback) operation. */
  connect: (botToken: string, appToken: string) => Promise<{ ok: boolean }>;
  /** The same for a peer Ryoko: writes its `connectors.instances` entry. */
  connectPeer?: (bot: string, botToken: string, appToken: string) => Promise<{ ok: boolean }>;
  /** Whether a peer Ryoko of this name exists. Omitted: any valid name is accepted. */
  peerExists?: (name: string) => boolean;
  home?: string;
}

type BotChoice = { ok: true; bot?: string } | { ok: false; message: string };

/** undefined for the main Ryoko, the peer's name otherwise. */
function chooseBot(raw: unknown, deps: SlackProvisionRouteDeps): BotChoice {
  if (raw === undefined || raw === null || raw === "" || raw === MAIN_RYOKO) return { ok: true };
  if (!isPeerName(raw)) return { ok: false, message: "bot must be \"main\" or a Ryoko name" };
  if (deps.peerExists && !deps.peerExists(raw)) return { ok: false, message: `no Ryoko named ${raw}` };
  return { ok: true, bot: raw };
}

const ICON_MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_TOKEN_MAX = 2048;

function send(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function failure(res: ServerResponse, err: unknown, step: string): void {
  if (err instanceof SlackProvisionError) {
    logger.warn(`[slack-provision] ${step} failed: ${err.message}`);
    return send(res, { ok: false, error: err.code });
  }
  logger.error(`[slack-provision] ${step} crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  send(res, { ok: false, error: "internal_error" }, 500);
}

type ParsedProvision =
  | { ok: true; name: string; refreshToken?: string; iconPng?: Buffer; redirectUrl?: string; returnTo?: string; fresh: boolean }
  | { ok: false; message: string };

function parseProvisionBody(body: Record<string, unknown>): ParsedProvision {
  const name = normalizeSlackAppName(body.name);
  if (!name) return { ok: false, message: "name is required (1–35 characters)" };
  const token = typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
  if (token && (!token.startsWith(SLACK_CONFIG_REFRESH_PREFIX) || token.length > REFRESH_TOKEN_MAX)) {
    return { ok: false, message: "refreshToken must be a configuration refresh token (xoxe-…)" };
  }
  let iconPng: Buffer | undefined;
  if (body.icon !== undefined && body.icon !== null) {
    if (typeof body.icon !== "string") return { ok: false, message: "icon must be base64 PNG" };
    iconPng = Buffer.from(body.icon.replace(/^data:image\/png;base64,/, ""), "base64");
    if (iconPng.length > ICON_MAX_BYTES) return { ok: false, message: "icon is larger than 2MB" };
    const problem = slackIconProblem(iconPng);
    if (problem) return { ok: false, message: problem };
  }
  let redirectUrl: string | undefined;
  if (body.redirectUrl !== undefined && body.redirectUrl !== null && body.redirectUrl !== "") {
    const normalized = normalizeRedirectUrl(body.redirectUrl);
    if (!normalized) return { ok: false, message: `redirectUrl must be https://…${SLACK_OAUTH_CALLBACK_PATH}` };
    redirectUrl = normalized;
  }
  let returnTo: string | undefined;
  if (body.returnTo !== undefined && body.returnTo !== null && body.returnTo !== "") {
    const normalized = normalizeReturnTo(body.returnTo);
    if (!normalized) return { ok: false, message: "returnTo must be an http(s) address" };
    returnTo = normalized;
  }
  return { ok: true, name, refreshToken: token || undefined, iconPng, redirectUrl, returnTo, fresh: body.fresh === true };
}

async function handleProvision(req: IncomingMessage, res: ServerResponse, deps: SlackProvisionRouteDeps): Promise<void> {
  const read = await readJsonBody(req, res, { maxBytes: 4 * 1024 * 1024 });
  if (!read.ok) return;
  const body = (read.body && typeof read.body === "object" ? read.body : {}) as Record<string, unknown>;
  const chosen = chooseBot(body.bot, deps);
  if (!chosen.ok) return send(res, { error: chosen.message }, 400);
  const parsed = parseProvisionBody(body);
  if (!parsed.ok) return send(res, { error: parsed.message }, 400);
  try {
    const { ok: _ok, ...input } = parsed;
    send(res, { ok: true, ...(await provisionSlackApp(input, { bot: chosen.bot, home: deps.home })) });
  } catch (err) {
    failure(res, err, "provision");
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function sendPage(res: ServerResponse, title: string, message: string, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7">
<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">OpenRyoko に戻る</a></p></body></html>`);
}

async function handleCallback(url: URL, res: ServerResponse, home?: string): Promise<void> {
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const denied = url.searchParams.get("error");
  if (denied) {
    // Only a state this gateway issued gets an answer, and the text is fixed:
    // nothing from the URL is shown on the gateway's own address.
    if (!state || !(await cancelSlackOAuth(state, { home }))) return sendPage(res, "Slack から戻れませんでした", "このリンクは使えません。元の画面からもう一度お試しください。", 400);
    return sendPage(res, "Slack への追加は中止されました", denied === "access_denied"
      ? "「キャンセル」が押されたので、追加しませんでした。元の画面から「Slack で許可する」をもう一度押せます。"
      : "Slack が追加を完了しませんでした。元の画面から「リンクを作り直す」を押して、もう一度お試しください。");
  }
  if (!code || !state) return sendPage(res, "Slack から戻れませんでした", "code または state がありません。", 400);
  try {
    const { teamName } = await completeSlackOAuth({ code, state }, { home });
    sendPage(res, "Slack に追加できました", `${teamName ? `ワークスペース「${teamName}」に` : ""}追加しました。このタブを閉じて、元の画面の続きに進んでください。`);
  } catch (err) {
    const code = err instanceof SlackProvisionError ? err.code : "internal_error";
    logger.warn(`[slack-provision] oauth callback failed: ${err instanceof Error ? err.message : String(err)}`);
    sendPage(res, "Slack への追加を完了できませんでした", `理由: ${code}。元の画面からもう一度お試しください。`, 400);
  }
}

async function handleFinish(req: IncomingMessage, res: ServerResponse, deps: SlackProvisionRouteDeps): Promise<void> {
  const read = await readJsonBody(req, res, { maxBytes: 16 * 1024 });
  if (!read.ok) return;
  const body = (read.body && typeof read.body === "object" ? read.body : {}) as Record<string, unknown>;
  const chosen = chooseBot(body.bot, deps);
  if (!chosen.ok) return send(res, { error: chosen.message }, 400);
  const { bot } = chosen;
  if (bot && !deps.connectPeer) return send(res, { error: "this gateway cannot connect a peer Ryoko" }, 400);
  const home = deps.home ?? JINN_HOME;
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
  const pasted = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const botToken = pasted || pendingBotToken(home, bot) || "";
  if (!appToken.startsWith("xapp-")) return send(res, { error: "appToken must start with xapp-" }, 400);
  if (!botToken.startsWith("xoxb-")) return send(res, { ok: false, error: "bot_token_required" });
  try {
    const outcome = bot ? await deps.connectPeer!(bot, botToken, appToken) : await deps.connect(botToken, appToken);
    if (outcome.ok) await forgetSlackSecrets(home, bot);
    send(res, outcome);
  } catch (err) {
    failure(res, err, "finish");
  }
}

async function handleInstallUrl(req: IncomingMessage, res: ServerResponse, deps: SlackProvisionRouteDeps): Promise<void> {
  // The body is optional: the main Ryoko's wizard sends none.
  const read = await readJsonBody(req, res, { maxBytes: 16 * 1024, allowEmpty: true });
  if (!read.ok) return;
  const body = (read.body && typeof read.body === "object" ? read.body : {}) as Record<string, unknown>;
  const chosen = chooseBot(body.bot, deps);
  if (!chosen.ok) return send(res, { error: chosen.message }, 400);
  try {
    send(res, { ok: true, installUrl: await reissueInstallUrl({ bot: chosen.bot, home: deps.home }) });
  } catch (err) {
    failure(res, err, "install-url");
  }
}

export async function handleSlackProvisionApi(
  req: IncomingMessage, res: ServerResponse,
  route: { method: string; pathname: string; url: URL }, deps: SlackProvisionRouteDeps,
): Promise<boolean> {
  const { method, pathname, url } = route;
  if (pathname === "/api/onboarding/slack/app" && method === "GET") {
    const chosen = chooseBot(url.searchParams.get("bot"), deps);
    if (!chosen.ok) send(res, { error: chosen.message }, 400);
    else send(res, slackProvisionStatus(deps.home ?? JINN_HOME, chosen.bot));
    return true;
  }
  if (pathname === "/api/onboarding/slack/app" && method === "POST") {
    await handleProvision(req, res, deps);
    return true;
  }
  if (pathname === "/api/onboarding/slack/install-url" && method === "POST") {
    await handleInstallUrl(req, res, deps);
    return true;
  }
  if (pathname === SLACK_OAUTH_CALLBACK_PATH && method === "GET") {
    await handleCallback(url, res, deps.home);
    return true;
  }
  if (pathname === "/api/onboarding/slack/finish" && method === "POST") {
    await handleFinish(req, res, deps);
    return true;
  }
  return false;
}
