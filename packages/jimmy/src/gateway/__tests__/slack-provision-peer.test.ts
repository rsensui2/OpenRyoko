import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSlackOAuth, completeSlackOAuth, forgetSlackSecrets, pendingBotToken, provisionSlackApp, reissueInstallUrl, slackProvisionStatus,
} from "../slack-provision/provision-flow.js";
import { botForOAuthState, readSlackAppRecord, slackAppRecordBots, slackAppRecordPath, writeSlackAppRecord } from "../slack-provision/provision-store.js";
import { handleSlackProvisionApi, type SlackProvisionRouteDeps } from "../slack-provision/routes.js";
import type { FetchLike } from "../slack-provision/slack-config-api.js";

/* One Slack app per Ryoko. Properties under test: a peer's setup lives in its
 * own record and never touches the main one; the OAuth callback finds the
 * right record from the state alone, and the state stays one-use; finishing a
 * peer's setup connects that peer and clears only that peer's secrets. */

const REDIRECT = "https://ryoko.example.ts.net/api/onboarding/slack/oauth/callback";

function slack(answers: Record<string, (call: number) => Record<string, unknown>>): { fetchImpl: FetchLike; bodies: URLSearchParams[] } {
  const count: Record<string, number> = {};
  const bodies: URLSearchParams[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const method = input.split("/api/")[1]!;
    count[method] = (count[method] ?? 0) + 1;
    bodies.push(init?.body as URLSearchParams);
    const answer = answers[method];
    return { ok: true, status: 200, json: async () => (answer ? answer(count[method]!) : { ok: false, error: "unstubbed" }) } as Response;
  };
  return { fetchImpl, bodies };
}

const rotate = (call: number) => ({ ok: true, token: `xoxe.xoxp-A${call}`, refresh_token: `xoxe-1-N${call}`, team_id: "T1" });
const created = (call: number) => ({ ok: true, app_id: `A${call}`, credentials: { client_id: `C.${call}`, client_secret: `SECRET${call}` } });
const access = (botToken: string) => () => ({ ok: true, access_token: botToken, team: { id: "T1", name: "Example" } });

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "slack-provision-peer-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

async function provision(bot: string | undefined, fetchImpl: FetchLike): Promise<string> {
  const result = await provisionSlackApp({ refreshToken: "xoxe-1-FIRST", name: bot ?? "Ryoko", redirectUrl: REDIRECT }, { fetchImpl, home, bot });
  return new URL(result.installUrl!).searchParams.get("state")!;
}

