import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { CONFIG_REVISION_HEADER } from "../config-revision.js";
import { CORS_ALLOWED_REQUEST_HEADERS, CORS_EXPOSED_RESPONSE_HEADERS } from "../request-origin.js";

/* The config revision, driven the way the Settings page drives it: read the
 * config, have somebody edit config.yaml behind the page's back, then save the
 * whole document the page was holding. The assertion that matters is not the
 * status code — it is that the bytes on disk are untouched afterwards. */

const HEADER = CONFIG_REVISION_HEADER.toLowerCase();

function fakeRequest(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json", ...headers };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

/** A response that remembers its headers, because the revision travels in one.
 *  writeHead(status, headers) merges over setHeader() values the way Node does. */
function fakeResponse() {
  let status = 0;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); return this; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    writeHead(code: number, extra?: Record<string, string>) {
      status = code;
      for (const [name, value] of Object.entries(extra ?? {})) headers[name.toLowerCase()] = String(value);
      return this;
    },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => ({
      status,
      revision: headers[HEADER] as string | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (chunks.length ? JSON.parse(chunks.join("")) : null) as any,
    }),
  };
}

const BASE = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5-5" }, codex: { bin: "codex", model: "gpt-6-sol" } },
  connectors: { slack: { botToken: "xoxb-STORED", appToken: "xapp-STORED" } },
  logging: { file: true, stdout: true, level: "info" },
};

/** What the gateway holds in memory. The watcher refreshes it ~1s after the
 *  file changes, so right after an edit it is still the previous document. */
let inMemory: JinnConfig;
const reload = vi.fn();
const suppress = vi.fn();

function context(): ApiContext {
  return {
    getConfig: () => inMemory, connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: reload, suppressNextConnectorReload: suppress,
  } as unknown as ApiContext;
}

async function call(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  const { res, read } = fakeResponse();
  await handleApiRequest(fakeRequest(method, pathname, body, headers), res, context());
  return read();
}

const sha256 = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const onDisk = () => fs.readFileSync(CONFIG_PATH);
const savedConfig = () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as typeof BASE;

/** The page's own move: load the config and remember what it was reading. */
async function loadPage() {
  const got = await call("GET", "/api/config");
  expect(got.status).toBe(200);
  return got;
}

/** An operator (or an agent) at a terminal, editing the file the page is not watching. */
function handEdit(mutate: (config: typeof BASE) => void) {
  const doc = savedConfig();
  mutate(doc);
  fs.writeFileSync(CONFIG_PATH, yaml.dump(doc));
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump(BASE));
  inMemory = structuredClone(BASE) as unknown as JinnConfig;
  reload.mockReset().mockResolvedValue({ started: [], stopped: [], errors: [] });
  suppress.mockReset();
});

afterEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("GET /api/config revision", () => {
  it("hands back the sha256 of the bytes on disk", async () => {
    expect((await loadPage()).revision).toBe(sha256(onDisk()));
  });

  it("changes when the file changes, and only then", async () => {
    const first = (await loadPage()).revision;
    expect((await loadPage()).revision).toBe(first);
    handEdit((doc) => { doc.logging.level = "debug"; });
    expect((await loadPage()).revision).not.toBe(first);
  });

  it("serves the document that revision describes, not the copy the watcher has yet to refresh", async () => {
    // Right after a hand edit the in-memory config is still the old one. A
    // page that reloads now (it was just told "the file changed, reload")
    // must not get the old values stamped with the new revision — its next
    // save would pass the check and put the old values back.
    handEdit((doc) => { doc.logging.level = "debug"; });
    const got = await loadPage();
    expect(got.revision).toBe(sha256(onDisk()));
    expect(got.body.logging.level).toBe("debug");
  });

  it("still masks connector secrets", async () => {
    const got = await loadPage();
    expect(got.body.connectors.slack).toEqual({ botToken: "***", appToken: "***" });
    expect(JSON.stringify(got.body)).not.toContain("STORED");
  });

  it("is empty for an instance whose config.yaml does not exist yet, and serves the running config", async () => {
    fs.rmSync(CONFIG_PATH);
    const got = await loadPage();
    expect(got.revision).toBe("");
    expect(got.body.gateway.port).toBe(7777);
  });

  it("keeps answering when config.yaml cannot be read, with a revision no file can have", async () => {
    fs.writeFileSync(CONFIG_PATH, "gateway: {\nengines: [oops\n");
    const got = await loadPage();
    expect(got.body.gateway.port).toBe(7777); // the last config the gateway loaded
    expect(got.revision).toBeTruthy();
    expect(got.revision).not.toMatch(/^[0-9a-f]{64}$/);

    // Once the operator repairs the file, the page that loaded during the
    // breakage is holding a document that was never on disk: refuse its save.
    fs.writeFileSync(CONFIG_PATH, yaml.dump(BASE));
    const repaired = onDisk();
    const put = await call("PUT", "/api/config", got.body, { [HEADER]: got.revision! });
    expect(put.status).toBe(409);
    expect(onDisk().equals(repaired)).toBe(true);
  });
});

