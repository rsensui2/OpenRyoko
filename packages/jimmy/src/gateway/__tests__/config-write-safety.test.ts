import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* Every API writer of config.yaml merges a partial update into the file on
 * disk. When that file could not be read, the merge used to start from an
 * empty object — and the write then replaced the whole config (engines,
 * connectors, tokens) with the request body alone. The property under test:
 * a config.yaml that exists but cannot be read is never written over. */

function fakeRequest(method: string, pathname: string, body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

function fakeResponse(): { res: ServerResponse; read: () => { status: number; body: Record<string, unknown> | null } } {
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

function context(reload?: ApiContext["reloadAllConnectors"]): ApiContext {
  return {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: reload,
  } as unknown as ApiContext;
}

async function call(method: string, pathname: string, body: unknown, ctx: ApiContext = context()) {
  const { res, read } = fakeResponse();
  await handleApiRequest(fakeRequest(method, pathname, body), res, ctx);
  return read();
}

const WORKING = {
  engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5-5" } },
  connectors: { slack: { botToken: "xoxb-KEEP", appToken: "xapp-KEEP" } },
};
const BROKEN = "engines:\n  default: claude\nconnectors: {\n  slack: [oops\n";

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump(WORKING));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(CONFIG_PATH, { force: true, recursive: true });
});

describe("PUT /api/config with a config.yaml it cannot read", () => {
  it("refuses instead of rebuilding the file from the request body", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const { status, body } = await call("PUT", "/api/config", { logging: { level: "debug" } });
    expect(status).toBeGreaterThanOrEqual(500);
    expect(String(body?.error)).toContain("config.yaml");
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(BROKEN); // not one byte moved
  });

  it("answers the request even though the refusal happens inside the config lock", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const { res, read } = fakeResponse();
    // A rejection escaping the handler would crash the gateway (no global
    // unhandledRejection handler) and leave the client waiting forever.
    await expect(handleApiRequest(fakeRequest("PUT", "/api/config", { logging: { level: "debug" } }), res, context()))
      .resolves.toBeUndefined();
    expect(read().status).toBeGreaterThanOrEqual(500);
  });

  it("refuses a config.yaml whose top level is not a mapping", async () => {
    fs.writeFileSync(CONFIG_PATH, "- a\n- list\n");
    const { status } = await call("PUT", "/api/config", { logging: { level: "debug" } });
    expect(status).toBeGreaterThanOrEqual(500);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe("- a\n- list\n");
  });

  it("does not reload connectors for a write it refused", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const reload = vi.fn().mockResolvedValue({ started: [], stopped: [], errors: [] });
    await call("PUT", "/api/config", { connectors: { slack: { botToken: "xoxb-NEW" } } }, context(reload));
    expect(reload).not.toHaveBeenCalled();
  });

  it("still creates config.yaml on a first write, when the file does not exist yet", async () => {
    fs.rmSync(CONFIG_PATH);
    const { status } = await call("PUT", "/api/config", { logging: { level: "debug" } });
    expect(status).toBe(200);
    expect(yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8"))).toEqual({ logging: { level: "debug" } });
  });

  it("merges into a readable config.yaml exactly as before", async () => {
    const { status } = await call("PUT", "/api/config", { logging: { level: "debug" } });
    expect(status).toBe(200);
    expect(yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8"))).toEqual({ ...WORKING, logging: { level: "debug" } });
  });

  it("leaves nothing but config.yaml behind in the home directory", async () => {
    const before = fs.readdirSync(path.dirname(CONFIG_PATH)).sort();
    await call("PUT", "/api/config", { logging: { level: "debug" } });
    expect(fs.readdirSync(path.dirname(CONFIG_PATH)).sort()).toEqual(before);
  });
});

describe("PUT /api/budgets with a config.yaml it cannot read", () => {
  it("refuses instead of replacing the whole config with the budgets block", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const { status, body } = await call("PUT", "/api/budgets", { "a-lead": 25 });
    expect(status).toBeGreaterThanOrEqual(500);
    expect(String(body?.error)).toContain("config.yaml");
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(BROKEN);
  });

  it("merges the limits into a readable config.yaml exactly as before", async () => {
    const { status } = await call("PUT", "/api/budgets", { "a-lead": 25 });
    expect(status).toBe(200);
    expect(yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8"))).toEqual({ ...WORKING, budgets: { employees: { "a-lead": 25 } } });
  });
});

describe("POST /api/onboarding/slack/connect with a config.yaml it cannot read", () => {
  it("refuses instead of leaving a config that holds nothing but the Slack tokens", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, team: "TEKION", user: "ryoko" }) }) as Response));
    const reload = vi.fn().mockResolvedValue({ started: ["slack"], stopped: [], errors: [] });
    const { status, body } = await call("POST", "/api/onboarding/slack/connect", { botToken: "xoxb-NEW", appToken: "xapp-NEW" }, context(reload));
    expect(status).toBeGreaterThanOrEqual(500);
    expect(String(body?.error)).toContain("config.yaml");
    expect(reload).not.toHaveBeenCalled();
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(BROKEN);
  });
});
