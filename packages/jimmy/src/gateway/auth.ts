import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { JinnConfig } from "../shared/types.js";

export const AUTH_COOKIE = "ryoko_auth";
export const AUTH_DEVICE_COOKIE = "ryoko_device";
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface StoredDevice {
  id: string;
  name: string;
  secretHash: string;
  createdAt: string;
  expiresAt?: string;
  lastSeenAt: string;
  lastIp?: string;
  userAgent?: string;
}

interface PairingEntry { expiresAt: number }

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function digest(namespace: string, value: string): string {
  return crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url");
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function ensureGatewayAuthToken(home: string): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "gateway-auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length >= 32) {
      fs.chmodSync(file, 0o600);
      return parsed.token;
    }
  } catch { /* create below */ }
  const token = crypto.randomBytes(32).toString("base64url");
  atomicJson(file, { token });
  return token;
}

export function readGatewayAuthToken(home: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, "gateway-auth.json"), "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch { return null; }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const raw = host.trim().toLowerCase();
  const hostname = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]") >= 0 ? raw.indexOf("]") : undefined)
    : raw.replace(/:\d+$/, "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
}

export function isNetworkHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "0.0.0.0" || !isLoopbackHost(normalized);
}

export function shouldRequireGatewayAuth(config: Pick<JinnConfig, "gateway">): boolean {
  if (config.gateway.authDisabled === true) return false;
  return config.gateway.authRequired === true || isNetworkHost(config.gateway.host);
}

export function validateGatewayExposure(config: Pick<JinnConfig, "gateway">): { ok: true } | { ok: false; error: string } {
  if (isNetworkHost(config.gateway.host) && config.gateway.authDisabled === true && config.gateway.insecureAllowUnauthenticatedNetwork !== true) {
    return { ok: false, error: "Refusing a network-exposed gateway without auth. Set gateway.insecureAllowUnauthenticatedNetwork=true only if you accept the risk." };
  }
  return { ok: true };
}

export function authRequiredForRequest(method: string | undefined, pathname: string): boolean {
  const verb = (method || "GET").toUpperCase();
  if (pathname === "/api/health" && verb === "GET") return false;
  if (pathname === "/api/auth/state" && verb === "GET") return false;
  if (pathname === "/api/auth/pair" && verb === "POST") return false;
  if (pathname === "/api/auth/logout" && verb === "POST") return false;
  if (pathname === "/api/internal/hook" && verb === "POST") return false;
  return pathname.startsWith("/api/") || pathname === "/ws" || pathname.startsWith("/ws/pty/");
}

export function gatewayRequestNeedsAuth(
  authRequired: boolean,
  method: string | undefined,
  pathname: string,
): boolean {
  const sensitiveAuthRoute = pathname === "/api/auth/pairing-codes" || pathname.startsWith("/api/auth/devices");
  return sensitiveAuthRoute || (authRequired && authRequiredForRequest(method, pathname));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of (header || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    try { result[key] = decodeURIComponent(item.slice(separator + 1).trim()); }
    catch { result[key] = item.slice(separator + 1).trim(); }
  }
  return result;
}

function cookieNamespace(home: string): string {
  const base = path.basename(path.resolve(home));
  if (base === ".ryoko" || base === ".jinn") return "";
  return base.replace(/^\./, "").replace(/[^A-Za-z0-9_-]/g, "");
}

export function authCookieName(home: string): string {
  const namespace = cookieNamespace(home);
  return namespace ? `${AUTH_COOKIE}_${namespace}` : AUTH_COOKIE;
}

export function authDeviceCookieName(home: string): string {
  const namespace = cookieNamespace(home);
  return namespace ? `${AUTH_DEVICE_COOKIE}_${namespace}` : AUTH_DEVICE_COOKIE;
}

function deviceFile(home: string): string { return path.join(home, "auth-devices.json"); }
function loadDevices(home: string): StoredDevice[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(deviceFile(home), "utf8")) as { devices?: unknown };
    return Array.isArray(parsed.devices) ? parsed.devices as StoredDevice[] : [];
  } catch { return []; }
}
function saveDevices(home: string, devices: StoredDevice[]): void { atomicJson(deviceFile(home), { devices }); }

function sessionExpiresAt(device: StoredDevice): number {
  const explicit = device.expiresAt ? Date.parse(device.expiresAt) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  const created = Date.parse(device.createdAt);
  return Number.isFinite(created) ? created + AUTH_SESSION_TTL_MS : 0;
}

function activeDevices(home: string, now: number): StoredDevice[] {
  const devices = loadDevices(home);
  const active = devices.filter((device) => sessionExpiresAt(device) > now);
  if (active.length !== devices.length) saveDevices(home, active);
  return active;
}

