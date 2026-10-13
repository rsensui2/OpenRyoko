import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackupScheduler, type BackupScheduler } from "../../backup/scheduler.js";
import { logger } from "../../shared/logger.js";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* Backups are on by default for every instance, so a failing one has to be
 * visible where an operator already looks: /api/status, beside the disk-space
 * block. And the `backup` section has to be saveable through the same
 * PUT /api/config the settings page uses. */

function fakeRequest(method: string, pathname: string, body?: unknown): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

function fakeResponse(): { res: ServerResponse; read: () => { status: number; body: Record<string, unknown> } } {
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader(name: string, value: string) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: chunks.length ? JSON.parse(chunks.join("")) : {} }) };
}

function context(): ApiContext {
  const config = {
    gateway: { port: 7901, host: "127.0.0.1" },
    connectors: {},
    engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } },
  };
  return {
    config, getConfig: () => config, connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
}

async function call(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, read } = fakeResponse();
  await handleApiRequest(fakeRequest(method, pathname, body), res, context());
  return read();
}

const scratch: string[] = [];
let scheduler: BackupScheduler | undefined;
let database: Database.Database | undefined;

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  database?.close();
  database = undefined;
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/status", () => {
  it("carries a backup block beside the disk-space one", async () => {
    const { status, body } = await call("GET", "/api/status");

    expect(status).toBe(200);
    expect(body.storage).toMatchObject({ level: expect.any(String) });
    expect(body.backup).toEqual({ level: "unknown", directory: null, targets: {} });
  });

  it("shows a failing backup as a warning, with the target and the reason", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-api-"));
    scratch.push(home);
    database = new Database(":memory:");
    scheduler = startBackupScheduler({
      database,
      config: {},
      home,
      loadConfig: () => ({}),
      run: async (options) => ({
        directory: options.settings.directory,
        startedAt: options.now.toISOString(),
        finishedAt: options.now.toISOString(),
        status: "failed",
        targets: [
          { name: "home", status: "failed", error: "not enough free disk space to write a backup (12 MiB free)", warnings: [] },
          { name: "sessions", status: "ok", warnings: [] },
          { name: "workflows", status: "skipped", warnings: [] },
        ],
        pruned: [],
      }),
    });
    await scheduler.check();

    const { body } = await call("GET", "/api/status");

    expect(body.backup).toMatchObject({
      level: "warning",
      directory: path.join(home, "backups"),
      targets: {
        home: { lastSuccessAt: null, error: "not enough free disk space to write a backup (12 MiB free)" },
        sessions: { error: null },
      },
    });
  });
});

describe("PUT /api/config", () => {
  it("saves a backup section instead of rejecting it as an unknown key", async () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ gateway: { port: 7901, host: "127.0.0.1" }, engines: { default: "claude" } }));

    const { status, body } = await call("PUT", "/api/config", { backup: { enabled: true, retention: 7, directory: "/mnt/backups/ryoko" } });

    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    const saved = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as { backup?: unknown; gateway?: unknown };
    expect(saved.backup).toEqual({ enabled: true, retention: 7, directory: "/mnt/backups/ryoko" });
    expect(saved.gateway).toEqual({ port: 7901, host: "127.0.0.1" });
  });
});
