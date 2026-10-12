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

describe("GET /api/config and a custom MCP server's env and headers", () => {
  /* A custom server keeps its secrets where no fixed key name can find them:
   * they are the values of its environment (API keys, tokens) and of its HTTP
   * headers (Authorization). So every value in those two blocks is hidden —
   * the names stay — and PUT puts the stored value back wherever the body
   * still carries the placeholder. */
  const MCP = {
    search: { enabled: true, provider: "brave", apiKey: "brave-SECRET-12" },
    custom: {
      notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "ntn-SECRET-A", LOG_LEVEL: "debug-SECRET-B", EMPTY: "" }, enabled: true },
      linear: { type: "sse", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer lin-SECRET-C", "X-Team": "ops-SECRET-D" } },
      clock: { command: "uvx", args: ["mcp-server-time"] },
    },
  };
  const text = () => fs.readFileSync(CONFIG_PATH, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = () => (yaml.load(text()) as any).mcp;

  beforeEach(() => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: MCP }));
  });

  it("hides every value of env and headers, and nothing else of the entry", async () => {
    const got = await call("GET", "/api/config");
    expect(got.body.mcp.custom).toEqual({
      notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "***", LOG_LEVEL: "***", EMPTY: "" }, enabled: true },
      linear: { type: "sse", url: "https://mcp.linear.app/sse", headers: { Authorization: "***", "X-Team": "***" } },
      clock: { command: "uvx", args: ["mcp-server-time"] },
    });
    expect(got.text).not.toContain("SECRET");
  });

  it("hides a value that is not a string, and a block written in a shape nobody expects, whole", async () => {
    const custom = {
      odd: { command: "x", env: { PIN: 4242, NESTED: { token: "nested-SECRET" } }, headers: "Authorization: Bearer inline-SECRET" },
      list: { command: "y", env: ["TOKEN=list-SECRET"] },
    };
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: { custom } }));
    const got = await call("GET", "/api/config");
    expect(got.body.mcp.custom).toEqual({
      odd: { command: "x", env: { PIN: "***", NESTED: "***" }, headers: "***" },
      list: { command: "y", env: "***" },
    });
    expect(got.text).not.toContain("SECRET");
    expect(got.text).not.toContain("4242");

    // ...and the served document saved back leaves all of it as it was.
    expect((await call("PUT", "/api/config", got.body)).status).toBe(200);
    expect(stored().custom).toEqual(custom);
  });

  it("keeps the stored values when the served document is saved back", async () => {
    const served = (await call("GET", "/api/config")).body;
    expect((await call("PUT", "/api/config", { ...served, logging: { ...served.logging, level: "debug" } })).status).toBe(200);
    expect(stored()).toEqual(MCP);
    expect(text()).not.toContain("***");
  });

  it("changes the value a caller sets and keeps the ones it sent back hidden", async () => {
    const served = (await call("GET", "/api/config")).body;
    served.mcp.custom.notion.env.LOG_LEVEL = "info";
    served.mcp.custom.linear.headers.Authorization = "Bearer lin-NEW";
    expect((await call("PUT", "/api/config", served)).status).toBe(200);
    expect(stored().custom.notion.env).toEqual({ NOTION_TOKEN: "ntn-SECRET-A", LOG_LEVEL: "info", EMPTY: "" });
    expect(stored().custom.linear.headers).toEqual({ Authorization: "Bearer lin-NEW", "X-Team": "ops-SECRET-D" });
  });

  it("adds a variable, and removes one with null, without touching the others", async () => {
    expect((await call("PUT", "/api/config", { mcp: { custom: { notion: { env: { NOTION_VERSION: "2026-01-01", LOG_LEVEL: null } } } } })).status).toBe(200);
    expect(stored().custom.notion.env).toEqual({ NOTION_TOKEN: "ntn-SECRET-A", EMPTY: "", NOTION_VERSION: "2026-01-01" });
  });

  it("never writes the placeholder where nothing is stored behind it", async () => {
    const saved = await call("PUT", "/api/config", {
      mcp: {
        custom: {
          renamed: { command: "npx", env: { NOTION_TOKEN: "***" } }, // a server config.yaml does not have
          notion: { env: { NEVER_SET: "***" } }, // a variable the entry does not have
          clock: { env: { TZ: "***" }, headers: "***" }, // blocks the entry does not have
        },
      },
    });
    expect(saved.status).toBe(200);
    expect(text()).not.toContain("***");
    expect(stored().custom).toEqual({ ...MCP.custom, renamed: { command: "npx" } });
  });

  it("does the same when config.yaml has no mcp block at all", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: undefined }));
    const saved = await call("PUT", "/api/config", { mcp: { custom: { fresh: { type: "sse", url: "https://x.example/sse", headers: { Authorization: "***", Accept: "text/event-stream" } } } } });
    expect(saved.status).toBe(200);
    expect(stored().custom.fresh).toEqual({ type: "sse", url: "https://x.example/sse", headers: { Accept: "text/event-stream" } });
  });
});

