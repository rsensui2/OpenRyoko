import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE,
  AUTH_DEVICE_COOKIE,
  AUTH_SESSION_TTL_MS,
  authCookieHeaders,
  authCookieName,
  authDeviceCookieName,
  authRequiredForRequest,
  consumePairingCode,
  createAuthSession,
  ensureGatewayAuthToken,
  gatewayRequestNeedsAuth,
  isLoopbackHost,
  issuePairingCode,
  requestIsSecure,
  shouldRequireGatewayAuth,
  validateGatewayExposure,
  verifyGatewayAuth,
} from "../auth.js";

function request(headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: "127.0.0.1" } } as never;
}

describe("gateway auth security", () => {
  it("persists the setup token with owner-only permissions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-auth-token-"));
    expect(ensureGatewayAuthToken(home)).toBe(ensureGatewayAuthToken(home));
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(home, "gateway-auth.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("requires auth automatically for network binds and refuses unsafe opt-out", () => {
    expect(isLoopbackHost("[::1]:7777")).toBe(true);
    expect(shouldRequireGatewayAuth({ gateway: { host: "127.0.0.1", port: 7777 } })).toBe(false);
    expect(shouldRequireGatewayAuth({ gateway: { host: "0.0.0.0", port: 7777 } })).toBe(true);
    expect(validateGatewayExposure({ gateway: { host: "0.0.0.0", port: 7777, authDisabled: true } }).ok).toBe(false);
    expect(validateGatewayExposure({ gateway: {
      host: "0.0.0.0",
      port: 7777,
      authDisabled: true,
      insecureAllowUnauthenticatedNetwork: true,
    } }).ok).toBe(true);
  });

  it("leaves only auth bootstrap routes and the separately secured hook public", () => {
    expect(authRequiredForRequest("GET", "/api/health")).toBe(false);
    expect(authRequiredForRequest("GET", "/api/auth/state")).toBe(false);
    expect(authRequiredForRequest("POST", "/api/auth/pair")).toBe(false);
    expect(authRequiredForRequest("POST", "/api/internal/hook")).toBe(false);
    expect(authRequiredForRequest("GET", "/api/status")).toBe(true);
    expect(authRequiredForRequest("GET", "/api/sessions")).toBe(true);
    expect(authRequiredForRequest("GET", "/ws/pty/id")).toBe(true);
    expect(gatewayRequestNeedsAuth(false, "POST", "/api/auth/pairing-codes")).toBe(true);
    expect(gatewayRequestNeedsAuth(false, "GET", "/api/auth/devices")).toBe(true);
    expect(gatewayRequestNeedsAuth(true, "GET", "/api/status")).toBe(true);
    expect(gatewayRequestNeedsAuth(true, "GET", "/api/health")).toBe(false);
  });

  it("uses hashed, expiring, single-use pairing codes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-pair-code-"));
    const issued = issuePairingCode(home, 1_000);
    const onDisk = fs.readFileSync(path.join(home, "pairing-codes.json"), "utf8");
    expect(onDisk).not.toContain(issued.code);
    expect(consumePairingCode(home, issued.code.toLowerCase().replaceAll("-", " "), 2_000)).toBe(true);
    const consumedState = fs.readFileSync(path.join(home, "pairing-codes.json"), "utf8");
    expect(consumePairingCode(home, issued.code, 2_001)).toBe(false);
    expect(fs.readFileSync(path.join(home, "pairing-codes.json"), "utf8")).toBe(consumedState);
  });

  it("expires browser sessions on the server as well as in the cookie", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-auth-expiry-"));
    const token = ensureGatewayAuthToken(home);
    const session = createAuthSession(home, request(), 1_000);
    const cookies = authCookieHeaders(session.secret, session.id, home)
      .map((header) => header.split(";", 1)[0])
      .join("; ");
    expect(verifyGatewayAuth({ cookie: cookies }, token, home, 1_000 + AUTH_SESSION_TTL_MS - 1)).toBe(true);
    expect(verifyGatewayAuth({ cookie: cookies }, token, home, 1_000 + AUTH_SESSION_TTL_MS)).toBe(false);
  });

  it("trusts forwarded HTTPS only when proxy headers are explicitly enabled", () => {
    const proxied = request({ "x-forwarded-proto": "https" });
    expect(requestIsSecure(proxied, false)).toBe(false);
    expect(requestIsSecure(proxied, true)).toBe(false);
    expect(requestIsSecure(proxied, true, ["127.0.0.1"])).toBe(true);
    const directTls = { headers: {}, socket: { encrypted: true } } as never;
    expect(requestIsSecure(directTls, false)).toBe(true);
  });

  it("accepts timing-safe bearer auth and hashed browser sessions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-auth-session-"));
    const token = ensureGatewayAuthToken(home);
    expect(verifyGatewayAuth({ authorization: `Bearer ${token}` }, token, home)).toBe(true);
    expect(verifyGatewayAuth({ authorization: "Bearer wrong" }, token, home)).toBe(false);

    const session = createAuthSession(home, request({ "user-agent": "Browser" }));
    const cookies = authCookieHeaders(session.secret, session.id, home)
      .map((header) => header.split(";", 1)[0])
      .join("; ");
    expect(cookies).toContain(`${authCookieName(home)}=`);
    expect(cookies).toContain(`${authDeviceCookieName(home)}=`);
    expect(verifyGatewayAuth({ cookie: cookies }, token, home)).toBe(true);
    expect(fs.readFileSync(path.join(home, "auth-devices.json"), "utf8")).not.toContain(session.secret);
  });

  it("namespaces browser cookies so same-host instances do not log each other out", () => {
    const defaultHome = path.join(os.homedir(), ".ryoko");
    const teamHome = path.join(os.homedir(), ".team-bot");
    expect(authCookieName(defaultHome)).toBe(AUTH_COOKIE);
    expect(authDeviceCookieName(defaultHome)).toBe(AUTH_DEVICE_COOKIE);
    expect(authCookieName(teamHome)).toBe(`${AUTH_COOKIE}_team-bot`);
    expect(authDeviceCookieName(teamHome)).toBe(`${AUTH_DEVICE_COOKIE}_team-bot`);
  });
});
