import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRequiredForRequest } from "../auth.js";
import {
  completeSlackOAuth, DEFAULT_SLACK_OAUTH_RELAY_URL, forgetSlackSecrets, provisionSlackApp, readPngSize, reissueInstallUrl,
  slackProvisionStatus,
} from "../slack-provision/provision-flow.js";
import { readSlackAppRecord, slackAppRecordPath, writeSlackAppRecord } from "../slack-provision/provision-store.js";
import { handleSlackProvisionApi } from "../slack-provision/routes.js";
import type { FetchLike } from "../slack-provision/slack-config-api.js";

/* The automatic Slack setup. Properties under test: a pasted refresh token is
 * spent once and its rotation is always kept; setting up again updates the
 * same app instead of creating another; an install only completes with the
 * state this gateway issued; no secret ever reaches the status answer. */

const REDIRECT = "https://ryoko.example.ts.net/api/onboarding/slack/oauth/callback";

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

type Answer = Record<string, unknown>;

function slackStub(answers: Record<string, Answer | ((call: number) => Answer)>): { fetchImpl: FetchLike; calls: string[]; bodies: Array<URLSearchParams | FormData> } {
  const calls: string[] = [];
  const bodies: Array<URLSearchParams | FormData> = [];
  const count: Record<string, number> = {};
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const method = input.split("/api/")[1]!;
    calls.push(method);
    bodies.push(init?.body as URLSearchParams | FormData);
    count[method] = (count[method] ?? 0) + 1;
    const answer = answers[method];
    const payload = typeof answer === "function" ? answer(count[method]!) : answer ?? { ok: false, error: "unstubbed" };
    return { ok: true, status: 200, json: async () => payload } as Response;
  });
  return { fetchImpl, calls, bodies };
}

