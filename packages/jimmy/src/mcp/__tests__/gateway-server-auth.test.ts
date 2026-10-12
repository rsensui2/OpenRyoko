import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ensureGatewayAuthToken,
  gatewayRequestNeedsAuth,
  shouldRequireGatewayAuth,
  verifyGatewayAuth,
} from "../../gateway/auth.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { JinnConfig, McpServerStdioConfig } from "../../shared/types.js";
import { resolveMcpServers } from "../resolver.js";

// The built-in gateway MCP server is what gives an agent send_message, child
// sessions and cron control. It called the gateway without credentials. A
// gateway bound to a network address (0.0.0.0 in the Docker image) requires
// the bearer token on every /api/ route, so each of those tools came back 401.
//
// This runs the real server script as Claude Code does — a child process
// speaking JSON-RPC over stdio, with exactly the environment the resolver
// writes into the MCP config — against a gateway that enforces auth with the
// gateway's own functions.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-mcp-server-"));

/** Transpile the server and everything it imports, laid out as the build does. */
function buildServerScript(): string {
  const emitted = new Set<string>();
  const emit = (source: string): void => {
    if (emitted.has(source)) return;
    emitted.add(source);
    const js = ts.transpileModule(fs.readFileSync(source, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const out = path.join(buildDir, path.relative(SRC_ROOT, source)).replace(/\.ts$/, ".js");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, js);
    for (const [, specifier] of js.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)) {
      emit(path.resolve(path.dirname(source), `${specifier}.ts`));
    }
  };
  emit(path.join(SRC_ROOT, "mcp", "gateway-server.ts"));
  fs.writeFileSync(path.join(buildDir, "package.json"), JSON.stringify({ type: "module" }));
  return path.join(buildDir, "mcp", "gateway-server.js");
}

interface SeenRequest { method: string; path: string; authorized: boolean; body: string }

describe("built-in gateway MCP server against a gateway that requires auth", () => {
  let serverScript: string;
  let gateway: http.Server;
  let gatewayUrl: string;
  let token: string;
  const seen: SeenRequest[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const savedGatewayUrl = process.env.RYOKO_GATEWAY_URL;

  beforeAll(async () => {
    serverScript = buildServerScript();
    token = ensureGatewayAuthToken(JINN_HOME);
    // A network bind is what makes auth mandatory (shouldRequireGatewayAuth).
    const authRequired = shouldRequireGatewayAuth({ gateway: { host: "0.0.0.0", port: 0 } } as JinnConfig);
    expect(authRequired).toBe(true);

    gateway = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const pathname = (req.url ?? "/").split("?")[0];
        // The same gate, built from the same functions, as gateway/server.ts.
        const authorized = !gatewayRequestNeedsAuth(authRequired, req.method, pathname)
          || verifyGatewayAuth(req.headers, token, JINN_HOME);
        seen.push({ method: req.method ?? "", path: pathname, authorized, body: Buffer.concat(chunks).toString("utf8") });
        if (!authorized) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing or invalid gateway authentication" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pathname.endsWith("/send") ? { status: "sent" } : []));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    if (typeof address === "object" && address) gatewayUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    seen.length = 0;
    for (const child of children.splice(0)) child.kill();
    if (savedGatewayUrl === undefined) delete process.env.RYOKO_GATEWAY_URL;
    else process.env.RYOKO_GATEWAY_URL = savedGatewayUrl;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  /** The environment the gateway hands the server through the MCP config. */
  function resolvedServerEnv(): Record<string, string> {
    process.env.RYOKO_GATEWAY_URL = gatewayUrl;
    const resolved = resolveMcpServers({ gateway: { enabled: true }, browser: { enabled: false } }, undefined, {});
    return (resolved.mcpServers.gateway as McpServerStdioConfig).env ?? {};
  }

  /** Start the server with only that environment — nothing inherited — and call one tool. */
  async function callTool(env: Record<string, string>, name: string, args: Record<string, unknown>) {
    const child = spawn(process.execPath, [serverScript], { env: { PATH: process.env.PATH ?? "", ...env } });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const response = new Promise<{ result?: { isError?: boolean; content: Array<{ text: string }> } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response from the MCP server; stderr: ${stderr}`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const line = stdout.split("\n").find((candidate) => candidate.includes('"id":1'));
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
    const { result } = await response;
    return { isError: result?.isError === true, text: result?.content[0]?.text ?? "", output: stdout + stderr };
  }

  it("reaches the gateway with the credentials the resolver arranged", async () => {
    const outcome = await callTool(resolvedServerEnv(), "list_cron_jobs", {});

    expect(outcome.text).not.toContain("401");
    expect(outcome.isError).toBe(false);
    expect(seen).toEqual([{ method: "GET", path: "/api/cron", authorized: true, body: "" }]);
  });

  it("delivers a send_message call instead of failing it with 401", async () => {
    const outcome = await callTool(resolvedServerEnv(), "send_message", { connector: "slack", channel: "C123", text: "hello" });

    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.text)).toEqual({ status: "sent" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/connectors/slack/send", authorized: true });
    expect(JSON.parse(seen[0].body)).toEqual({ channel: "C123", text: "hello" });
  });

  it("is refused when it has no way to obtain the token", async () => {
    const { JINN_HOME: _home, ...withoutHome } = resolvedServerEnv();

    const outcome = await callTool(withoutHome, "list_cron_jobs", {});

    // The gateway really does enforce auth here: without credentials it is 401.
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("401");
    expect(seen).toEqual([{ method: "GET", path: "/api/cron", authorized: false, body: "" }]);
  });

  it("keeps the token out of the MCP config and out of the server's output", async () => {
    const env = resolvedServerEnv();

    const outcome = await callTool(env, "list_cron_jobs", {});

    // The config is written to disk for Claude Code; the server reads the
    // token from the instance home instead of being handed it.
    expect(JSON.stringify(env)).not.toContain(token);
    expect(env.JINN_HOME).toBe(JINN_HOME);
    expect(outcome.output).not.toContain(token);
  });

  it("picks up a rotated token without being restarted", async () => {
    const env = resolvedServerEnv();
    const original = token;
    try {
      token = "rotated-token-".padEnd(48, "x");
      fs.writeFileSync(path.join(JINN_HOME, "gateway-auth.json"), JSON.stringify({ token }), { mode: 0o600 });

      const outcome = await callTool(env, "list_cron_jobs", {});

      expect(outcome.isError).toBe(false);
      expect(seen).toEqual([{ method: "GET", path: "/api/cron", authorized: true, body: "" }]);
    } finally {
      token = original;
      fs.writeFileSync(path.join(JINN_HOME, "gateway-auth.json"), JSON.stringify({ token }), { mode: 0o600 });
    }
  });
});
