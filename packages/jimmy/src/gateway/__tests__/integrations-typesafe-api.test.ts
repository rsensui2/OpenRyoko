import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";
import { getTypeSafeCredentialStatus, resolveTypeSafeApiKey, saveTypeSafeApiKey, typeSafeCredentialPath } from "../../shared/typesafe-credentials.js";
import { JINN_HOME } from "../../shared/paths.js";

const ROOT = "/api/integrations/typesafe";
const KEY = "apikey_only_a_test_fixture";
function request(method: string, suffix = "", raw = "", headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.method = method; req.url = ROOT + suffix;
  req.headers = { host: "localhost:7777", "content-type": "application/json", ...headers };
  return req;
}
function response() {
  let status = 0;
  const headers: Record<string, unknown> = {};
  let body = "";
  return {
    res: { writeHead(code: number) { status = code; }, setHeader(key: string, value: unknown) { headers[key] = value; },
      getHeader(key: string) { return headers[key]; }, end(data?: unknown) { if (data) body += String(data); },
    } as unknown as ServerResponse,
    read: () => ({ status, body: body ? JSON.parse(body) : null, headers }),
  };
}
function context(network = false): ApiContext {
  return { getConfig: () => ({ gateway: { host: network ? "0.0.0.0" : "127.0.0.1", port: 7777 }, connectors: {} }),
    authToken: "gateway-token-fixture", authHome: JINN_HOME,
  } as unknown as ApiContext;
}
async function call(req: IncomingMessage, config = context()) {
  const output = response();
  await handleApiRequest(req, output.res, config);
  return output.read();
}
function providerResponse() {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { connection: {
    type: "choice", choice: "noul", probabilities: { noul: 1, other: 0 }, confidence: 1,
  } }, usage: { input_tokens: 10, output_tokens: 1 } }));
}
beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  fs.rmSync(path.dirname(typeSafeCredentialPath()), { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  fs.rmSync(path.dirname(typeSafeCredentialPath()), { recursive: true, force: true });
});

describe("TypeSafe integration API", () => {
  it("saves and deletes private keys while returning status only", async () => {
    expect((await call(request("GET"))).body).toEqual({ configured: false, source: "none" });
    const put = await call(request("PUT", "", JSON.stringify({ apiKey: KEY })));
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ configured: true, source: "stored" });
    expect(JSON.stringify(put)).not.toContain(KEY);
    expect(resolveTypeSafeApiKey()).toBe(KEY);
    expect((await call(request("GET"))).headers["Cache-Control"]).toBe("no-store");
    expect((await call(request("DELETE"))).body).toEqual({ configured: false, source: "none" });
  });
  it("does not include saved credentials in GET config", async () => {
    saveTypeSafeApiKey(KEY);
    const req = request("GET"); req.url = "/api/config";
    expect(JSON.stringify(await call(req))).not.toContain(KEY);
  });
  it.each(["GET", "PUT", "DELETE", "POST"])("requires gateway auth for network-exposed %s access", async (method) => {
    const result = await call(request(method, method === "POST" ? "/test" : "", JSON.stringify({ apiKey: KEY })), context(true));
    expect(result.status).toBe(401);
    expect(getTypeSafeCredentialStatus().configured).toBe(false);
  });
  it("accepts valid gateway bearer authentication", async () => {
    expect((await call(request("GET", "", "", { authorization: "Bearer gateway-token-fixture" }), context(true))).status).toBe(200);
  });
  it.each(["PUT", "DELETE", "POST"])("rejects cross-origin %s before accessing credentials", async (method) => {
    const result = await call(request(method, method === "POST" ? "/test" : "", JSON.stringify({ apiKey: KEY }), { origin: "https://attacker.invalid" }));
    expect(result.status).toBe(403);
    expect(getTypeSafeCredentialStatus().configured).toBe(false);
  });
  it("rejects duplicate fields, non-JSON media, oversized bodies, and CRLF keys", async () => {
    expect((await call(request("PUT", "", '{"apiKey":"one","apiKey":"two"}'))).status).toBe(400);
    expect((await call(request("PUT", "", JSON.stringify({ apiKey: KEY }), { "content-type": "text/plain" }))).status).toBe(415);
    expect((await call(request("PUT", "", JSON.stringify({ apiKey: "x".repeat(9000) })))).status).toBe(413);
    expect((await call(request("PUT", "", JSON.stringify({ apiKey: KEY + "\r\n" })))).body).toEqual({ error: "invalid_key" });
  });
  it("returns a fixed safe error when private storage fails", async () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error(KEY + " /secret/filesystem/path"); });
    const result = await call(request("PUT", "", JSON.stringify({ apiKey: KEY })));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "storage_unavailable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("tests only the fixed official endpoint and synthetic Noul state", async () => {
    saveTypeSafeApiKey(KEY);
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await call(request("POST", "/test"));
    expect(result.body).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({ redirect: "error", method: "POST" }));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "jev-1.13.0", state: { connection_test: "Noul" } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it.each([[401, "unauthorized"], [429, "rate_limited"], [500, "provider_error"]] as const)("redacts provider HTTP %s errors", async (status, error) => {
    saveTypeSafeApiKey(KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(KEY + " provider-secret", { status })));
    const result = await call(request("POST", "/test"));
    expect(result.body).toEqual({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("normalizes thrown provider errors without exposing messages", async () => {
    saveTypeSafeApiKey(KEY);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(KEY + " /private/path"); }));
    expect((await call(request("POST", "/test"))).body).toEqual({ ok: false, error: "network_error" });
  });
  it("rejects oversized and malformed provider responses", async () => {
    saveTypeSafeApiKey(KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(" ".repeat(8193))));
    expect((await call(request("POST", "/test"))).body).toEqual({ ok: false, error: "invalid_response" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON")));
    expect((await call(request("POST", "/test"))).body).toEqual({ ok: false, error: "invalid_response" });
  });
  it("times out after 3 seconds even if the transport ignores abort", async () => {
    saveTypeSafeApiKey(KEY);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const pending = call(request("POST", "/test"));
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).body).toEqual({ ok: false, error: "timeout" });
  });
  it("rejects custom prompts and never calls the provider without a key", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await call(request("POST", "/test"))).body).toEqual({ ok: false, error: "missing_key" });
    expect((await call(request("POST", "/test", JSON.stringify({ prompt: "Slack text" })))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
