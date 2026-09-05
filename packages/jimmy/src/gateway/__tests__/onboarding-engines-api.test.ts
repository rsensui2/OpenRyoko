import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest, _resetEngineProbeCache, type ApiContext } from "../api.js";

/* The onboarding wizard's "is the engine installed and does it start" check.
 * /api/status hard-codes available:true; this route resolves the binary and
 * runs it. It is deliberately NOT a login-validity check — it reports what it
 * can observe locally, never spends tokens, and says so in `auth.note`. */

function fakeGet(pathname: string): IncomingMessage {
  const readable = Readable.from([]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1" };
  readable.method = "GET";
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

interface Probe { name: string; installed: boolean; runnable: boolean; version?: string; error?: string; auth?: Record<string, unknown> }
interface Payload { default: string; probedAt: string; engines: Probe[] }

function contextFor(engines: Record<string, unknown>): ApiContext {
  return {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude", ...engines } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
}

async function probe(context: ApiContext): Promise<Payload> {
  const { res, read } = fakeResponse();
  await handleApiRequest(fakeGet("/api/onboarding/engines"), res, context);
  const { status, body } = read();
  expect(status).toBe(200);
  return body as Payload;
}

let scratch: string;
const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

beforeEach(() => {
  _resetEngineProbeCache();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-onboarding-engines-"));
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CONFIG_DIR = path.join(scratch, "claude-config"); // no credentials → "none"
});

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
  if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  fs.rmSync(scratch, { recursive: true, force: true });
  _resetEngineProbeCache();
});

/** A stand-in binary: exits with the given code, printing a version line. */
function fakeBin(name: string, exitCode: number): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} 9.9.9"\nexit ${exitCode}\n`, { mode: 0o755 });
  return file;
}

describe("GET /api/onboarding/engines", () => {
  it("reports runnable engines with a version, missing binaries as not installed, and no unconfigured engines", async () => {
    const payload = await probe(contextFor({
      claude: { bin: process.execPath, model: "opus" }, // node itself: always runnable
      codex: { bin: "ryoko-no-such-binary-xyz", model: "gpt" },
    }));
    expect(payload.default).toBe("claude");
    const claude = payload.engines.find((engine) => engine.name === "claude")!;
    expect(claude).toMatchObject({ installed: true, runnable: true });
    expect(String(claude.version)).toMatch(/^v?\d+/);
    const codex = payload.engines.find((engine) => engine.name === "codex")!;
    expect(codex).toMatchObject({ installed: false, runnable: false });
    expect(String(codex.error)).toContain("PATH");
    expect(payload.engines.some((engine) => engine.name === "gemini")).toBe(false);
  });

  it("marks a binary that starts but exits non-zero as installed-but-not-runnable", async () => {
    const broken = fakeBin("broken-engine", 3);
    const payload = await probe(contextFor({ claude: { bin: broken, model: "opus" }, codex: { bin: "nope-xyz", model: "gpt" } }));
    const claude = payload.engines.find((engine) => engine.name === "claude")!;
    expect(claude).toMatchObject({ installed: true, runnable: false });
    expect(claude.error).toBeDefined();
    expect(claude.auth).toBeUndefined(); // login is only observed for engines that start
  });

  it("projects Claude login state without ever returning the credential itself", async () => {
    const dir = path.join(scratch, "claude-config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat-SECRET", refreshToken: "sk-ant-ort-SECRET", expiresAt: Date.now() + 3_600_000 },
    }));
    const payload = await probe(contextFor({ claude: { bin: process.execPath, model: "opus" }, codex: { bin: "nope-xyz", model: "gpt" } }));
    const claude = payload.engines.find((engine) => engine.name === "claude")!;
    expect(claude.auth).toMatchObject({ method: "oauth", expired: false });
    expect(String(claude.auth!.note)).toContain("有効性は初回実行時に判明"); // observed, not proven
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("reports an expired OAuth session, and an env API key, as what they are", async () => {
    const dir = path.join(scratch, "claude-config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() - 1000 } }));
    let payload = await probe(contextFor({ claude: { bin: process.execPath, model: "opus" }, codex: { bin: "nope-xyz", model: "gpt" } }));
    expect(payload.engines.find((engine) => engine.name === "claude")!.auth).toMatchObject({ method: "oauth", expired: true });

    _resetEngineProbeCache();
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-SECRET";
    payload = await probe(contextFor({ claude: { bin: process.execPath, model: "opus" }, codex: { bin: "nope-xyz", model: "gpt" } }));
    expect(payload.engines.find((engine) => engine.name === "claude")!.auth).toMatchObject({ method: "api-key" });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("does not answer a changed engine config from the previous config's cache", async () => {
    const before = await probe(contextFor({ claude: { bin: process.execPath, model: "opus" }, codex: { bin: "nope-xyz", model: "gpt" } }));
    // Same process, no reset — only the config differs (codex now points at a real binary).
    const after = await probe(contextFor({ claude: { bin: process.execPath, model: "opus" }, codex: { bin: process.execPath, model: "gpt" } }));
    expect(after.probedAt).not.toBe(before.probedAt);
    expect(after.engines.find((engine) => engine.name === "codex")!.runnable).toBe(true);
  });

  it("shares one probe across concurrent requests and serves it from cache briefly", async () => {
    const context = contextFor({ claude: { bin: process.execPath, model: "opus" }, codex: { bin: "nope-xyz", model: "gpt" } });
    const [first, second] = await Promise.all([probe(context), probe(context)]);
    expect(second.probedAt).toBe(first.probedAt); // same in-flight probe
    const third = await probe(context);
    expect(third.probedAt).toBe(first.probedAt); // cached within the TTL
    _resetEngineProbeCache();
    const fourth = await probe(context);
    expect(fourth.probedAt).not.toBe(first.probedAt); // a fresh probe after reset
  });
});
