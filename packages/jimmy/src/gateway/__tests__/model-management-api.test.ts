import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";
import type { JinnConfig } from "../../shared/types.js";
import { actionSchema } from "../../models/service.js";

const config = { gateway: { port: 0, host: "127.0.0.1", authRequired: false }, engines: { default: "codex", codex: { bin: "codex", model: "sol" }, claude: { bin: "claude", model: "opus" } }, connectors: {}, logging: {} } as JinnConfig;
async function request(method: string, body?: unknown, authRequired = false) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method; req.url = method === "GET" ? "/api/models" : "/api/models/actions";
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  const snapshot = vi.fn(() => ({ engines: [], pins: [] }));
  const act = vi.fn(async value => { actionSchema.parse(value); return { saved: true }; });
  const context = { config, getConfig: () => ({ ...config, gateway: { ...config.gateway, authRequired } }), modelManagement: { snapshot, act } } as unknown as ApiContext;
  let status = 0, text = "";
  const res = { setHeader() {}, writeHead(code: number) { status = code; return this; }, end(chunk?: string) { text += chunk ?? ""; } } as unknown as ServerResponse;
  await handleApiRequest(req, res, context);
  return { status, body: text ? JSON.parse(text) : null, snapshot, act };
}
describe("model management API", () => {
  it("GET only reads a snapshot, never runs discovery or applies settings", async () => {
    const result = await request("GET"); expect(result.status).toBe(200); expect(result.snapshot).toHaveBeenCalledOnce(); expect(result.act).not.toHaveBeenCalled();
  });
  it("POST decodes JSON and executes a validated action", async () => {
    const result = await request("POST", { action: "refresh" }); expect(result.status).toBe(200); expect(result.act).toHaveBeenCalledWith({ action: "refresh" });
  });
  it("rejects unauthenticated calls when gateway auth is enabled", async () => {
    const result = await request("POST", { action: "refresh" }, true); expect(result.status).toBe(401); expect(result.act).not.toHaveBeenCalled();
  });
  it("rejects malformed actions and excessive payloads", async () => {
    expect((await request("POST", { action: "default", engine: "shell", model: "x" })).status).toBe(400);
    expect((await request("POST", { payload: "x".repeat(20_000) })).status).toBe(413);
  });
});