const rotate = (call: number): Answer => ({ ok: true, token: `xoxe.xoxp-ACCESS${call}`, refresh_token: `xoxe-1-NEXT${call}`, team_id: "T1", user_id: "U1", exp: 1 });
const created = { ok: true, app_id: "A1", credentials: { client_id: "C.1", client_secret: "SECRET", signing_secret: "SIGN" } };

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "slack-provision-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe("provisionSlackApp", () => {
  it("rotates the token, creates the app, sets the icon and returns an install link", async () => {
    const { fetchImpl, calls } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created, "apps.icon.set": { ok: true } });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", iconPng: png(512, 512), redirectUrl: REDIRECT }, { fetchImpl, home });

    expect(calls).toEqual(["tooling.tokens.rotate", "apps.manifest.create", "apps.icon.set"]);
    expect(result).toMatchObject({ appId: "A1", teamId: "T1", created: true, icon: "set" });
    const install = new URL(result.installUrl!);
    expect(install.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(install.searchParams.get("state")).toBe(readSlackAppRecord(home)!.oauthState!.value);
    // The configuration token is dropped once the app exists.
    expect(readSlackAppRecord(home)!.configRefreshToken).toBeUndefined();
    expect(fs.statSync(slackAppRecordPath(home)).mode & 0o777).toBe(0o600);
  });

  it("puts Socket Mode and the redirect URL in the manifest", async () => {
    const { fetchImpl, bodies } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", redirectUrl: REDIRECT }, { fetchImpl, home });
    const manifest = JSON.parse((bodies[1] as URLSearchParams).get("manifest")!);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.oauth_config.redirect_urls).toEqual([REDIRECT]);
    expect(manifest.features.bot_user.display_name).toBe("Ryoko");
  });

  it("keeps the rotated refresh token even when creating the app fails", async () => {
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": { ok: false, error: "invalid_manifest" } });
    await expect(provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko" }, { fetchImpl, home }))
      .rejects.toMatchObject({ code: "invalid_manifest" });
    expect(readSlackAppRecord(home)!.configRefreshToken).toBe("xoxe-1-NEXT1");
  });

  it("updates the same app on a second setup with a newly pasted token", async () => {
    const { fetchImpl, calls, bodies } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created, "apps.manifest.update": { ok: true } });
    await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko" }, { fetchImpl, home });
    await expect(provisionSlackApp({ name: "Ryoko 2" }, { fetchImpl, home })).rejects.toMatchObject({ code: "config_token_required" });
    const again = await provisionSlackApp({ refreshToken: "xoxe-1-SECOND", name: "Ryoko 2" }, { fetchImpl, home });

    expect(calls).toEqual(["tooling.tokens.rotate", "apps.manifest.create", "tooling.tokens.rotate", "apps.manifest.update"]);
    expect((bodies[2] as URLSearchParams).get("refresh_token")).toBe("xoxe-1-SECOND");
    expect(again).toMatchObject({ appId: "A1", created: false, installUrl: undefined });
    expect(readSlackAppRecord(home)!.configRefreshToken).toBeUndefined();
  });

  it("retries a failed create with the token it kept, then drops it", async () => {
    const answers = { "tooling.tokens.rotate": rotate, "apps.manifest.create": (call: number): Answer => call === 1 ? { ok: false, error: "ratelimited" } : created };
    const { fetchImpl, bodies } = slackStub(answers);
    await expect(provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko" }, { fetchImpl, home })).rejects.toMatchObject({ code: "ratelimited" });
    const retried = await provisionSlackApp({ name: "Ryoko" }, { fetchImpl, home });
    expect((bodies[2] as URLSearchParams).get("refresh_token")).toBe("xoxe-1-NEXT1");
    expect(retried.created).toBe(true);
    expect(readSlackAppRecord(home)!.configRefreshToken).toBeUndefined();
  });

  it("creates a new app when the kept one was deleted in Slack", async () => {
    const { fetchImpl, calls } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created, "apps.manifest.update": { ok: false, error: "app_not_found" } });
    await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko" }, { fetchImpl, home });
    const again = await provisionSlackApp({ refreshToken: "xoxe-1-SECOND", name: "Ryoko" }, { fetchImpl, home });
    expect(calls.slice(2)).toEqual(["tooling.tokens.rotate", "apps.manifest.update", "apps.manifest.create"]);
    expect(again.created).toBe(true);
  });

  it("asks for a token when none was pasted or kept", async () => {
    const { fetchImpl, calls } = slackStub({});
    await expect(provisionSlackApp({ name: "Ryoko" }, { fetchImpl, home })).rejects.toMatchObject({ code: "config_token_required" });
    expect(calls).toEqual([]);
  });

  it("reports an icon Slack refused without failing the setup", async () => {
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created, "apps.icon.set": { ok: false, error: "invalid_dimensions" } });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", iconPng: png(600, 600) }, { fetchImpl, home });
    expect(result.icon).toEqual({ error: "invalid_dimensions" });
  });
});

