import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";
import {
  DECISION_PROVIDERS, decisionCredentialPath, getDecisionCredentialStatus, resolveDecisionApiKey, saveDecisionApiKey,
} from "../../shared/decision-credentials.js";
import { JINN_HOME } from "../../shared/paths.js";

const ROOT = "/api/integrations/decision-keys";
const KEY = "apikey_only_a_test_fixture";
const ENDPOINTS = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
  openai: "https://api.openai.com/v1/decisions",
} as const;

function request(method: string, pathname: string, raw = "", headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.method = method; req.url = pathname;
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
function systemOneProbeResponse(model: string) {
  return new Response(JSON.stringify({ model, answers: { connection: {
    type: "choice", choice: "noul", probabilities: { noul: 1, other: 0 }, confidence: 1,
  } }, usage: { input_tokens: 10, output_tokens: 1 } }));
}
function openAiProbeResponse(answer: Record<string, unknown> = { type: "choice", name: "connection", choice: "noul", confidence: 1,
  probabilities: [{ value: "noul", probability: 0.99 }, { value: "other", probability: 0.01 }] }) {
  return new Response(JSON.stringify({ model: "gpt-6-luna-2026-11-01", answers: [answer], usage: { input_tokens: 40 } }));
}
const probeResponse = (provider: typeof DECISION_PROVIDERS[number]) => provider === "openai" ? openAiProbeResponse()
  : systemOneProbeResponse(provider === "openrouter" ? "typesafe/jev-1.13" : "jev-1.13.0");

const clean = () => fs.rmSync(path.dirname(decisionCredentialPath("typesafe")), { recursive: true, force: true });
beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", ""); vi.stubEnv("OPENROUTER_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
  clean();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  clean();
});