describe("a custom MCP server's env and names every object already has", () => {
  /* "constructor", "toString", "__proto__": every JavaScript object answers to
   * these without having them. A placeholder sent under such a name found the
   * built-in instead of a stored value and tried to save that — the request
   * failed with a 500. Only what config.yaml itself holds counts as stored. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = () => (yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any).mcp.custom;
  const inherited = () => JSON.parse('{"constructor":"***","toString":"***","valueOf":"***","hasOwnProperty":"***","__proto__":"***"}');

  it("drops a placeholder under such a name like any other with nothing stored behind it", async () => {
    const custom = { notion: { command: "npx", env: { NOTION_TOKEN: "ntn-SECRET-A" } } };
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: { custom } }));

    const saved = await call("PUT", "/api/config", { mcp: { custom: { notion: { env: { ...inherited(), NOTION_TOKEN: "***" }, headers: inherited() } } } });

    expect(saved.status).toBe(200);
    expect(stored()).toEqual(custom);
  });

  it("does the same for a server, or a block, config.yaml does not have", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: { custom: { plain: { command: "uvx" } } } }));

    const saved = await call("PUT", "/api/config", { mcp: { custom: { plain: { env: inherited() }, constructor: { command: "x", env: inherited() } } } });

    expect(saved.status).toBe(200);
    expect(stored()).toEqual({ plain: { command: "uvx" }, constructor: { command: "x" } });
  });

  it("still puts back a value that really is stored under such a name", async () => {
    const custom = { odd: { command: "x", env: { constructor: "real-SECRET", toString: "also-SECRET" } } };
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, mcp: { custom } }));

    const served = (await call("GET", "/api/config")).body;
    expect(served.mcp.custom.odd.env).toEqual({ constructor: "***", toString: "***" });
    expect((await call("PUT", "/api/config", served)).status).toBe(200);

    expect(stored()).toEqual(custom);
  });
});

describe("placeholders and lists", () => {
  /* A hidden value is put back by finding the stored item it was taken from.
   * Under a key that is easy; a list item has no name, only an `id` when it
   * was given one. An item without an id used to be taken for the first item
   * of the stored list — so every hidden apiKey in a list came back as the
   * first one's. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disk = () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
  const write = (config: unknown) => fs.writeFileSync(CONFIG_PATH, yaml.dump(config));

  it("leaves an apiKey inside a list as it is: saving the served document keeps every item's own key", async () => {
    const mcp = { pool: [{ label: "first", apiKey: "KEY-A" }, { label: "second", apiKey: "KEY-B" }] };
    write({ ...CONFIG, mcp });

    const served = (await call("GET", "/api/config")).body;
    expect((await call("PUT", "/api/config", served)).status).toBe(200);

    expect(disk().mcp).toEqual(mcp); // the second key used to come back as KEY-A
    expect(served.mcp.pool).toEqual(mcp.pool); // not hidden: a list item cannot be found again to put it back
  });

  it("does not give a list item without an id the fields of the first item", async () => {
    const links = [{ label: "docs", url: "https://a.example", pinned: true }, { label: "status", url: "https://b.example" }];
    write({ ...CONFIG, portal: { ...CONFIG.portal, links } });

    const served = (await call("GET", "/api/config")).body;
    expect((await call("PUT", "/api/config", served)).status).toBe(200);

    expect(disk().portal.links).toEqual(links); // "status" used to come back pinned
  });

  it("keeps each connector instance's tokens with its id, whatever order the instances come back in", async () => {
    const served = (await call("GET", "/api/config")).body;
    const reordered = { connectors: { instances: [...served.connectors.instances].reverse() } };
    expect((await call("PUT", "/api/config", reordered)).status).toBe(200);
    expect(disk().connectors.instances).toEqual([...CONFIG.connectors.instances].reverse());
  });

  it("writes no placeholder for a list item that is not in config.yaml", async () => {
    const served = (await call("GET", "/api/config")).body;
    const added = { id: "support", type: "slack", botToken: "***", appToken: "xapp-NEW", channelRouting: { "9": { url: "http://y:7777", token: "***" } } };
    const saved = await call("PUT", "/api/config", { connectors: { instances: [...served.connectors.instances, added, { type: "telegram", token: "***" }] } });

    expect(saved.status).toBe(200);
    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).not.toContain("***");
    expect(disk().connectors.instances).toEqual([
      ...CONFIG.connectors.instances, // their own tokens, put back by id
      { id: "support", type: "slack", appToken: "xapp-NEW", channelRouting: { "9": { url: "http://y:7777" } } },
      { type: "telegram" }, // no id: no stored item it could stand for
    ]);
  });
});

describe("placeholders for a block config.yaml does not have", () => {
  /* "***" means "keep what is stored". Where nothing is stored — the block the
   * request adds is not in config.yaml — there is nothing to keep, and the
   * placeholder itself must not become the token. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disk = () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
  const { discord: _discord, instances: _instances, ...withoutDiscord } = CONFIG.connectors;

  beforeEach(() => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ ...CONFIG, connectors: withoutDiscord, mcp: undefined }));
  });

  it("drops it from a connector block that is new", async () => {
    const saved = await call("PUT", "/api/config", {
      connectors: { discord: { botToken: "***", guildId: "42", channelRouting: { "111": { url: "http://remote:7777", token: "***" } } } },
    });
    expect(saved.status).toBe(200);
    expect(disk().connectors.discord).toEqual({ guildId: "42", channelRouting: { "111": { url: "http://remote:7777" } } });
    expect(disk().connectors.slack).toEqual(CONFIG.connectors.slack); // the blocks that are there keep their tokens
  });

  it("drops it from a top-level block that is new", async () => {
    expect((await call("PUT", "/api/config", { mcp: { search: { enabled: true, apiKey: "***" } } })).status).toBe(200);
    expect(disk().mcp).toEqual({ search: { enabled: true } });
  });

  it("drops it from every item of a list that is new", async () => {
    const saved = await call("PUT", "/api/config", { connectors: { instances: [{ id: "sales", type: "slack", botToken: "***", appToken: "***" }] } });
    expect(saved.status).toBe(200);
    expect(disk().connectors.instances).toEqual([{ id: "sales", type: "slack" }]);
  });

  it("still stores a real value in a new block", async () => {
    expect((await call("PUT", "/api/config", { connectors: { discord: { botToken: "discord-NEW" } } })).status).toBe(200);
    expect(disk().connectors.discord).toEqual({ botToken: "discord-NEW" });
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
