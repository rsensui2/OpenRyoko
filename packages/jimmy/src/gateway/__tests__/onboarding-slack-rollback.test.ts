import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* A Slack connect whose tokens Slack accepts but whose connector then fails to
 * start is rolled back. The rollback used to merge the previous Slack block
 * over the new one — and a merge cannot remove a key. Where the previous block
 * had no tokens (the shipped template's shape), the failed tokens stayed in
 * config.yaml while the answer said `rolledBack: true`. The property under
 * test: after a rollback the file is what it was before the attempt. */

function fakePost(pathname: string, body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = "POST";
  readable.url = pathname;
  return readable;
}

type Reload = () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
const suppress = vi.fn();
const clearSuppress = vi.fn();

async function connect(reload: Reload): Promise<Record<string, unknown>> {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude" } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: reload, suppressNextConnectorReload: suppress, clearSuppressNextConnectorReload: clearSuppress,
  } as unknown as ApiContext;
  await handleApiRequest(fakePost("/api/onboarding/slack/connect", { botToken: "xoxb-FAILED", appToken: "xapp-FAILED" }), res, context);
  expect(status).toBe(200);
  return JSON.parse(chunks.join(""));
}

const FAILS = { started: [], stopped: [], errors: ["slack: invalid_auth"] };
const SETTLES = { started: [], stopped: [], errors: [] };

/** The shape `ryoko setup` leaves behind: a Slack block with settings and guidance, and no tokens yet. */
const FRESH = [
  "# my instance",
  "engines:",
  "  default: claude",
  "",
  "connectors:",
  "  slack:",
  "    shareSessionInChannel: false   # one session per thread",
  "    ignoreOldMessagesOnBoot: true",
  "    # triage:",
  "    #   enabled: true",
  "",
  "logging:",
  "  level: info",
  "",
].join("\n");

const onDisk = () => fs.readFileSync(CONFIG_PATH, "utf-8");
const parsed = () => yaml.load(onDisk()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, FRESH);
  suppress.mockClear();
  clearSuppress.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, team: "TEKION", user: "ryoko" }) }) as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("rolling back a Slack connect that was saved but did not start", () => {
  it("takes the failed tokens out again when the Slack block had none before", async () => {
    let saved = "";
    const reload = vi.fn<Reload>()
      .mockImplementationOnce(async () => { saved = onDisk(); return FAILS; })
      .mockResolvedValue(SETTLES);

    const answer = await connect(reload);

    // The attempt really was written before it was undone.
    expect(yaml.load(saved)).toMatchObject({ connectors: { slack: { botToken: "xoxb-FAILED", appToken: "xapp-FAILED" } } });
    expect(answer).toMatchObject({ ok: false, stage: "reload", previous: "config", rolledBack: true, restored: { disk: true } });
    expect(onDisk()).not.toContain("FAILED");
    expect(parsed().connectors.slack).toEqual({ shareSessionInChannel: false, ignoreOldMessagesOnBoot: true });
  });

  it("puts the previous file back byte for byte", async () => {
    const reload = vi.fn<Reload>().mockResolvedValueOnce(FAILS).mockResolvedValue(SETTLES);
    await connect(reload);
    expect(onDisk()).toBe(FRESH);
  });

  it("puts back bytes, not a re-encoding of them: CRLF, a BOM and a stray non-UTF-8 byte survive", async () => {
    const original = Buffer.concat([
      Buffer.from("\uFEFF# caf", "utf-8"), Buffer.from([0xe9]), // "é" in Latin-1, not valid UTF-8
      Buffer.from("\r\nengines:\r\n  default: claude\r\nconnectors:\r\n  slack:\r\n    shareSessionInChannel: false\r\n", "utf-8"),
    ]);
    fs.writeFileSync(CONFIG_PATH, original);
    const reload = vi.fn<Reload>().mockResolvedValueOnce(FAILS).mockResolvedValue(SETTLES);

    const answer = await connect(reload);

    expect(answer).toMatchObject({ ok: false, rolledBack: true });
    expect(fs.readFileSync(CONFIG_PATH).equals(original)).toBe(true);
  });

  it("does the same when there was no Slack block at all", async () => {
    const bare = "# my instance\nengines:\n  default: claude\nconnectors:\n  discord:\n    botToken: d-1   # main bot\n";
    fs.writeFileSync(CONFIG_PATH, bare);
    const reload = vi.fn<Reload>().mockResolvedValueOnce(FAILS).mockResolvedValue(SETTLES);

    const answer = await connect(reload);

    expect(answer).toMatchObject({ ok: false, previous: "none", rolledBack: true });
    expect(onDisk()).toBe(bare);
  });

  it("undoes only its own Slack block when something else in the file changed meanwhile", async () => {
    const reload = vi.fn<Reload>()
      .mockImplementationOnce(async () => {
        // Somebody edits another section while the connector is trying to start.
        // The config lock only covers API writers; a hand edit is not held up.
        fs.writeFileSync(CONFIG_PATH, onDisk().replace("level: info", "level: debug"));
        return FAILS;
      })
      .mockResolvedValue(SETTLES);

    const answer = await connect(reload);

    expect(answer).toMatchObject({ ok: false, rolledBack: true, restored: { disk: true } });
    expect(parsed().logging.level).toBe("debug"); // their edit is theirs to keep
    expect(parsed().connectors.slack).toEqual({ shareSessionInChannel: false, ignoreOldMessagesOnBoot: true });
    expect(onDisk()).not.toContain("FAILED");
  });

  it("leaves a Slack block somebody else wrote meanwhile alone, and says it did not roll back", async () => {
    const theirs = FRESH.replace("    ignoreOldMessagesOnBoot: true\n", "    ignoreOldMessagesOnBoot: true\n    botToken: xoxb-THEIRS\n    appToken: xapp-THEIRS\n");
    const reload = vi.fn<Reload>().mockImplementationOnce(async () => { fs.writeFileSync(CONFIG_PATH, theirs); return FAILS; });

    const answer = await connect(reload);

    expect(answer).toMatchObject({ ok: false, rolledBack: false, restored: { disk: false, running: false } });
    expect(String(answer.rollbackSkipped)).toContain("concurrently");
    expect(onDisk()).toBe(theirs);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not claim a rollback when the file could not be put back", async () => {
    const rename = fs.renameSync.bind(fs);
    let swaps = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // The connect's own write lands; the rollback's write runs out of disk.
      if (path.basename(String(to)) === "config.yaml" && ++swaps === 2) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    const reload = vi.fn<Reload>().mockResolvedValueOnce(FAILS).mockResolvedValue(SETTLES);

    const answer = await connect(reload);

    expect(answer).toMatchObject({ ok: false, rolledBack: false, restored: { disk: false, running: false } });
    expect(String(answer.rollbackError)).toContain("ENOSPC");
    expect(reload).toHaveBeenCalledTimes(1); // no reload for a write that did not happen
  });

  it("keeps the watcher from reloading connectors a second time, once per write", async () => {
    const reload = vi.fn<Reload>().mockResolvedValueOnce(FAILS).mockResolvedValue(SETTLES);
    await connect(reload);
    expect(suppress).toHaveBeenCalledTimes(2); // the connect's write, then the rollback's
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
