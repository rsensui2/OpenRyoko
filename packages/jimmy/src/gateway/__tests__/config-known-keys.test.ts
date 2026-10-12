import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_TEMPLATE_PATH } from "../../cli/initial-config.js";
import { CONFIG_PATH } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* PUT /api/config only accepts top-level keys on its allowlist. The Settings
 * page saves back the whole document it was served, so a key the gateway
 * itself writes or documents but the allowlist forgot makes every later save
 * fail with "Unknown config keys". */

function fakeRequest(method: string, pathname: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

async function call(method: string, pathname: string, body?: unknown) {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude" } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(fakeRequest(method, pathname, body), res, context);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: (chunks.length ? JSON.parse(chunks.join("")) : null) as any };
}

const savedConfig = () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;

/** Every top-level key `JinnConfig` declares. The compiler keeps this list
 *  honest in both directions: a key added to the interface but not here (or
 *  the reverse) fails `tsc`, and the test below then requires PUT /api/config
 *  to accept it. */
const DECLARED_KEYS: Record<keyof JinnConfig, true> = {
  jinn: true, gateway: true, engines: true, models: true, modelManagement: true, workflows: true,
  connectors: true, logging: true, mcp: true, budgets: true, sessions: true, cron: true,
  notifications: true, portal: true, context: true, stt: true,
};

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump({ gateway: { port: 7777, host: "127.0.0.1" }, engines: { default: "claude" } }));
});

afterEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("PUT /api/config top-level key allowlist", () => {
  it("round-trips a config that PUT /api/budgets has written to (regression: Unknown config keys: budgets)", async () => {
    expect((await call("PUT", "/api/budgets", { "a-lead": 25 })).status).toBe(200);
    expect(savedConfig().budgets).toEqual({ employees: { "a-lead": 25 } });

    // What the Settings page does: load the whole document, save it back.
    const loaded = await call("GET", "/api/config");
    const saved = await call("PUT", "/api/config", loaded.body);

    expect(saved.body?.error).toBeUndefined();
    expect(saved.status).toBe(200);
    expect(savedConfig().budgets).toEqual({ employees: { "a-lead": 25 } });
  });

  it("accepts and persists the budgets block itself", async () => {
    const saved = await call("PUT", "/api/config", { budgets: { employees: { "a-lead": 40 } } });
    expect(saved.status).toBe(200);
    expect(savedConfig().budgets).toEqual({ employees: { "a-lead": 40 } });
  });

  it("accepts every top-level key JinnConfig declares", async () => {
    const body = Object.fromEntries(Object.keys(DECLARED_KEYS).map((key) => [key, {}]));
    const saved = await call("PUT", "/api/config", body);
    expect(saved.body?.error).toBeUndefined();
    expect(saved.status).toBe(200);
  });

  it("accepts every top-level key the shipped config template sets or documents", async () => {
    const template = fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf-8");
    const active = Object.keys(yaml.load(template) as Record<string, unknown>);
    // Sections shipped commented out ("# sessions:") are one uncomment away.
    const documented = [...template.matchAll(/^# ([A-Za-z]+):\s*$/gm)].map((match) => match[1]);
    expect(active).toContain("gateway");
    expect(documented).toContain("sessions");

    const body = Object.fromEntries([...active, ...documented].map((key) => [key, {}]));
    const saved = await call("PUT", "/api/config", body);
    expect(saved.body?.error).toBeUndefined();
    expect(saved.status).toBe(200);
  });

  it("still refuses a key nobody declares", async () => {
    const saved = await call("PUT", "/api/config", { nonsense: true });
    expect(saved.status).toBe(400);
    expect(saved.body.error).toBe("Unknown config keys: nonsense");
  });
});
