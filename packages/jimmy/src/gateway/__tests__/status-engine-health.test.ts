import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";
import { recordEngineUnavailable } from "../../shared/engine-health.js";
import { JINN_HOME } from "../../shared/paths.js";

/* /api/status is read by the web UI and by host-side health checks. Engine
 * health is added beside what they already read; nothing they read may move. */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");

function contextFor(engines: Record<string, unknown>): ApiContext {
  return {
    getConfig: () => ({ gateway: { port: 7788 }, connectors: {}, engines: { default: "claude", ...engines } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
}

async function status(context: ApiContext): Promise<Record<string, unknown>> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1" };
  req.method = "GET";
  req.url = "/api/status";
  let code = 0;
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    writeHead(value: number) { code = value; return this; },
    setHeader(name: string, value: string) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  await handleApiRequest(req, res, context);
  expect(code).toBe(200);
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

/** The engines block with the new field taken back out. */
function withoutHealth(engines: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(engines).map(([name, entry]) => {
    if (!entry || typeof entry !== "object") return [name, entry];
    const { health: _health, ...rest } = entry as Record<string, unknown>;
    return [name, rest];
  }));
}

const TWO_ENGINES = { claude: { bin: "claude", model: "claude-opus-5", interactive: true }, codex: { bin: "codex", model: "gpt-5.6-sol" } };
const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;

beforeEach(() => fs.rmSync(HEALTH_PATH, { force: true }));

describe("GET /api/status — engines", () => {
  it("keeps every field it already served, value and shape", async () => {
    const body = await status(contextFor(TWO_ENGINES));

    expect(Object.keys(body)).toEqual(["status", "uptime", "port", "engines", "sessions", "connectors", "storage"]);
    expect(withoutHealth(body.engines as Record<string, unknown>)).toEqual({
      default: "claude",
      claude: { model: "claude-opus-5", available: true, interactive: true },
      codex: { model: "gpt-5.6-sol", available: true },
    });
  });

  it("keeps the optional gemini entry and the non-interactive claude flag as they were", async () => {
    const body = await status(contextFor({ claude: { bin: "claude", model: "opus" }, codex: TWO_ENGINES.codex, gemini: { bin: "gemini", model: "gemini-3-pro" } }));

    expect(withoutHealth(body.engines as Record<string, unknown>)).toEqual({
      default: "claude",
      claude: { model: "opus", available: true, interactive: false },
      codex: { model: "gpt-5.6-sol", available: true },
      gemini: { model: "gemini-3-pro", available: true },
    });
  });

  it("still reports an engine that is out of allowance as available: true", async () => {
    recordEngineUnavailable("claude", "claude usage limit", inMinutes(90), new Date(), "5h");

    const engines = (await status(contextFor(TWO_ENGINES))).engines as Record<string, Record<string, unknown>>;

    expect(engines.claude).toMatchObject({ model: "claude-opus-5", available: true, interactive: true });
  });

  it("adds an ok health reading for every engine nothing has been observed on", async () => {
    const engines = (await status(contextFor({ ...TWO_ENGINES, gemini: { bin: "gemini", model: "gemini-3-pro" } }))).engines as Record<string, Record<string, unknown>>;

    expect(engines.claude.health).toEqual({ state: "ok" });
    expect(engines.codex.health).toEqual({ state: "ok" });
    expect(engines.gemini.health).toEqual({ state: "ok" });
  });

  it("adds the state, the stated reset and the next re-check for an engine that is out", async () => {
    const reset = inMinutes(3 * 24 * 60);
    const recordedAt = new Date();
    recordEngineUnavailable("claude", "claude usage limit", reset, recordedAt, "7d");

    const engines = (await status(contextFor(TWO_ENGINES))).engines as Record<string, Record<string, unknown>>;

    expect(engines.claude.health).toEqual({
      state: "exhausted",
      until: new Date(reset * 1000).toISOString(),
      recheckAt: new Date(recordedAt.getTime() + 12 * 60 * 60_000).toISOString(),
    });
    expect(engines.codex.health).toEqual({ state: "ok" });
  });
});
