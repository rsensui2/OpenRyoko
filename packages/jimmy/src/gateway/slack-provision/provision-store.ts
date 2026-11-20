/**
 * What the automatic Slack setup must remember between steps: the app it
 * created (so setting up again updates it instead of making a second one),
 * the newest configuration refresh token (Slack rotates it on every use), the
 * pending install's OAuth state, and a bot token waiting for its app token.
 * Kept in one 0600 JSON file under the instance home.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../../shared/paths.js";

export interface SlackAppRecord {
  v: 1;
  teamId: string;
  /** Present only while a setup is in progress; dropped once Slack is connected. */
  configRefreshToken?: string;
  appId?: string;
  clientId?: string;
  clientSecret?: string;
  name?: string;
  redirectUrl?: string;
  /** The gateway address the relay page sends the installer back to (http setups). */
  returnTo?: string;
  oauthState?: { value: string; expiresAt: number };
  /** From a finished OAuth install; moved into config.yaml once the app token arrives. */
  pendingBotToken?: string;
  teamName?: string;
  updatedAt: string;
}

export const OAUTH_STATE_TTL_MS = 30 * 60_000;

let chain: Promise<unknown> = Promise.resolve();

/** Every read-modify-write of the record runs one at a time, so a slow Slack
 *  call in one step can never write back a copy older than another step's. */
export function withSlackRecordLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export function slackAppRecordPath(home: string = JINN_HOME): string {
  return path.join(home, "slack-app.json");
}

function isRecord(value: unknown): value is SlackAppRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SlackAppRecord>;
  return candidate.v === 1 && typeof candidate.teamId === "string";
}

export function readSlackAppRecord(home: string = JINN_HOME): SlackAppRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(slackAppRecordPath(home), "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSlackAppRecord(record: Omit<SlackAppRecord, "v" | "updatedAt">, home: string = JINN_HOME): SlackAppRecord {
  const next: SlackAppRecord = { ...record, v: 1, updatedAt: new Date().toISOString() };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = slackAppRecordPath(home);
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return next;
}

/** A one-use state. With `returnTo`, the gateway address rides along after a
 *  dot (base64url has none) so the static relay page knows where to send the
 *  installer; the whole string is still compared on the way back. */
export function newOAuthState(now: number = Date.now(), returnTo?: string): { value: string; expiresAt: number } {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const value = returnTo ? `${nonce}.${Buffer.from(returnTo, "utf8").toString("base64url")}` : nonce;
  return { value, expiresAt: now + OAUTH_STATE_TTL_MS };
}

export function oauthStateMatches(record: SlackAppRecord | null, presented: string, now: number = Date.now()): boolean {
  const expected = record?.oauthState;
  if (!expected || expected.expiresAt <= now || !presented) return false;
  const left = Buffer.from(expected.value);
  const right = Buffer.from(presented);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