describe("completeSlackOAuth", () => {
  async function provisioned(): Promise<string> {
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", redirectUrl: REDIRECT }, { fetchImpl, home });
    return new URL(result.installUrl!).searchParams.get("state")!;
  }

  it("exchanges the code with the stored client secret and keeps the bot token", async () => {
    const state = await provisioned();
    const { fetchImpl, bodies } = slackStub({ "oauth.v2.access": { ok: true, access_token: "xoxb-BOT", team: { id: "T1", name: "Example Team" }, bot_user_id: "B1" } });
    await expect(completeSlackOAuth({ code: "CODE", state }, { fetchImpl, home })).resolves.toEqual({ teamName: "Example Team" });
    const sent = bodies[0] as URLSearchParams;
    expect(sent.get("client_secret")).toBe("SECRET");
    expect(sent.get("redirect_uri")).toBe(REDIRECT);
    const stored = readSlackAppRecord(home)!;
    expect(stored.pendingBotToken).toBe("xoxb-BOT");
    expect(stored.oauthState).toBeUndefined();
  });

  it("refuses a state it did not issue, and a state used twice", async () => {
    const state = await provisioned();
    const { fetchImpl } = slackStub({ "oauth.v2.access": { ok: true, access_token: "xoxb-BOT", team: { id: "T1" } } });
    await expect(completeSlackOAuth({ code: "CODE", state: "forged" }, { fetchImpl, home })).rejects.toMatchObject({ code: "invalid_state" });
    await completeSlackOAuth({ code: "CODE", state }, { fetchImpl, home });
    await expect(completeSlackOAuth({ code: "CODE", state }, { fetchImpl, home })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refuses an expired state", async () => {
    const state = await provisioned();
    const { fetchImpl } = slackStub({});
    const later = () => Date.now() + 31 * 60_000;
    await expect(completeSlackOAuth({ code: "CODE", state }, { fetchImpl, home, now: later })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refuses an install into another workspace", async () => {
    const state = await provisioned();
    const { fetchImpl } = slackStub({ "oauth.v2.access": { ok: true, access_token: "xoxb-BOT", team: { id: "T-OTHER" } } });
    await expect(completeSlackOAuth({ code: "CODE", state }, { fetchImpl, home })).rejects.toMatchObject({ code: "wrong_workspace" });
    expect(readSlackAppRecord(home)!.pendingBotToken).toBeUndefined();
  });
});

describe("slackProvisionStatus", () => {
  it("never includes a token or secret", () => {
    writeSlackAppRecord({ teamId: "T1", configRefreshToken: "xoxe-1-X", appId: "A1", clientId: "C.1", clientSecret: "SECRET", pendingBotToken: "xoxb-BOT" }, home);
    const status = JSON.stringify(slackProvisionStatus(home));
    expect(status).not.toMatch(/xoxe-|xoxb-|SECRET/);
    expect(slackProvisionStatus(home)).toMatchObject({ hasConfigToken: true, appId: "A1", installed: true });
  });
});

describe("readPngSize", () => {
  it("reads IHDR dimensions and rejects non-PNG data", () => {
    expect(readPngSize(png(512, 1024))).toEqual({ width: 512, height: 1024 });
    expect(readPngSize(Buffer.from("GIF89a-not-a-png-at-all-really"))).toBeNull();
  });
});

describe("HTTP routes", () => {
  function post(pathname: string, body: unknown): IncomingMessage {
    const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
    readable.method = "POST";
    readable.url = pathname;
    return readable;
  }

  function response(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
    let status = 0;
    const chunks: string[] = [];
    const res = {
      writeHead(code: number) { status = code; return this; },
      setHeader() { return this; },
      end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
    } as unknown as ServerResponse;
    return { res, read: () => ({ status, body: chunks.length ? JSON.parse(chunks.join("")) : null }) };
  }

  async function call(pathname: string, body: unknown, connect = vi.fn()): Promise<{ status: number; body: unknown }> {
    const { res, read } = response();
    const url = new URL(pathname, "http://127.0.0.1");
    const handled = await handleSlackProvisionApi(post(pathname, body), res, { method: "POST", pathname, url }, { connect });
    expect(handled).toBe(true);
    return read();
  }

  it.each([
    [{ name: "Ryoko", refreshToken: "xoxb-wrong-kind" }, /refreshToken/],
    [{ name: "", refreshToken: "xoxe-1-A" }, /name/],
    [{ name: "x".repeat(36), refreshToken: "xoxe-1-A" }, /name/],
    [{ name: "Ryoko", redirectUrl: "http://127.0.0.1:7777/api/onboarding/slack/oauth/callback" }, /redirectUrl/],
    [{ name: "Ryoko", icon: png(64, 64).toString("base64") }, /icon/],
    [{ name: "Ryoko", returnTo: "javascript:alert(1)" }, /returnTo/],
    [{ name: "Ryoko", returnTo: "http://user:pw@127.0.0.1:7777" }, /returnTo/],
  ])("rejects %j before calling Slack", async (body, message) => {
    const { status, body: answer } = await call("/api/onboarding/slack/app", body);
    expect(status).toBe(400);
    expect((answer as { error: string }).error).toMatch(message);
  });

  it("finish rejects a non-app token and asks for a bot token when none is pending", async () => {
    expect((await call("/api/onboarding/slack/finish", { appToken: "xoxb-1" })).status).toBe(400);
    const connect = vi.fn();
    const { body } = await call("/api/onboarding/slack/finish", { appToken: "xapp-1" }, connect);
    expect(body).toEqual({ ok: false, error: "bot_token_required" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("finish connects with a pasted bot token", async () => {
    const connect = vi.fn().mockResolvedValue({ ok: true, team: "Example Team" });
    const { body } = await call("/api/onboarding/slack/finish", { appToken: "xapp-1", botToken: "xoxb-PASTED" }, connect);
    expect(connect).toHaveBeenCalledWith("xoxb-PASTED", "xapp-1");
    expect(body).toEqual({ ok: true, team: "Example Team" });
  });

  it("leaves other paths alone", async () => {
    const { res } = response();
    const url = new URL("/api/onboarding/slack/connect", "http://127.0.0.1");
    expect(await handleSlackProvisionApi(post(url.pathname, {}), res, { method: "POST", pathname: url.pathname, url }, { connect: vi.fn() })).toBe(false);
  });
});

describe("review fixes", () => {
  async function provisioned(fetchAnswers: Record<string, Answer | ((call: number) => Answer)> = {}): Promise<string> {
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created, ...fetchAnswers });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", redirectUrl: REDIRECT }, { fetchImpl, home });
    return new URL(result.installUrl!).searchParams.get("state")!;
  }

  it("a setup that runs while Slack answers the install does not get its rotated token overwritten", async () => {
    const state = await provisioned();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowExchange: FetchLike = async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ ok: true, access_token: "xoxb-BOT", team: { id: "T1" } }) } as Response;
    };
    const pending = completeSlackOAuth({ code: "CODE", state }, { fetchImpl: slowExchange, home });
    await vi.waitFor(() => expect(readSlackAppRecord(home)!.oauthState).toBeUndefined());

    const rotateAgain = (): Answer => ({ ok: true, token: "xoxe.xoxp-A", refresh_token: "xoxe-1-LATEST", team_id: "T1" });
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotateAgain, "apps.manifest.update": { ok: true } });
    const second = await provisionSlackApp({ refreshToken: "xoxe-1-AGAIN", name: "Ryoko 2", redirectUrl: REDIRECT }, { fetchImpl, home });
    release();
    await pending;

    // The exchange merged into the record as the second setup left it.
    const record = readSlackAppRecord(home)!;
    expect(record.name).toBe("Ryoko 2");
    expect(record.oauthState?.value).toBe(new URL(second.installUrl!).searchParams.get("state"));
    expect(record.configRefreshToken).toBeUndefined();
    expect(record.pendingBotToken).toBe("xoxb-BOT");
  });

  it("a failed exchange can be retried with a reissued link", async () => {
    const state = await provisioned();
    const failing = slackStub({ "oauth.v2.access": { ok: false, error: "invalid_code" } });
    await expect(completeSlackOAuth({ code: "BAD", state }, { fetchImpl: failing.fetchImpl, home })).rejects.toMatchObject({ code: "invalid_code" });
    const next = new URL(await reissueInstallUrl({ home })).searchParams.get("state")!;
    expect(next).not.toBe(state);
    const ok = slackStub({ "oauth.v2.access": { ok: true, access_token: "xoxb-BOT", team: { id: "T1" } } });
    await completeSlackOAuth({ code: "GOOD", state: next }, { fetchImpl: ok.fetchImpl, home });
    expect(readSlackAppRecord(home)!.pendingBotToken).toBe("xoxb-BOT");
  });

  it("fresh: true creates a new app instead of updating the known one", async () => {
    await provisioned();
    const { fetchImpl, calls } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": { ...created, app_id: "A2" } });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-SECOND", name: "Ryoko", fresh: true }, { fetchImpl, home });
    expect(calls).toEqual(["tooling.tokens.rotate", "apps.manifest.create"]);
    expect(result.appId).toBe("A2");
  });

  it("forgets the config token, client secret and bot token once connected", async () => {
    await provisioned();
    writeSlackAppRecord({ ...readSlackAppRecord(home)!, pendingBotToken: "xoxb-BOT", teamName: "Example Team" }, home);
    await forgetSlackSecrets(home);
    const raw = fs.readFileSync(slackAppRecordPath(home), "utf8");
    expect(raw).not.toMatch(/xoxe-|xoxb-|SECRET|C\.1/);
    expect(slackProvisionStatus(home)).toMatchObject({ hasConfigToken: false, appId: "A1", teamName: "Example Team", installed: false });
  });

  it("lets only the callback GET through without gateway auth", () => {
    expect(authRequiredForRequest("GET", "/api/onboarding/slack/oauth/callback")).toBe(false);
    expect(authRequiredForRequest("POST", "/api/onboarding/slack/oauth/callback")).toBe(true);
    expect(authRequiredForRequest("GET", "/api/onboarding/slack/app")).toBe(true);
  });
});