describe("PUT /api/config against a stale revision", () => {
  it("refuses the save and leaves the file byte-identical", async () => {
    const page = await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });
    const before = onDisk();

    // The Settings page saves the whole document it loaded.
    const put = await call("PUT", "/api/config", page.body, { [HEADER]: page.revision! });

    expect(put.status).toBe(409);
    expect(put.body.code).toBe("CONFIG_CONFLICT");
    expect(String(put.body.error)).toContain("config.yaml");
    expect(onDisk().equals(before)).toBe(true); // not "the level is still debug" — not one byte moved
    expect(savedConfig().logging.level).toBe("debug");
  });

  it("touches neither the connectors nor the watcher for a save it refused", async () => {
    const page = await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });
    await call("PUT", "/api/config", { connectors: { slack: { botToken: "xoxb-NEW" } } }, { [HEADER]: page.revision! });
    expect(reload).not.toHaveBeenCalled();
    expect(suppress).not.toHaveBeenCalled();
  });

  it("accepts the save once the page has re-read the file", async () => {
    const stale = await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });
    expect((await call("PUT", "/api/config", stale.body, { [HEADER]: stale.revision! })).status).toBe(409);

    const fresh = await loadPage();
    const put = await call("PUT", "/api/config", { ...fresh.body, gateway: { ...fresh.body.gateway, port: 7800 } }, { [HEADER]: fresh.revision! });

    expect(put.status).toBe(200);
    expect(savedConfig().gateway.port).toBe(7800);
    expect(savedConfig().logging.level).toBe("debug"); // the hand edit survived the page's save
    expect(savedConfig().connectors.slack.botToken).toBe("xoxb-STORED");
  });

  it("hands back the revision it just wrote, so the page is not stale against its own save", async () => {
    const page = await loadPage();
    const put = await call("PUT", "/api/config", { logging: { level: "warn" } }, { [HEADER]: page.revision! });
    expect(put.status).toBe(200);
    expect(put.revision).toBe(sha256(onDisk()));
    // And it really is usable: saving straight back with it is not a conflict.
    expect((await call("PUT", "/api/config", { logging: { level: "error" } }, { [HEADER]: put.revision! })).status).toBe(200);
  });

  it("hands the new revision back on the connector-reload answers too", async () => {
    const page = await loadPage();
    const put = await call("PUT", "/api/config", { connectors: { slack: { botToken: "xoxb-NEW" } } }, { [HEADER]: page.revision! });
    expect(put.status).toBe(200);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(put.revision).toBe(sha256(onDisk()));
  });

  it("checks the revision under the config lock: of two saves holding the same revision, the second loses", async () => {
    const page = await loadPage();
    const [first, second] = await Promise.all([
      call("PUT", "/api/config", { logging: { level: "warn" } }, { [HEADER]: page.revision! }),
      call("PUT", "/api/config", { logging: { level: "error" } }, { [HEADER]: page.revision! }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(savedConfig().logging.level).toBe(first.status === 200 ? "warn" : "error");
  });
});

describe("PUT /api/config without a revision", () => {
  it("goes through as before, the way `ryoko api PUT /api/config` and agents send it", async () => {
    await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });

    const put = await call("PUT", "/api/config", { engines: { default: "codex" } });

    expect(put.status).toBe(200);
    expect(savedConfig().engines.default).toBe("codex");
    // A partial update never read the document it merges into: nothing stale was written over the hand edit.
    expect(savedConfig().logging.level).toBe("debug");
  });

  it("treats an empty revision (config.yaml did not exist when it was read) as none", async () => {
    fs.rmSync(CONFIG_PATH);
    const page = await loadPage();
    const put = await call("PUT", "/api/config", { logging: { level: "debug" } }, { [HEADER]: page.revision! });
    expect(put.status).toBe(200);
    expect(put.revision).toBe(sha256(onDisk()));
  });
});

describe("CORS header policy", () => {
  it("lets an allowed cross-origin browser client both send and read the config revision", () => {
    // One without the other is a silent half-failure: a response whose
    // revision the browser hides makes the page save without one, which is
    // exactly the overwrite the revision exists to prevent.
    expect(CORS_ALLOWED_REQUEST_HEADERS.split(", ")).toContain(CONFIG_REVISION_HEADER);
    expect(CORS_EXPOSED_RESPONSE_HEADERS.split(", ")).toContain(CONFIG_REVISION_HEADER);
  });

  it("keeps the request headers the gateway already accepted", () => {
    expect(CORS_ALLOWED_REQUEST_HEADERS.split(", ")).toEqual(expect.arrayContaining(["Content-Type", "Authorization"]));
  });
});
