import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* The whole Slack hookup as one server-side operation. The property under
 * test: a failed attempt NEVER leaves config.yaml worse than it found it —
 * bad tokens are refused before any write, and a connector that fails to
 * start after a write gets the previous Slack block put back. */

function fakePost(pathname: string, body: unknown, method = "POST"): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
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

function stubSlack(botOk: boolean, appOk = true): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const method = String(url).split("/api/")[1]!;
    const answer = method === "auth.test"
      ? (botOk ? { ok: true, team: "TEKION", user: "ryoko" } : { ok: false, error: "invalid_auth" })
      : (appOk ? { ok: true } : { ok: false, error: "invalid_auth" });
    return { ok: true, status: 200, json: async () => answer } as Response;
  }));
}

function readConfig(): { connectors?: { slack?: Record<string, unknown> } } {
  return (yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as { connectors?: { slack?: Record<string, unknown> } }) || {};
}

function contextWith(reload: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>): ApiContext {
  return {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: reload,
  } as unknown as ApiContext;
}

const PREVIOUS = { botToken: "xoxb-OLD", appToken: "xapp-OLD", allowFrom: "U123" };

async function connect(context: ApiContext, botToken = "xoxb-NEW", appToken = "xapp-NEW"): Promise<Record<string, unknown>> {
  const { res, read } = fakeResponse();
  await handleApiRequest(fakePost("/api/onboarding/slack/connect", { botToken, appToken }), res, context);
  const { status, body } = read();
  expect(status).toBe(200);
  return body as Record<string, unknown>;
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump({ engines: { default: "claude" }, connectors: { slack: PREVIOUS } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("POST /api/onboarding/slack/connect", () => {
  it("refuses at verify and writes nothing when the bot token is bad", async () => {
    stubSlack(false);
    const reload = vi.fn();
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "verify", bot: { ok: false, error: "invalid_auth" } });
    expect(reload).not.toHaveBeenCalled();
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS); // untouched
  });

  it("saves and reports the workspace when tokens verify and the connector starts", async () => {
    stubSlack(true);
    const reload = vi.fn().mockResolvedValue({ started: ["slack"], stopped: ["slack"], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: true, team: "TEKION", user: "ryoko" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readConfig().connectors?.slack).toMatchObject({ botToken: "xoxb-NEW", appToken: "xapp-NEW", allowFrom: "U123" });
  });

  it("restores the previous Slack block when the connector fails to start after the save", async () => {
    stubSlack(true);
    const reload = vi.fn()
      .mockResolvedValueOnce({ started: [], stopped: ["slack"], errors: ["slack: An API error occurred: invalid_auth"] })
      .mockResolvedValueOnce({ started: ["slack"], stopped: [], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "reload", previous: "config", rolledBack: true, restored: { disk: true, running: true } });
    expect(String(outcome.error)).toContain("invalid_auth");
    expect(reload).toHaveBeenCalledTimes(2); // the failed start, then the rollback reload
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS);
  });

  it("does not call a rollback successful when the previous connector fails to come back", async () => {
    stubSlack(true);
    const reload = vi.fn()
      .mockResolvedValueOnce({ started: [], stopped: ["slack"], errors: ["slack: invalid_auth"] })
      .mockResolvedValueOnce({ started: [], stopped: [], errors: ["slack: connect ETIMEDOUT"] }); // rollback reload also fails
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "reload", previous: "config", rolledBack: false, restored: { disk: true, running: false } });
    expect(String(outcome.rollbackError)).toContain("ETIMEDOUT");
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS); // the file IS restored, and the result says so precisely
  });

  it("leaves a Slack block that someone else wrote meanwhile alone instead of rolling over it", async () => {
    stubSlack(true);
    const THEIRS = { botToken: "xoxb-THEIRS", appToken: "xapp-THEIRS" };
    const reload = vi.fn().mockImplementationOnce(async () => {
      // An out-of-band editor (vim, the CLI) rewrites the block while our
      // connector reload is in flight — the lock only covers API writers.
      fs.writeFileSync(CONFIG_PATH, yaml.dump({ engines: { default: "claude" }, connectors: { slack: THEIRS } }));
      return { started: [], stopped: [], errors: ["slack: invalid_auth"] };
    });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, rolledBack: false, restored: { disk: false, running: false } });
    expect(String(outcome.rollbackSkipped)).toContain("concurrently");
    expect(reload).toHaveBeenCalledTimes(1); // no rollback write, no second reload
    expect(readConfig().connectors?.slack).toEqual(THEIRS);
  });

  it("serializes concurrent connects: the second one's reload starts only after the first fully settles", async () => {
    stubSlack(true);
    let inFlight = 0;
    let overlapped = false;
    const reload = vi.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return { started: ["slack"], stopped: [], errors: [] };
    });
    const context = contextWith(reload);
    const [first, second] = await Promise.all([
      connect(context, "xoxb-ONE", "xapp-ONE"),
      connect(context, "xoxb-TWO", "xapp-TWO"),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(overlapped).toBe(false);
    expect(readConfig().connectors?.slack).toMatchObject({ botToken: "xoxb-TWO", appToken: "xapp-TWO" }); // last writer, in order
  });

  it("makes PUT /api/config wait for an in-flight connect (and never lose its write to the rollback)", async () => {
    stubSlack(true);
    let releaseReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    let markReloadStarted!: () => void;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    const reload = vi.fn()
      .mockImplementationOnce(async () => { markReloadStarted(); await reloadGate; return { started: [], stopped: [], errors: ["slack: invalid_auth"] }; })
      .mockResolvedValue({ started: ["slack"], stopped: [], errors: [] });
    const context = contextWith(reload);

    const connecting = connect(context, "xoxb-NEW", "xapp-NEW");
    // connect verifies with Slack BEFORE taking the lock; wait until it is
    // inside its critical section (first reload started) and THEN let a
    // settings-page save come in — that is the interleaving under test.
    await reloadStarted;
    let putDone = false;
    const putting = (async () => {
      const { res } = fakeResponse();
      await handleApiRequest(fakePost("/api/config", { portal: { portalName: "Ryoko2" } }, "PUT"), res, context);
      putDone = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(putDone).toBe(false); // blocked behind connect's critical section
    releaseReload();
    const outcome = await connecting;
    await putting;
    expect(outcome).toMatchObject({ rolledBack: true });
    const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as { portal?: { portalName?: string }; connectors?: { slack?: unknown } };
    expect(cfg.portal?.portalName).toBe("Ryoko2"); // the PUT landed AFTER the rollback and survived it
    expect(cfg.connectors?.slack).toEqual(PREVIOUS);
  });

  it("treats a reload that throws as a failure and rolls back too", async () => {
    stubSlack(true);
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ started: ["slack"], stopped: [], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "reload", rolledBack: true, error: "socket hang up" });
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS);
  });

  it("removes the Slack block again when there was none before a failed attempt", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ engines: { default: "claude" }, connectors: {} }));
    stubSlack(true);
    const reload = vi.fn()
      .mockResolvedValueOnce({ started: [], stopped: [], errors: ["slack: invalid_auth"] })
      .mockResolvedValueOnce({ started: [], stopped: [], errors: [] });
    const outcome = await connect(contextWith(reload));
    // Undoing an attempt where nothing was configured before is its own
    // state: the block is gone again and nothing is running — and the result
    // says so instead of claiming a previous connection came back.
    expect(outcome).toMatchObject({ ok: false, previous: "none", rolledBack: true, restored: { disk: true, running: false } });
    expect(readConfig().connectors?.slack).toBeUndefined();
  });

  it("does not call the removal a rollback when the reload after it fails too (no previous block)", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ engines: { default: "claude" }, connectors: {} }));
    stubSlack(true);
    const reload = vi.fn()
      .mockResolvedValueOnce({ started: [], stopped: [], errors: ["slack: invalid_auth"] })
      .mockResolvedValueOnce({ started: [], stopped: [], errors: ["slack: stop timed out"] }); // the removal reload does not settle either
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, previous: "none", rolledBack: false, restored: { disk: true, running: false } });
    expect(String(outcome.rollbackError)).toContain("stop timed out");
    expect(readConfig().connectors?.slack).toBeUndefined(); // the file IS clean again; only the live side is reported as unsettled
  });
});
