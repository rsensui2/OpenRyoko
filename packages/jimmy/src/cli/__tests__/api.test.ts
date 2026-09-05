import { describe, expect, it, vi } from "vitest";
import { requestGatewayApi } from "../api.js";

describe("requestGatewayApi", () => {
  it("normalizes wildcard binds and adds the stored bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await requestGatewayApi(
      { method: "get", path: "/api/status" },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: "secret-token" },
    );

    expect(result).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:7777/api/status");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-token" });
    expect(init.redirect).toBe("error");
  });

  it("sends validated JSON for write requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("created", { status: 201 }));
    await requestGatewayApi(
      { method: "POST", path: "/api/sessions", data: '{ "prompt": "hello" }' },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: null },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.body).toBe('{"prompt":"hello"}');
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("never sends the token to a full or escaped URL", async () => {
    const fetchImpl = vi.fn();
    await expect(requestGatewayApi(
      { method: "GET", path: "https://evil.example/api/status" },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: "secret" },
    )).rejects.toThrow("must start with /api/");
    await expect(requestGatewayApi(
      { method: "GET", path: "/not-api" },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: "secret" },
    )).rejects.toThrow("must start with /api/");
    await expect(requestGatewayApi(
      { method: "GET", path: "/api/../../outside" },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: "secret" },
    )).rejects.toThrow("must stay within");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods and malformed JSON before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(requestGatewayApi(
      { method: "TRACE", path: "/api/status" },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: null },
    )).rejects.toThrow("Unsupported method");
    await expect(requestGatewayApi(
      { method: "POST", path: "/api/sessions", data: "not-json" },
      { fetchImpl: fetchImpl as typeof fetch, gatewayUrl: "http://127.0.0.1:7777", token: null },
    )).rejects.toThrow("valid JSON");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
