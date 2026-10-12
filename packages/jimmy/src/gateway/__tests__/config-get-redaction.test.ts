import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* GET /api/config hides the secrets in the config behind "***", and PUT
 * /api/config leaves a "***" it gets back alone, so the Settings page can
 * save the document it was served without ever holding a token. Two things
 * are checked here: that an MCP API key is part of that arrangement, and that
 * serving the document from disk (rather than from the gateway's in-memory
 * copy) changed neither what is hidden nor the shape of the answer. */

function fakeRequest(method: string, pathname: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

let running: JinnConfig;

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
    getConfig: () => running, connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(fakeRequest(method, pathname, body), res, context);
  const text = chunks.join("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, text, body: (text ? JSON.parse(text) : null) as any };
}

/** Every place the config can hold a secret, next to settings that are not secret. */
const CONFIG = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5-5" }, codex: { bin: "codex", model: "gpt-6-sol" } },
  connectors: {
    slack: { botToken: "xoxb-SECRET-1", appToken: "xapp-SECRET-2", signingSecret: "SECRET-3", allowFrom: "U1", respondTo: { channel: "mention" } },
    discord: {
      botToken: "discord-SECRET-4", proxyViaToken: "proxy-SECRET-5",
      channelRouting: { "111": { url: "http://remote:7777", token: "route-SECRET-6" }, "222": "http://other:7777" },
    },
    telegram: { token: "telegram-SECRET-7" },
    whatsapp: { authDir: "/home/ryoko/.whatsapp-auth" },
    instances: [
      { id: "sales", type: "slack", employee: "aiko", botToken: "xoxb-SECRET-8", appToken: "xapp-SECRET-9" },
      { id: "ops", type: "discord", botToken: "discord-SECRET-10", channelRouting: { "333": { url: "http://x:7777", token: "route-SECRET-11" } } },
    ],
  },
  mcp: {
    browser: { enabled: true, provider: "playwright" },
    search: { enabled: true, provider: "brave", apiKey: "brave-SECRET-12" },
    fetch: { enabled: true },
  },
  cron: null,
  portal: { portalName: "Ryoko", operatorDiscordId: "1543864208750542941" },
  logging: { file: true, stdout: true, level: "info" },
};

const onDisk = () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as typeof CONFIG;

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump(CONFIG));
  running = structuredClone(CONFIG) as unknown as JinnConfig;
});

afterEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("GET /api/config and the MCP API key", () => {
  it("hides mcp.search.apiKey like every other secret", async () => {
    const got = await call("GET", "/api/config");
    expect(got.body.mcp).toEqual({
      browser: { enabled: true, provider: "playwright" },
      search: { enabled: true, provider: "brave", apiKey: "***" },
      fetch: { enabled: true },
    });
    expect(got.text).not.toContain("brave-SECRET-12");
  });

  it("hides an apiKey wherever it sits under mcp, and invents none where there is none", async () => {
    const mcp = { search: { enabled: false }, custom: { tools: { command: "npx", apiKey: "custom-SECRET", args: ["-y", "x"] } } };
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp }));
    const got = await call("GET", "/api/config");
    expect(got.body.mcp).toEqual({ search: { enabled: false }, custom: { tools: { command: "npx", apiKey: "***", args: ["-y", "x"] } } });
  });

  it("keeps the stored key when the Settings page saves back the document it was served", async () => {
    const served = (await call("GET", "/api/config")).body;
    const saved = await call("PUT", "/api/config", { ...served, logging: { ...served.logging, level: "debug" } });
    expect(saved.status).toBe(200);
    expect(onDisk().mcp.search.apiKey).toBe("brave-SECRET-12"); // not "***", and not gone
    expect(onDisk().logging.level).toBe("debug");
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).not.toContain("***");
  });

  it("does not write a literal *** where there was no key to keep", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: { search: { enabled: true } } }));
    expect((await call("PUT", "/api/config", { mcp: { search: { apiKey: "***" } } })).status).toBe(200);
    expect(onDisk().mcp.search).toEqual({ enabled: true });
  });

  it("still lets a caller set a new key, or remove it with null", async () => {
    await call("PUT", "/api/config", { mcp: { search: { apiKey: "brave-NEW" } } });
    expect(onDisk().mcp.search.apiKey).toBe("brave-NEW");
    await call("PUT", "/api/config", { mcp: { search: { apiKey: null } } });
    expect(onDisk().mcp.search).toEqual({ enabled: true, provider: "brave" });
  });
});

describe("GET /api/config served from disk", () => {
  /** What the handler has always answered for CONFIG — written out, so that a change to it has to be made here on purpose. */
  const EXPECTED = {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5-5" }, codex: { bin: "codex", model: "gpt-6-sol" } },
    connectors: {
      slack: { botToken: "***", appToken: "***", signingSecret: "***", allowFrom: "U1", respondTo: { channel: "mention" } },
      discord: {
        botToken: "***", proxyViaToken: "***",
        channelRouting: { "111": { url: "http://remote:7777", token: "***" }, "222": "http://other:7777" },
      },
      telegram: { token: "***" },
      whatsapp: { authDir: "/home/ryoko/.whatsapp-auth" },
      instances: [
        { id: "sales", type: "slack", employee: "aiko", botToken: "***", appToken: "***" },
        { id: "ops", type: "discord", botToken: "***", channelRouting: { "333": { url: "http://x:7777", token: "***" } } },
      ],
    },
    mcp: {
      browser: { enabled: true, provider: "playwright" },
      search: { enabled: true, provider: "brave", apiKey: "***" },
      fetch: { enabled: true },
    },
    cron: null,
    portal: { portalName: "Ryoko", operatorDiscordId: "1543864208750542941" },
    logging: { file: true, stdout: true, level: "info" },
  };

  it("hides every secret and leaves everything else as it is", async () => {
    const got = await call("GET", "/api/config");
    expect(got.status).toBe(200);
    expect(got.body).toEqual(EXPECTED);
    expect(got.text).not.toContain("SECRET");
  });

  it("answers byte for byte what it answers from the in-memory config", async () => {
    const fromDisk = await call("GET", "/api/config");
    // No config.yaml: the handler serves the running config, as it did before
    // the document on disk became the source.
    fs.rmSync(CONFIG_PATH);
    const fromMemory = await call("GET", "/api/config");

    expect(fromMemory.body).toEqual(EXPECTED);
    expect(fromDisk.text).toBe(fromMemory.text); // same keys, same order, same placeholders
  });

  it("serves what is on disk, hidden the same way, when the two differ", async () => {
    // A hand edit the watcher has not picked up yet adds a connector and a key.
    const edited = structuredClone(CONFIG) as typeof CONFIG & { connectors: Record<string, unknown> };
    edited.connectors.telegram = { token: "telegram-SECRET-NEW" };
    edited.mcp.search.apiKey = "brave-SECRET-NEW";
    fs.writeFileSync(CONFIG_PATH, yaml.dump(edited));

    const got = await call("GET", "/api/config");

    expect(got.body).toEqual(EXPECTED); // same shape: the new values are secrets too
    expect(got.text).not.toContain("SECRET");
  });

  it("round-trips: saving the served document back changes nothing on disk", async () => {
    const before = fs.readFileSync(CONFIG_PATH, "utf-8");
    const served = (await call("GET", "/api/config")).body;
    expect((await call("PUT", "/api/config", served)).status).toBe(200);
    // `cron: null` is the one difference: a null in the body removes the key, as it always has.
    const { cron: _removed, ...kept } = yaml.load(before) as typeof CONFIG;
    expect(onDisk()).toEqual(kept);
  });
});