export function createAuthSession(home: string, req: Pick<IncomingMessage, "headers" | "socket">, now = Date.now()): { id: string; secret: string } {
  const createdAt = new Date(now).toISOString();
  const id = `d_${crypto.randomBytes(12).toString("base64url")}`;
  const secret = crypto.randomBytes(32).toString("base64url");
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  const device: StoredDevice = {
    id,
    name: userAgent?.includes("Mobile") ? "Mobile browser" : "Browser",
    secretHash: digest("ryoko-device", secret),
    createdAt,
    expiresAt: new Date(now + AUTH_SESSION_TTL_MS).toISOString(),
    lastSeenAt: createdAt,
    lastIp: req.socket.remoteAddress,
    userAgent,
  };
  saveDevices(home, [...loadDevices(home), device]);
  return { id, secret };
}

export function listAuthSessions(home: string, currentId?: string, now = Date.now()): Array<Omit<StoredDevice, "secretHash"> & { current: boolean }> {
  return activeDevices(home, now).map(({ secretHash: _secretHash, ...device }) => ({ ...device, current: device.id === currentId }));
}

export function revokeAuthSession(home: string, id: string): boolean {
  const devices = loadDevices(home);
  const next = devices.filter((device) => device.id !== id);
  if (next.length === devices.length) return false;
  saveDevices(home, next);
  return true;
}

export function verifyGatewayAuth(headers: IncomingMessage["headers"], expectedToken: string, home: string, now = Date.now()): boolean {
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && safeEqual(match[1], expectedToken)) return true;
  }
  const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  const cookies = parseCookies(cookieHeader);
  const id = cookies[authDeviceCookieName(home)];
  const secret = cookies[authCookieName(home)];
  if (!id || !secret) return false;
  const device = loadDevices(home).find((candidate) => candidate.id === id);
  return Boolean(
    device
    && sessionExpiresAt(device) > now
    && safeEqual(device.secretHash, digest("ryoko-device", secret)),
  );
}

function pairingFile(home: string): string { return path.join(home, "pairing-codes.json"); }
function loadPairing(home: string): Record<string, PairingEntry> {
  try { return JSON.parse(fs.readFileSync(pairingFile(home), "utf8")) as Record<string, PairingEntry>; }
  catch { return {}; }
}
function savePairing(home: string, entries: Record<string, PairingEntry>): void { atomicJson(pairingFile(home), entries); }

export function createPairingCode(): string {
  const bytes = crypto.randomBytes(12);
  const raw = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function issuePairingCode(home: string, now = Date.now()): { code: string; expiresAt: string } {
  const entries = loadPairing(home);
  for (const [hash, entry] of Object.entries(entries)) if (entry.expiresAt < now) delete entries[hash];
  const code = createPairingCode();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  entries[digest("ryoko-pairing", code.replace(/[^A-Z2-9]/gi, "").toUpperCase())] = { expiresAt };
  savePairing(home, entries);
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumePairingCode(home: string, raw: string, now = Date.now()): boolean {
  const normalized = raw.replace(/[^A-Z2-9]/gi, "").toUpperCase();
  if (normalized.length !== 12) return false;
  const entries = loadPairing(home);
  const hash = digest("ryoko-pairing", normalized);
  const entry = entries[hash];
  if (!entry) return false;
  delete entries[hash];
  savePairing(home, entries);
  return Boolean(entry && entry.expiresAt >= now);
}

export function authCookieHeaders(secret: string, deviceId: string, home: string, secure = false): string[] {
  const common = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1_000)}${secure ? "; Secure" : ""}`;
  return [
    `${authCookieName(home)}=${encodeURIComponent(secret)}; ${common}`,
    `${authDeviceCookieName(home)}=${encodeURIComponent(deviceId)}; ${common}`,
  ];
}

/** Trust proxy transport headers only when the operator opted in. */
export function requestFromTrustedProxy(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxyHeaders = false,
  trustedProxyAddresses: string[] = [],
): boolean {
  if (!trustProxyHeaders || !Array.isArray(trustedProxyAddresses)) return false;
  const remote = req.socket.remoteAddress;
  if (!remote) return false;
  const normalized = remote.toLowerCase().replace(/^::ffff:/, "");
  return trustedProxyAddresses.some((address) => (
    typeof address === "string"
    && address.trim().toLowerCase().replace(/^::ffff:/, "") === normalized
  ));
}

export function requestIsSecure(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxyHeaders = false,
  trustedProxyAddresses: string[] = [],
): boolean {
  if ((req.socket as TLSSocket).encrypted === true) return true;
  if (!requestFromTrustedProxy(req, trustProxyHeaders, trustedProxyAddresses)) return false;
  const forwarded = Array.isArray(req.headers["x-forwarded-proto"])
    ? req.headers["x-forwarded-proto"][0]
    : req.headers["x-forwarded-proto"];
  return forwarded?.split(",", 1)[0]?.trim().toLowerCase() === "https";
}

export function clearAuthCookieHeaders(home: string): string[] {
  return [
    `${authCookieName(home)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    `${authDeviceCookieName(home)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
}

export function currentDeviceId(headers: IncomingMessage["headers"], home: string): string | undefined {
  const raw = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  return parseCookies(raw)[authDeviceCookieName(home)];
}
