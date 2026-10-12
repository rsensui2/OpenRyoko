import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_TEMPLATE_PATH } from "../../cli/initial-config.js";
import { CONFIG_PATH } from "../../shared/paths.js";
import { deepMerge, handleApiRequest, type ApiContext } from "../api.js";

/* config.yaml is edited by hand as much as through the API, and the shipped
 * template is mostly guidance comments. Saving through the API used to rewrite
 * the whole file with yaml.dump, which dropped every comment and re-quoted
 * every value. The property under test: a save changes the lines whose value
 * changed and leaves every other line byte-identical — while the data that
 * ends up on disk is exactly what the full rewrite would have stored. */

function fakeRequest(method: string, pathname: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

function context(reload?: ApiContext["reloadAllConnectors"]): ApiContext {
  return {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude" } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: reload,
  } as unknown as ApiContext;
}

async function call(method: string, pathname: string, body?: unknown, ctx: ApiContext = context()) {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  await handleApiRequest(fakeRequest(method, pathname, body), res, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: (chunks.length ? JSON.parse(chunks.join("")) : null) as any };
}

/** The shipped template, as an instance that has been running for a while
 *  carries it: operator identity filled in, IDs quoted as the template insists. */
const TEMPLATE = fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf-8").replace(
  "portal:\n  portalName: Ryoko\n",
  'portal:\n  portalName: Ryoko\n  operatorDiscordId: "1543864208750542941"   # 亮介\n  trustedSpeakers:\n    - U0XXXXXXX   # Slack\n    - "1543864208750542941"\n',
);