describe("per-bot records", () => {
  it("keeps the main record at slack-app.json and a peer's at slack-apps/<name>.json (0600)", async () => {
    const { fetchImpl } = slack({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    await provision(undefined, fetchImpl);
    await provision("hana", fetchImpl);

    expect(slackAppRecordPath(home)).toBe(path.join(home, "slack-app.json"));
    expect(slackAppRecordPath(home, "main")).toBe(path.join(home, "slack-app.json"));
    expect(slackAppRecordPath(home, "hana")).toBe(path.join(home, "slack-apps", "hana.json"));
    expect(fs.statSync(slackAppRecordPath(home, "hana")).mode & 0o777).toBe(0o600);
    expect(readSlackAppRecord(home)!.appId).toBe("A1");
    expect(readSlackAppRecord(home, "hana")!.appId).toBe("A2");
    expect(slackAppRecordBots(home)).toEqual(["main", "hana"]);
    expect(slackProvisionStatus(home, "hana")).toMatchObject({ appId: "A2", name: "hana" });
  });

  it("refuses a bot name that could leave the folder", () => {
    expect(() => slackAppRecordPath(home, "../slack-app")).toThrow();
    expect(() => slackAppRecordPath(home, "Hana")).toThrow();
  });

  it("a peer's setup updates its own app, not the main one", async () => {
    const { fetchImpl } = slack({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created, "apps.manifest.update": () => ({ ok: true }) });
    await provision(undefined, fetchImpl);
    await provision("hana", fetchImpl);
    const again = await provisionSlackApp({ refreshToken: "xoxe-1-AGAIN", name: "Hana 2" }, { fetchImpl, home, bot: "hana" });
    expect(again).toMatchObject({ appId: "A2", created: false });
    expect(readSlackAppRecord(home)!.name).toBe("Ryoko");
  });
});

describe("OAuth callback routing by state", () => {
  it("completes the peer's install into the peer's record only", async () => {
    const setup = slack({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const mainState = await provision(undefined, setup.fetchImpl);
    const hanaState = await provision("hana", setup.fetchImpl);
    expect(botForOAuthState(home, hanaState)).toBe("hana");
    expect(botForOAuthState(home, mainState)).toBe("main");

    const exchange = slack({ "oauth.v2.access": access("xoxb-HANA") });
    await completeSlackOAuth({ code: "CODE", state: hanaState }, { fetchImpl: exchange.fetchImpl, home });
    expect(exchange.bodies[0]!.get("client_secret")).toBe("SECRET2");
    expect(pendingBotToken(home, "hana")).toBe("xoxb-HANA");
    expect(pendingBotToken(home)).toBeUndefined();
    // The main install is still waiting on its own state.
    expect(readSlackAppRecord(home)!.oauthState?.value).toBe(mainState);
  });

  it("keeps every state one-use and refuses forged ones", async () => {
    const setup = slack({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const hanaState = await provision("hana", setup.fetchImpl);
    const exchange = slack({ "oauth.v2.access": access("xoxb-HANA") });
    await expect(completeSlackOAuth({ code: "CODE", state: "forged" }, { fetchImpl: exchange.fetchImpl, home })).rejects.toMatchObject({ code: "invalid_state" });
    await completeSlackOAuth({ code: "CODE", state: hanaState }, { fetchImpl: exchange.fetchImpl, home });
    await expect(completeSlackOAuth({ code: "CODE", state: hanaState }, { fetchImpl: exchange.fetchImpl, home })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("a reissued peer link and a cancel use the peer's record", async () => {
    const setup = slack({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    await provision("hana", setup.fetchImpl);
    const next = new URL(await reissueInstallUrl({ home, bot: "hana" })).searchParams.get("state")!;
    expect(botForOAuthState(home, next)).toBe("hana");
    expect(await cancelSlackOAuth(next, { home })).toBe(true);
    expect(readSlackAppRecord(home, "hana")!.oauthState).toBeUndefined();
    expect(await cancelSlackOAuth(next, { home })).toBe(false);
  });

  it("the callback route answers a peer's state", async () => {
    const setup = slack({ "tooling.tokens.rotate": rotate, "apps.manifest.create": created });
    const state = await provision("hana", setup.fetchImpl);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => access("xoxb-HANA")() }) as Response));
    try {
      let status = 0;
      const res = { writeHead(code: number) { status = code; return this; }, end() {} } as unknown as ServerResponse;
      const pathname = "/api/onboarding/slack/oauth/callback";
      const url = new URL(`${pathname}?code=CODE&state=${encodeURIComponent(state)}`, "http://127.0.0.1");
      await handleSlackProvisionApi({} as IncomingMessage, res, { method: "GET", pathname, url }, { connect: vi.fn(), home });
      expect(status).toBe(200);
      expect(pendingBotToken(home, "hana")).toBe("xoxb-HANA");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("forgetSlackSecrets per bot", () => {
  it("clears only that bot's record", async () => {
    writeSlackAppRecord({ teamId: "T1", appId: "A1", clientSecret: "MAIN-SECRET" }, home);
    writeSlackAppRecord({ teamId: "T1", appId: "A2", clientSecret: "HANA-SECRET", pendingBotToken: "xoxb-H" }, home, "hana");
    await forgetSlackSecrets(home, "hana");
    expect(readSlackAppRecord(home, "hana")).toMatchObject({ appId: "A2" });
    expect(fs.readFileSync(slackAppRecordPath(home, "hana"), "utf8")).not.toMatch(/SECRET|xoxb-/);
    expect(readSlackAppRecord(home)!.clientSecret).toBe("MAIN-SECRET");
  });
});

describe("routes with bot", () => {
  function post(pathname: string, body: unknown): IncomingMessage {
    const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
    readable.method = "POST";
    readable.url = pathname;
    return readable;
  }

  async function call(method: "GET" | "POST", target: string, body: unknown, deps: Partial<SlackProvisionRouteDeps> = {}): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    let status = 0;
    const chunks: string[] = [];
    const res = {
      writeHead(code: number) { status = code; return this; },
      setHeader() { return this; },
      end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
    } as unknown as ServerResponse;
    const url = new URL(target, "http://127.0.0.1");
    const handled = await handleSlackProvisionApi(method === "POST" ? post(url.pathname, body) : ({} as IncomingMessage), res,
      { method, pathname: url.pathname, url }, { connect: vi.fn(), peerExists: (name) => name === "hana", home, ...deps });
    expect(handled).toBe(true);
    return { status, body: chunks.length ? JSON.parse(chunks.join("")) : null };
  }

  it("GET app reads the chosen bot's record and refuses unknown bots", async () => {
    writeSlackAppRecord({ teamId: "T1", appId: "A-MAIN" }, home);
    writeSlackAppRecord({ teamId: "T1", appId: "A-HANA" }, home, "hana");
    expect((await call("GET", "/api/onboarding/slack/app", undefined)).body.appId).toBe("A-MAIN");
    expect((await call("GET", "/api/onboarding/slack/app?bot=main", undefined)).body.appId).toBe("A-MAIN");
    expect((await call("GET", "/api/onboarding/slack/app?bot=hana", undefined)).body.appId).toBe("A-HANA");
    expect((await call("GET", "/api/onboarding/slack/app?bot=nobody", undefined)).status).toBe(400);
    expect((await call("GET", "/api/onboarding/slack/app?bot=..%2Fx", undefined)).status).toBe(400);
  });

  it("POST app with an unknown bot is refused before calling Slack", async () => {
    const { status } = await call("POST", "/api/onboarding/slack/app", { bot: "nobody", name: "X", refreshToken: "xoxe-1-A" });
    expect(status).toBe(400);
    expect(fs.existsSync(path.join(home, "slack-apps"))).toBe(false);
  });

  it("install-url takes the bot from the body and still works with no body", async () => {
    writeSlackAppRecord({ teamId: "T1", appId: "A1", clientId: "C.MAIN", redirectUrl: REDIRECT }, home);
    writeSlackAppRecord({ teamId: "T1", appId: "A2", clientId: "C.HANA", redirectUrl: REDIRECT }, home, "hana");
    const main = await call("POST", "/api/onboarding/slack/install-url", undefined);
    expect(new URL(main.body.installUrl).searchParams.get("client_id")).toBe("C.MAIN");
    const hana = await call("POST", "/api/onboarding/slack/install-url", { bot: "hana" });
    expect(new URL(hana.body.installUrl).searchParams.get("client_id")).toBe("C.HANA");
  });

  it("finish with a peer bot uses its pending token, connects the peer and clears only its secrets", async () => {
    writeSlackAppRecord({ teamId: "T1", appId: "A1", clientSecret: "MAIN-SECRET", pendingBotToken: "xoxb-MAIN" }, home);
    writeSlackAppRecord({ teamId: "T1", appId: "A2", clientSecret: "HANA-SECRET", pendingBotToken: "xoxb-HANA" }, home, "hana");
    const connect = vi.fn();
    const connectPeer = vi.fn().mockResolvedValue({ ok: true, instanceId: "slack-hana" });
    const { body } = await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-1" }, { connect, connectPeer });
    expect(body).toEqual({ ok: true, instanceId: "slack-hana" });
    expect(connectPeer).toHaveBeenCalledWith("hana", "xoxb-HANA", "xapp-1");
    expect(connect).not.toHaveBeenCalled();
    expect(readSlackAppRecord(home, "hana")!.pendingBotToken).toBeUndefined();
    expect(readSlackAppRecord(home)!.pendingBotToken).toBe("xoxb-MAIN");
  });

  it("finish keeps a peer's secrets when the connect fails", async () => {
    writeSlackAppRecord({ teamId: "T1", appId: "A2", pendingBotToken: "xoxb-HANA" }, home, "hana");
    const connectPeer = vi.fn().mockResolvedValue({ ok: false, stage: "reload" });
    await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-1" }, { connectPeer });
    expect(readSlackAppRecord(home, "hana")!.pendingBotToken).toBe("xoxb-HANA");
  });
});
