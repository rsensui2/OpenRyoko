import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* PUT /api/config merges its body into config.yaml, and read a body of any
 * size to do it. The work a save does grows with the size of the file, so a
 * caller could make every later save slow and memory-hungry just by sending
 * a large one. A megabyte is far more than a configuration needs. */

const CONFIG = "# my notes\ngateway:\n  port: 7777\nlogging:\n  level: info\n";

async function put(payload: string, headers: Record<string, string> = {}) {
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1", "content-type": "application/json", ...headers };
  req.method = "PUT";
  req.url = "/api/config";
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => yaml.load(CONFIG), connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(req, res, context);
  return { status, body: chunks.length ? JSON.parse(chunks.join("")) : null };
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, CONFIG);
});

afterEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("PUT /api/config body size", () => {
  it("refuses a body of more than a megabyte and leaves config.yaml as it was", async () => {
    const answer = await put(JSON.stringify({ portal: { portalName: "x".repeat(1024 * 1024) } }));

    expect(answer.status).toBe(413);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(CONFIG);
  });

  it("refuses it by its announced size, before reading it", async () => {
    const answer = await put(JSON.stringify({ logging: { level: "debug" } }), { "content-length": String(5 * 1024 * 1024) });

    expect(answer.status).toBe(413);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(CONFIG);
  });

  it("accepts a configuration of an ordinary size — and a generous one", async () => {
    expect((await put(JSON.stringify({ logging: { level: "debug" } }))).status).toBe(200);
    const generous = { portal: { trustedSpeakers: Array.from({ length: 20_000 }, (_, n) => `U${String(n).padStart(9, "0")}`) } };
    expect(JSON.stringify(generous).length).toBeGreaterThan(200 * 1024);
    expect((await put(JSON.stringify(generous))).status).toBe(200);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toContain("# my notes");
  });
});