const onDisk = () => fs.readFileSync(CONFIG_PATH, "utf-8");
const parsed = (text: string) => yaml.load(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const commentLines = (text: string) => text.split("\n").filter((line) => line.trimStart().startsWith("#"));

/** A line diff (longest common subsequence): the lines only `before` has and
 *  the lines only `after` has. Every other line is the same, in the same order. */
function changedLines(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (common[i + 1][j] >= common[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] };
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, TEMPLATE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("PUT /api/config on a commented config.yaml", () => {
  it("has a template worth protecting: mostly comments, IDs quoted", () => {
    expect(commentLines(TEMPLATE).length).toBeGreaterThan(50);
    expect(parsed(TEMPLATE).portal.operatorDiscordId).toBe("1543864208750542941");
  });

  it("changes one line for one changed value and leaves every other line byte-identical", async () => {
    const answer = await call("PUT", "/api/config", { engines: { claude: { effortLevel: "high" } } });
    expect(answer.status).toBe(200);

    expect(changedLines(TEMPLATE, onDisk())).toEqual({ removed: ["    effortLevel: xhigh"], added: ["    effortLevel: high"] });
    expect(parsed(onDisk()).engines.claude.effortLevel).toBe("high");
  });

  it("keeps a digits-only ID a quoted string, on an untouched line and on the line that changes", async () => {
    await call("PUT", "/api/config", { logging: { level: "debug" } });
    expect(onDisk()).toContain('  operatorDiscordId: "1543864208750542941"   # 亮介\n');
    expect(onDisk()).toContain('    - "1543864208750542941"\n');

    await call("PUT", "/api/config", { portal: { operatorDiscordId: "2222222222222222222" } });
    expect(onDisk()).toContain('  operatorDiscordId: "2222222222222222222"   # 亮介\n');
    expect(parsed(onDisk()).portal.operatorDiscordId).toBe("2222222222222222222"); // a string, digit for digit
  });

  it("keeps every comment when the Settings page saves the whole document back with one edit", async () => {
    const loaded = (await call("GET", "/api/config")).body;
    const edited = { ...loaded, gateway: { ...loaded.gateway, port: 7800 } };
    expect((await call("PUT", "/api/config", edited)).status).toBe(200);

    expect(commentLines(onDisk())).toEqual(commentLines(TEMPLATE));
    expect(onDisk()).toContain("  port: 7800\n");
    expect(onDisk()).toContain('  host: "127.0.0.1"\n'); // quotes on a neighbouring line survive
    expect(onDisk()).toContain("    provider: playwright   # または \"puppeteer\"\n"); // and so does an aligned trailing comment
  });

  it("stores exactly the data the full rewrite stored, for every kind of change deepMerge can make", async () => {
    const bodies: Record<string, unknown>[] = [
      { engines: { default: "codex" } }, // change a value
      { gateway: { port: 7800, allowedHosts: ["ryoko.example.com"] } }, // change one, add one
      { portal: { trustedSpeakers: ["U1"] } }, // an array is replaced whole
      { portal: { operatorDiscordId: null } }, // null removes the key
      { connectors: { slack: { botToken: "xoxb-1", appToken: "xapp-1" }, discord: { botToken: "d-1", allowFrom: ["1", "2"] } } },
      { sessions: { interruptOnNewMessage: true }, stt: { enabled: true, languages: ["en", "ja"] } }, // new sections
      { mcp: { search: { enabled: true, apiKey: "k: v # not a comment" } } }, // a value that needs quoting
      { cron: { alertChannel: "#alerts" } }, // a key that had only comments under it
      { logging: null }, // remove a whole section
    ];
    for (const body of bodies) {
      const before = onDisk();
      const expected = deepMerge(parsed(before), body);
      expect((await call("PUT", "/api/config", body)).status).toBe(200);
      expect(parsed(onDisk())).toEqual(expected);
      // A handful of lines differ; every other line is where it was, byte for byte.
      const { removed, added } = changedLines(before, onDisk());
      expect(removed.length + added.length).toBeGreaterThan(0);
      expect(removed.length + added.length).toBeLessThan(20);
    }
    expect(commentLines(onDisk()).length).toBeGreaterThan(50);
  });
});

describe("the other API writers of config.yaml", () => {
  it("PUT /api/budgets adds its block without touching a line above it", async () => {
    expect((await call("PUT", "/api/budgets", { "a-lead": 25 })).status).toBe(200);
    expect(onDisk().startsWith(TEMPLATE)).toBe(true);
    expect(parsed(onDisk()).budgets).toEqual({ employees: { "a-lead": 25 } });
  });

  /** Connect with tokens Slack accepts but the connector then fails on, so the
   *  flow writes twice: the new tokens, then the rollback. */
  async function failedSlackConnect() {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, team: "TEKION", user: "ryoko" }) }) as Response));
    let afterConnect = "";
    const reload = vi.fn()
      .mockImplementationOnce(async () => { afterConnect = onDisk(); return { started: [], stopped: [], errors: ["slack: invalid_auth"] }; })
      .mockResolvedValue({ started: [], stopped: [], errors: [] });
    const answer = await call("POST", "/api/onboarding/slack/connect", { botToken: "xoxb-NEW", appToken: "xapp-NEW" }, context(reload));
    expect(answer.body).toMatchObject({ ok: false, rolledBack: true });
    return afterConnect;
  }

  it("the onboarding Slack connect replaces the tokens in place, and its rollback restores the file byte for byte", async () => {
    const original = TEMPLATE.replace(
      "    ignoreOldMessagesOnBoot: true\n",
      "    ignoreOldMessagesOnBoot: true\n    botToken: xoxb-OLD   # production workspace\n    appToken: \"xapp-OLD\"\n",
    );
    fs.writeFileSync(CONFIG_PATH, original);

    const afterConnect = await failedSlackConnect();

    expect(changedLines(original, afterConnect)).toEqual({
      removed: ["    botToken: xoxb-OLD   # production workspace", '    appToken: "xapp-OLD"'],
      added: ["    botToken: xoxb-NEW   # production workspace", '    appToken: "xapp-NEW"'],
    });
    expect(onDisk()).toBe(original);
  });

  it("the onboarding Slack connect adds a Slack block where there was none, and its rollback removes exactly that", async () => {
    const original = "# my instance\nconnectors:\n  # chat platforms\n  discord:\n    botToken: d-1   # main bot\n\nlogging:\n  level: info   # keep quiet\n";
    fs.writeFileSync(CONFIG_PATH, original);

    const afterConnect = await failedSlackConnect();

    expect(changedLines(original, afterConnect)).toEqual({ removed: [], added: ["  slack:", "    botToken: xoxb-NEW", "    appToken: xapp-NEW"] });
    expect(parsed(afterConnect).connectors).toEqual({ discord: { botToken: "d-1" }, slack: { botToken: "xoxb-NEW", appToken: "xapp-NEW" } });
    expect(onDisk()).toBe(original);
  });
});
