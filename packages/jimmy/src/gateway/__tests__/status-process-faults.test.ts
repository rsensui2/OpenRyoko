import { describe, expect, it } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";
import { getProcessSafetyNetStats } from "../../shared/process-safety-net.js";

function request(): any {
  return { method: "GET", url: "/api/status", headers: { host: "127.0.0.1" } };
}

function response() {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    setHeader() {},
    writeHead(status: number) { captured.status = status; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : undefined; },
  };
  return { res, captured };
}

function context(): ApiContext {
  const config = {
    gateway: { port: 18999 },
    engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5" }, codex: { bin: "codex", model: "gpt-5.6-sol" } },
  };
  return {
    config,
    getConfig: () => config,
    sessionManager: {},
    startTime: Date.now(),
    connectors: new Map(),
    emit: () => {},
  } as unknown as ApiContext;
}

describe("GET /api/status — process", () => {
  it("reports what the process safety net has caught, so a gateway running on after a fault can be told from a clean one", async () => {
    const { res, captured } = response();
    await handleApiRequest(request(), res, context());

    expect(captured.status).toBe(200);
    expect(captured.body.process).toEqual(getProcessSafetyNetStats());
    expect(Object.keys(captured.body.process)).toEqual(["unhandledRejections", "uncaughtExceptions", "lastCaughtAt"]);
  });
});
