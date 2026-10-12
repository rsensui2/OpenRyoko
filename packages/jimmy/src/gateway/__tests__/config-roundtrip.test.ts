import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH, TEMPLATE_DIR } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* The Settings page loads the config with GET /api/config and saves the whole
 * document back with PUT. A section of config.yaml written as a heading with
 * nothing but comments under it —
 *
 *     cron:
 *       # alertConnector: slack
 *
 * — is null to the parser, and comes back from GET as null. PUT took a null for
 * "remove this key", so saving without changing anything deleted the `cron:`
 * line. Its comments stayed, orphaned: uncommented later, `alertConnector`
 * would land under whatever section came before. The shipped config is written
 * exactly this way, so every fresh install lost a line on its first save. */

async function call(method: string, pathname: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  req.method = method;
  req.url = pathname;
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(req, res, context);
  const text = chunks.join("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: (text ? JSON.parse(text) : null) as any };
}

const onDisk = () => fs.readFileSync(CONFIG_PATH);
const write = (text: string | Buffer) => fs.writeFileSync(CONFIG_PATH, text);
/** GET the config and PUT back exactly what was served. */
async function saveUnchanged() {
  const served = await call("GET", "/api/config");
  expect(served.status).toBe(200);
  const saved = await call("PUT", "/api/config", served.body);
  expect(saved.status).toBe(200);
  return served.body;
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
});

afterEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("saving the config without changing it", () => {
  it("leaves the shipped config.yaml exactly as it is, byte for byte", async () => {
    const shipped = fs.readFileSync(path.join(TEMPLATE_DIR, "config.default.yaml"));
    write(shipped);

    await saveUnchanged();

    expect(onDisk().equals(shipped)).toBe(true);
  });

  it("does so a second time as well, and after the gateway's own reading of it", async () => {
    const shipped = fs.readFileSync(path.join(TEMPLATE_DIR, "config.default.yaml"));
    write(shipped);
    await saveUnchanged();
    await saveUnchanged();
    expect(onDisk().equals(shipped)).toBe(true);
  });

  /* Not only `cron:`. Any section — at the top level or inside another — can be
   * written as a bare heading, and the shipped config may grow more of them. */
  const HEADINGS = [
    "# every section here is a heading with only comments under it, or nothing at all",
    "gateway:",
    "  port: 7777",
    "  # host: 127.0.0.1",
    "engines:",
    "  default: claude",
    "  claude:",
    "    # bin: claude",
    "  codex:",
    "connectors:",
    "  slack:",
    "    # appToken: xapp-...",
    "  discord:",
    "mcp:",
    "  search:",
    "    # apiKey: ${BRAVE_API_KEY}",
    "  custom:",
    "    # my-server:",
    "    #   command: npx",
    "sessions:",
    "  # resumeInterruptedOnBoot: true",
    "cron:",
    "  # alertConnector: slack",
    "  # alertChannel: \"#alerts\"",
    "portal:",
    "  # portalName: Ryoko",
    "logging:",
    "",
  ].join("\n");

  it("leaves every bare heading in place, at the top level and nested", async () => {
    write(HEADINGS);
    const served = await saveUnchanged();
    expect(served.cron).toBeNull(); // what GET hands the page for such a heading
    expect(onDisk().toString("utf-8")).toBe(HEADINGS);
  });

  it("changes only the line that was edited when the page does change something", async () => {
    write(HEADINGS);
    const served = (await call("GET", "/api/config")).body;
    served.gateway.port = 7800;

    expect((await call("PUT", "/api/config", served)).status).toBe(200);

    expect(onDisk().toString("utf-8")).toBe(HEADINGS.replace("  port: 7777", "  port: 7800"));
  });

  it("fills a bare heading in when the page sets something under it, keeping its comments", async () => {
    write(HEADINGS);
    const served = (await call("GET", "/api/config")).body;
    served.cron = { alertChannel: "#ops" };

    expect((await call("PUT", "/api/config", served)).status).toBe(200);

    const text = onDisk().toString("utf-8");
    expect(yaml.load(text)).toMatchObject({ cron: { alertChannel: "#ops" } });
    expect(text).toContain("  # alertConnector: slack\n");
    expect(text).toContain("sessions:\n  # resumeInterruptedOnBoot: true\n");
  });
});

describe("a null in a saved config still removes a setting", () => {
  /* What null has always meant in a PUT: take this optional setting out, back
   * to its default. Only "null where config.yaml already says null" is new —
   * and that is no change at all. */
  const WITH_VALUES = "gateway:\n  port: 7777\ncron:\n  alertChannel: \"#alerts\"   # ops\n  alertConnector: slack\nlogging:\n  level: info\n";

  it("removes a key that holds a value", async () => {
    write(WITH_VALUES);
    expect((await call("PUT", "/api/config", { cron: { alertConnector: null } })).status).toBe(200);
    expect(onDisk().toString("utf-8")).toBe(WITH_VALUES.replace("  alertConnector: slack\n", ""));
  });

  it("removes a whole section that holds values", async () => {
    write(WITH_VALUES);
    expect((await call("PUT", "/api/config", { cron: null })).status).toBe(200);
    expect(yaml.load(onDisk().toString("utf-8"))).toEqual({ gateway: { port: 7777 }, logging: { level: "info" } });
  });

  it("adds nothing for a key that is not there", async () => {
    write(WITH_VALUES);
    expect((await call("PUT", "/api/config", { sessions: null, cron: { alertThrottleMinutes: null } })).status).toBe(200);
    expect(onDisk().toString("utf-8")).toBe(WITH_VALUES);
  });
});