describe("decision-provider key API", () => {
  it.each(DECISION_PROVIDERS)("saves, reports and deletes the %s key without returning it", async (provider) => {
    const url = `${ROOT}/${provider}`;
    expect((await call(request("GET", url))).body).toEqual({ configured: false, source: "none" });
    const put = await call(request("PUT", url, JSON.stringify({ apiKey: KEY })));
    expect(put).toMatchObject({ status: 200, body: { configured: true, source: "stored" } });
    expect(put.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.stringify(put)).not.toContain(KEY);
    expect(resolveDecisionApiKey(provider)).toBe(KEY);
    for (const other of DECISION_PROVIDERS.filter((item) => item !== provider)) {
      expect(getDecisionCredentialStatus(other).configured).toBe(false);
    }
    expect((await call(request("GET", url))).body).toEqual({ configured: true, source: "stored" });
    expect((await call(request("DELETE", url))).body).toEqual({ configured: false, source: "none" });
  });

  it("keeps the legacy TypeSafe routes on the same store", async () => {
    await call(request("PUT", `${ROOT}/typesafe`, JSON.stringify({ apiKey: KEY })));
    expect((await call(request("GET", "/api/integrations/typesafe"))).body).toEqual({ configured: true, source: "stored" });
  });

  it.each([`${ROOT}/anthropic`, `${ROOT}/OpenAI`, `${ROOT}/`, `${ROOT}/openai/other`, `${ROOT}/openai/test/x`, `${ROOT}/..%2Fconfig`])(
    "returns 404 for unknown route %s", async (url) => {
      const result = await call(request("PUT", url, JSON.stringify({ apiKey: KEY })));
      expect(result).toMatchObject({ status: 404, body: { error: "not_found" } });
      expect(fs.existsSync(path.dirname(decisionCredentialPath("typesafe")))).toBe(false);
    });

  it.each(["GET", "PUT", "DELETE", "POST"])("rejects cross-origin %s before touching credentials", async (method) => {
    const url = `${ROOT}/openai${method === "POST" ? "/test" : ""}`;
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const result = await call(request(method, url, method === "PUT" ? JSON.stringify({ apiKey: KEY }) : "", { origin: "https://attacker.invalid" }));
    expect(result.status).toBe(403);
    expect(getDecisionCredentialStatus("openai").configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires gateway auth when network-exposed, before revealing whether a provider exists", async () => {
    expect((await call(request("GET", `${ROOT}/openai`), context(true))).status).toBe(401);
    expect((await call(request("GET", `${ROOT}/unknown`), context(true))).status).toBe(401);
    expect((await call(request("GET", `${ROOT}/openai`, "", { authorization: "Bearer gateway-token-fixture" }), context(true))).status).toBe(200);
  });

  it("validates the PUT body and method", async () => {
    expect((await call(request("PUT", `${ROOT}/openrouter`, '{"apiKey":"one","apiKey":"two"}'))).status).toBe(400);
    expect((await call(request("PUT", `${ROOT}/openrouter`, JSON.stringify({ apiKey: KEY }), { "content-type": "text/plain" }))).status).toBe(415);
    expect((await call(request("PUT", `${ROOT}/openrouter`, JSON.stringify({ apiKey: KEY + "\r\n" })))).body).toEqual({ error: "invalid_key" });
    expect((await call(request("POST", `${ROOT}/openrouter`))).status).toBe(405);
    expect((await call(request("GET", `${ROOT}/openrouter/test`))).status).toBe(405);
  });

  it.each(DECISION_PROVIDERS)("tests %s at its fixed endpoint with its own key and a synthetic question", async (provider) => {
    for (const other of DECISION_PROVIDERS) saveDecisionApiKey(other, `apikey_${other}_fixture`);
    const fetchMock = vi.fn(async () => probeResponse(provider));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call(request("POST", `${ROOT}/${provider}/test`));
    expect(result.body).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(ENDPOINTS[provider], expect.objectContaining({ method: "POST", redirect: "error" }));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: `Bearer apikey_${provider}_fixture` });
    const body = JSON.parse(init.body as string);
    if (provider === "openai") {
      expect(body).toEqual({ model: "gpt-6-luna", input: JSON.stringify({ connection_test: "Noul" }), questions: [{
        type: "choice", name: "connection", instructions: expect.any(String),
        choices: [{ value: "noul", description: expect.any(String) }, { value: "other", description: expect.any(String) }],
      }] });
    } else {
      expect(body).toMatchObject({ model: provider === "openrouter" ? "typesafe/jev-1.13" : "jev-1.13.0", state: { connection_test: "Noul" } });
    }
    expect(JSON.stringify(result)).not.toContain("fixture");
  });

  it("reports missing_key without calling the provider, and rejects custom prompts", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    saveDecisionApiKey("typesafe", KEY);
    expect((await call(request("POST", `${ROOT}/openai/test`))).body).toEqual({ ok: false, error: "missing_key" });
    expect((await call(request("POST", `${ROOT}/typesafe/test`, JSON.stringify({ prompt: "Slack text" })))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "provider_error"]] as const)(
    "redacts provider HTTP %s as %s", async (status, error) => {
      saveDecisionApiKey("openrouter", KEY);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(KEY + " provider-secret", { status })));
      const result = await call(request("POST", `${ROOT}/openrouter/test`));
      expect(result.body).toEqual({ ok: false, error });
      expect(JSON.stringify(result)).not.toContain(KEY);
    });

  it("treats an OpenAI refusal or wrong model as invalid_response", async () => {
    saveDecisionApiKey("openai", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => openAiProbeResponse({ type: "refusal", name: "connection", refusal: "no" })));
    expect((await call(request("POST", `${ROOT}/openai/test`))).body).toEqual({ ok: false, error: "invalid_response" });
    vi.stubGlobal("fetch", vi.fn(async () => systemOneProbeResponse("jev-1.13.0")));
    expect((await call(request("POST", `${ROOT}/openai/test`))).body).toEqual({ ok: false, error: "invalid_response" });
  });

  it("normalizes network errors and times out after 3 seconds", async () => {
    saveDecisionApiKey("openai", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(KEY + " /private/path"); }));
    expect((await call(request("POST", `${ROOT}/openai/test`))).body).toEqual({ ok: false, error: "network_error" });
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const pending = call(request("POST", `${ROOT}/openai/test`));
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).body).toEqual({ ok: false, error: "timeout" });
  });
});