describe("relay page for gateways without HTTPS", () => {
  const RETURN_TO = "http://127.0.0.1:17777";
  const stateReturnTo = (state: string) => Buffer.from(state.split(".")[1]!, "base64url").toString("utf8");

  it("registers the relay page and carries the gateway address in the state", async () => {
    const { fetchImpl, bodies } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", returnTo: RETURN_TO }, { fetchImpl, home });

    const manifest = JSON.parse((bodies[1] as URLSearchParams).get("manifest")!);
    expect(manifest.oauth_config.redirect_urls).toEqual([DEFAULT_SLACK_OAUTH_RELAY_URL]);
    const install = new URL(result.installUrl!);
    expect(install.searchParams.get("redirect_uri")).toBe(DEFAULT_SLACK_OAUTH_RELAY_URL);
    expect(stateReturnTo(install.searchParams.get("state")!)).toBe(RETURN_TO);
  });

  it("prefers the gateway's own HTTPS callback when it has one", async () => {
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", redirectUrl: REDIRECT, returnTo: RETURN_TO }, { fetchImpl, home });
    const install = new URL(result.installUrl!);
    expect(install.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(install.searchParams.get("state")).not.toContain(".");
    expect(readSlackAppRecord(home)!.returnTo).toBeUndefined();
  });

  it("exchanges the code with the relay URL it registered, and a reissued link keeps the address", async () => {
    const { fetchImpl, bodies } = slackStub({
      "tooling.tokens.rotate": rotate, "apps.manifest.create": created,
      "oauth.v2.access": { ok: true, access_token: "xoxb-BOT", team: { id: "T1", name: "Example Team" } },
    });
    await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", returnTo: RETURN_TO }, { fetchImpl, home });
    const again = new URL(await reissueInstallUrl({ home }));
    const state = again.searchParams.get("state")!;
    expect(stateReturnTo(state)).toBe(RETURN_TO);

    await completeSlackOAuth({ code: "CODE", state }, { fetchImpl, home });
    expect((bodies.at(-1) as URLSearchParams).get("redirect_uri")).toBe(DEFAULT_SLACK_OAUTH_RELAY_URL);
    expect(slackProvisionStatus(home).installed).toBe(true);
  });
});

describe("callback refusals", () => {
  async function callbackPage(query: string): Promise<{ status: number; html: string }> {
    let status = 0;
    let html = "";
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: unknown) { html = String(chunk ?? ""); },
    } as unknown as ServerResponse;
    const pathname = "/api/onboarding/slack/oauth/callback";
    const url = new URL(`${pathname}?${query}`, "http://127.0.0.1");
    // A forged state never matches, whichever home the route reads.
    await handleSlackProvisionApi({} as IncomingMessage, res, { method: "GET", pathname, url }, { connect: vi.fn() });
    return { status, html };
  }

  it("spends a real state on cancel and never echoes the URL's error text", async () => {
    const { fetchImpl } = slackStub({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: "Ryoko", redirectUrl: REDIRECT }, { fetchImpl, home });
    const state = new URL(result.installUrl!).searchParams.get("state")!;
    const { cancelSlackOAuth } = await import("../slack-provision/provision-flow.js");
    expect(await cancelSlackOAuth("forged", { home })).toBe(false);
    expect(await cancelSlackOAuth(state, { home })).toBe(true);
    expect(readSlackAppRecord(home)!.oauthState).toBeUndefined();
    expect(await cancelSlackOAuth(state, { home })).toBe(false);
  });

  it("answers a forged error link with a fixed refusal", async () => {
    const { status, html } = await callbackPage(`error=${encodeURIComponent("visit evil.example to re-login")}&state=forged`);
    expect(status).toBe(400);
    expect(html).not.toContain("evil.example");
  });
});
