import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../shared/config.js";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* POST /api/files/transfer pushed a local file to a peer gateway listed under
 * the top-level `remotes` key. It never worked against a gateway with auth on
 * (it sent no Authorization), and nothing shipped ever set `remotes`. With
 * `remotes` set, though, any caller past the auth gate could have it read an
 * arbitrary local path and POST the contents to that peer. The route is
 * retired; a config that still carries `remotes:` must keep working. */

const REMOTES = { peer: { url: "http://peer.example:7777", label: "Peer" } };

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
  const emit = vi.fn();
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    // A gateway whose config still lists a remote — the only state in which
    // the old route got past its allowlist.
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude" }, remotes: REMOTES }),
    connectors: new Map(), sessionManager: {}, emit, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(fakeRequest(method, pathname, body), res, context);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: (chunks.length ? JSON.parse(chunks.join("")) : null) as any, emit };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-transfer-"));
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump({ gateway: { port: 7777, host: "127.0.0.1" }, engines: { default: "claude" }, remotes: REMOTES }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("POST /api/files/transfer (retired)", () => {
  it("no longer reads a local file and posts it to a configured remote", async () => {
    const secret = path.join(dir, "notes.txt");
    fs.writeFileSync(secret, "private contents");
    const outbound = vi.fn(async () => new Response(JSON.stringify({ id: "remote-id" }), { status: 201 }));
    vi.stubGlobal("fetch", outbound);

    const answer = await call("POST", "/api/files/transfer", { destination: "peer", file: secret });

    expect(outbound).not.toHaveBeenCalled();
    expect(answer.status).toBe(404);
    expect(answer.emit).not.toHaveBeenCalledWith("file:transferred", expect.anything());
  });

  it("is gone for a full destination URL too", async () => {
    const outbound = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", outbound);
    const answer = await call("POST", "/api/files/transfer", { destination: "http://peer.example:7777", file: CONFIG_PATH });
    expect(outbound).not.toHaveBeenCalled();
    expect(answer.status).toBe(404);
  });
});

describe("a config.yaml that still carries the retired `remotes` key", () => {
  it("still loads at startup", () => {
    expect(loadConfig().gateway.port).toBe(7777);
  });

  it("is served and saved back by the Settings round-trip without complaint", async () => {
    const loaded = await call("GET", "/api/config");
    expect(loaded.status).toBe(200);

    const saved = await call("PUT", "/api/config", { ...loaded.body, logging: { level: "debug" } });

    expect(saved.body?.error).toBeUndefined();
    expect(saved.status).toBe(200);
    const onDisk = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    expect(onDisk.logging).toEqual({ level: "debug" });
    expect(onDisk.remotes).toEqual(REMOTES); // left as the operator wrote it; the gateway just ignores it
  });
});
