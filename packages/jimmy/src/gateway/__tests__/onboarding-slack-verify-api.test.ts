import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";

/* The wizard saves Slack tokens only after this route says BOTH are good.
 * The connector itself only warns when auth.test fails (a valid app token
 * alone starts Socket Mode), so a bot-token check that lives before the save
 * is what stops "接続できました" from lying. */

function fakePost(pathname: string, body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = "POST";
  readable.url = pathname;
  return readable;
}

function fakeResponse(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader(name: string, value: string) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: chunks.length ? JSON.parse(chunks.join("")) : null }) };
}

const context = {
  getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } } }),
  connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
} as unknown as ApiContext;

function stubSlack(answers: Record<string, { ok: boolean; [key: string]: unknown }>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const method = String(url).split("/api/")[1]!;
    const token = init?.headers?.Authorization ?? "";
    const answer = answers[`${method}:${token}`] ?? { ok: false, error: "invalid_auth" };
    return { ok: true, status: 200, json: async () => answer } as Response;
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /api/onboarding/slack/verify", () => {
  it("reports a bad bot token even when the app token opens Socket Mode", async () => {
    stubSlack({
      "auth.test:Bearer xoxb-bad": { ok: false, error: "invalid_auth" },
      "apps.connections.open:Bearer xapp-good": { ok: true, url: "wss://…" },
    });
    const { res, read } = fakeResponse();
    await handleApiRequest(fakePost("/api/onboarding/slack/verify", { botToken: "xoxb-bad", appToken: "xapp-good" }), res, context);
    const { status, body } = read();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, bot: { ok: false, error: "invalid_auth" }, app: { ok: true } });
  });

  it("answers ok with team/user when both tokens verify", async () => {
    stubSlack({
      "auth.test:Bearer xoxb-good": { ok: true, team: "TEKION", user: "ryoko" },
      "apps.connections.open:Bearer xapp-good": { ok: true },
    });
    const { res, read } = fakeResponse();
    await handleApiRequest(fakePost("/api/onboarding/slack/verify", { botToken: "xoxb-good", appToken: "xapp-good" }), res, context);
    expect(read().body).toMatchObject({ ok: true, bot: { ok: true, team: "TEKION", user: "ryoko" }, app: { ok: true } });
  });

  it("refuses tokens with the wrong prefix before calling Slack", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { res, read } = fakeResponse();
    await handleApiRequest(fakePost("/api/onboarding/slack/verify", { botToken: "xapp-swapped", appToken: "xoxb-swapped" }), res, context);
    expect(read().status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turns a network failure into a normalized per-token code, never a 500 or a raw message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND slack.com"); }));
    const { res, read } = fakeResponse();
    await handleApiRequest(fakePost("/api/onboarding/slack/verify", { botToken: "xoxb-x", appToken: "xapp-x" }), res, context);
    const { status, body } = read();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, bot: { ok: false, error: "network_error" }, app: { ok: false, error: "network_error" } });
    expect(JSON.stringify(body)).not.toContain("ENOTFOUND");
  });

  it("treats a non-2xx HTTP answer as a failure even if the body were to say ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: true }) }) as Response));
    const { res, read } = fakeResponse();
    await handleApiRequest(fakePost("/api/onboarding/slack/verify", { botToken: "xoxb-x", appToken: "xapp-x" }), res, context);
    expect(read().body).toMatchObject({ ok: false, bot: { ok: false, error: "http_500" }, app: { ok: false, error: "http_500" } });
  });
});
