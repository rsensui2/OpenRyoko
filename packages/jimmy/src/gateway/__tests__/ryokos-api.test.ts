import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH, JINN_HOME, ORG_DIR } from "../../shared/paths.js";
import { peerHomeDir, peerMemoryPath, peerYamlPath } from "../../shared/peer-ryoko.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { createPeer, peerExists, slugFor } from "../ryokos/ryoko-store.js";
import { connectSlackInstance } from "../slack-instance-connect.js";
import { instanceRouteOptions } from "../instance-routing.js";
import type { Employee } from "../../shared/types.js";
import { readSlackAppRecord, writeSlackAppRecord } from "../slack-provision/provision-store.js";

/* Peer Ryokos over HTTP, through the real api.ts routing and config writer.
 * Properties under test: the contract the UI is written against, the main
 * Ryoko cannot be changed here, names never collide, memory is never deleted,
 * and a peer's Slack app lands in its own connector instance with the same
 * verify → save → reload → rollback guarantees as the main one. */

type Reload = () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
const SETTLES = { started: [], stopped: [], errors: [] };

function request(method: string, pathname: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const readable = Readable.from(chunks) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

interface CallOptions { reload?: Reload; connectors?: Map<string, unknown> }

async function call(method: string, pathname: string, body?: unknown, options: CallOptions = {}): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude", claude: { model: "claude-opus-5" } }, portal: { portalName: "Ryoko" } }),
    connectors: options.connectors ?? new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: options.reload ?? (async () => SETTLES),
    suppressNextConnectorReload: vi.fn(), clearSuppressNextConnectorReload: vi.fn(),
  } as unknown as ApiContext;
  await handleApiRequest(request(method, pathname, body), res, context);
  return { status, body: chunks.length ? JSON.parse(chunks.join("")) : null };
}

const VALID = { displayName: "Hana", persona: "Calm research partner.", engine: "codex" as const, memory: "own" as const };
const config = () => yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  fs.mkdirSync(JINN_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, "# instance\nconnectors:\n  slack:\n    botToken: xoxb-MAIN\n    appToken: xapp-MAIN\n");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, team: "T-TEST", user: "hana" }) }) as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const entry of [ORG_DIR, path.join(JINN_HOME, "ryokos"), path.join(JINN_HOME, "slack-apps"), CONFIG_PATH]) {
    fs.rmSync(entry, { recursive: true, force: true });
  }
});

describe("slugFor", () => {
  it("makes a slug from the display name and avoids names already taken", () => {
    expect(slugFor("Hana Sato", new Set())).toBe("hana-sato");
    expect(slugFor("Café Ryoko!", new Set())).toBe("cafe-ryoko");
    expect(slugFor("hana", new Set(["hana"]))).toBe("hana-2");
    expect(slugFor("hana", new Set(["hana", "hana-2"]))).toBe("hana-3");
    expect(slugFor("Main", new Set(["main"]))).toBe("main-2");
    expect(slugFor("x".repeat(60), new Set(["x".repeat(40)]))).toBe(`${"x".repeat(38)}-2`);
  });

  it("falls back to ryoko-2, ryoko-3… when the name has no latin letters or digits", () => {
    expect(slugFor("はな", new Set())).toBe("ryoko-2");
    expect(slugFor("はな", new Set(["ryoko-2"]))).toBe("ryoko-3");
  });
});

describe("GET /api/ryokos", () => {
  it("lists the main Ryoko first, then peers with their Slack instance", async () => {
    await createPeer({ ...VALID, engine: "codex", memory: "shared", emoji: "🌸", model: "gpt-5.6-sol" });
    const config0 = config();
    config0.connectors.instances = [{ id: "slack-hana", type: "slack", employee: "hana", botToken: "xoxb-H", appToken: "xapp-H" }];
    fs.writeFileSync(CONFIG_PATH, yaml.dump(config0));

    const { status, body } = await call("GET", "/api/ryokos");
    expect(status).toBe(200);
    expect(body.ryokos).toEqual([
      { name: "main", displayName: "Ryoko", engine: "claude", model: "claude-opus-5", memory: "main", primary: true, slack: { connected: true } },
      { name: "hana", displayName: "Hana", emoji: "🌸", persona: "Calm research partner.", engine: "codex", model: "gpt-5.6-sol", memory: "shared", primary: false, slack: { connected: true, instanceId: "slack-hana" } },
    ]);
  });

  it("does not list ordinary employees, and reports a peer without tokens as not connected", async () => {
    fs.mkdirSync(path.join(ORG_DIR, "eng"), { recursive: true });
    fs.writeFileSync(path.join(ORG_DIR, "eng", "dev.yaml"), "name: dev\npersona: Builds.\n");
    await createPeer(VALID);
    const { body } = await call("GET", "/api/ryokos");
    expect(body.ryokos.map((r: { name: string }) => r.name)).toEqual(["main", "hana"]);
    expect(body.ryokos[1].slack).toEqual({ connected: false, instanceId: "slack-hana" });
  });
});

describe("POST /api/ryokos", () => {
  it("creates the YAML and, for own memory, an empty MEMORY.md", async () => {
    const { status, body } = await call("POST", "/api/ryokos", { ...VALID, emoji: "🌸" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ryoko: expect.objectContaining({ name: "hana", memory: "own", primary: false, emoji: "🌸" }) });
    const saved = yaml.load(fs.readFileSync(peerYamlPath("hana"), "utf8"));
    expect(saved).toEqual({
      name: "hana", department: "ryokos", rank: "executive", displayName: "Hana", persona: "Calm research partner.",
      engine: "codex", peer: { memory: "own" }, emoji: "🌸",
    });
    expect(fs.readFileSync(peerMemoryPath("hana"), "utf8")).toBe("");
    expect(fs.existsSync(path.join(peerHomeDir("hana"), "knowledge"))).toBe(true);
  });

  it("creates no memory folder for shared memory", async () => {
    await call("POST", "/api/ryokos", { ...VALID, memory: "shared" });
    expect(fs.existsSync(peerHomeDir("hana"))).toBe(false);
  });

  it("never reuses a name taken by an employee or another peer", async () => {
    fs.mkdirSync(path.join(ORG_DIR, "eng"), { recursive: true });
    fs.writeFileSync(path.join(ORG_DIR, "eng", "hana.yaml"), "name: hana\npersona: Builds.\n");
    const first = await call("POST", "/api/ryokos", VALID);
    const second = await call("POST", "/api/ryokos", VALID);
    const third = await call("POST", "/api/ryokos", { ...VALID, displayName: "はな" });
    expect([first.body.ryoko.name, second.body.ryoko.name, third.body.ryoko.name]).toEqual(["hana-2", "hana-3", "ryoko-2"]);
  });

  it.each([
    [{ ...VALID, displayName: "" }, /displayName/],
    [{ ...VALID, displayName: "x".repeat(41) }, /displayName/],
    [{ ...VALID, persona: "   " }, /persona/],
    [{ ...VALID, persona: "x".repeat(4001) }, /persona/],
    [{ ...VALID, engine: "gemini" }, /engine/],
    [{ ...VALID, memory: "main" }, /memory/],
    [{ ...VALID, emoji: "123456789" }, /emoji/],
    [{ ...VALID, model: "m".repeat(81) }, /model/],
    [{ ...VALID, model: "--dangerous flag" }, /model/],
    [[VALID], /object/],
  ])("rejects %j", async (body, message) => {
    const { status, body: answer } = await call("POST", "/api/ryokos", body);
    expect(status).toBe(400);
    expect(answer.error).toMatch(message);
    expect(fs.existsSync(path.join(ORG_DIR, "ryokos"))).toBe(false);
  });
});

describe("PATCH /api/ryokos/:name", () => {
  it("changes only the fields sent and clears model with null", async () => {
    await call("POST", "/api/ryokos", { ...VALID, memory: "shared", model: "gpt-5.6-sol" });
    const { status, body } = await call("PATCH", "/api/ryokos/hana", { persona: "Sharper.", model: null });
    expect(status).toBe(200);
    expect(body.ryoko).toMatchObject({ name: "hana", displayName: "Hana", persona: "Sharper.", engine: "codex", memory: "shared" });
    expect(body.ryoko.model).toBeUndefined();
  });

  it("switching own → shared keeps the own memory on disk; shared → own creates it", async () => {
    await call("POST", "/api/ryokos", VALID);
    fs.writeFileSync(peerMemoryPath("hana"), "- remembered\n");
    await call("PATCH", "/api/ryokos/hana", { memory: "shared" });
    expect(fs.readFileSync(peerMemoryPath("hana"), "utf8")).toBe("- remembered\n");
    await call("PATCH", "/api/ryokos/hana", { memory: "own" });
    expect(fs.readFileSync(peerMemoryPath("hana"), "utf8")).toBe("- remembered\n");

    await call("POST", "/api/ryokos", { ...VALID, displayName: "Sora", memory: "shared" });
    await call("PATCH", "/api/ryokos/sora", { memory: "own" });
    expect(fs.readFileSync(peerMemoryPath("sora"), "utf8")).toBe("");
  });

  it("refuses main, unknown names, ordinary employees and bad input", async () => {
    await call("POST", "/api/ryokos", VALID);
    fs.mkdirSync(path.join(ORG_DIR, "ryokos"), { recursive: true });
    fs.writeFileSync(path.join(ORG_DIR, "ryokos", "plain.yaml"), "name: plain\npersona: Builds.\n");
    expect((await call("PATCH", "/api/ryokos/main", { persona: "x" })).status).toBe(400);
    expect((await call("PATCH", "/api/ryokos/nobody", { persona: "x" })).status).toBe(404);
    expect((await call("PATCH", "/api/ryokos/plain", { persona: "x" })).status).toBe(404);
    expect((await call("PATCH", "/api/ryokos/..%2Fetc", { persona: "x" })).status).toBe(400);
    expect((await call("PATCH", "/api/ryokos/hana", { engine: "gemini" })).status).toBe(400);
  });
});

describe("DELETE /api/ryokos/:name", () => {
  it("removes the YAML and its Slack instance, keeps memory and other instances", async () => {
    await call("POST", "/api/ryokos", VALID);
    const doc = config();
    doc.connectors.instances = [
      { id: "slack-hana", type: "slack", employee: "hana", botToken: "xoxb-H", appToken: "xapp-H" },
      { id: "discord-vox", type: "discord", botToken: "D" },
    ];
    fs.writeFileSync(CONFIG_PATH, yaml.dump(doc));
    writeSlackAppRecord({ teamId: "T1", appId: "A1", clientSecret: "SECRET", pendingBotToken: "xoxb-PENDING" }, JINN_HOME, "hana");
    const reload = vi.fn<Reload>().mockResolvedValue(SETTLES);

    const { status, body } = await call("DELETE", "/api/ryokos/hana", undefined, { reload });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, keptMemory: true });
    expect(fs.existsSync(peerYamlPath("hana"))).toBe(false);
    expect(fs.existsSync(peerMemoryPath("hana"))).toBe(true);
    expect(config().connectors.instances).toEqual([{ id: "discord-vox", type: "discord", botToken: "D" }]);
    expect(config().connectors.slack.botToken).toBe("xoxb-MAIN");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readSlackAppRecord(JINN_HOME, "hana")).toMatchObject({ appId: "A1" });
    expect(readSlackAppRecord(JINN_HOME, "hana")?.clientSecret).toBeUndefined();
  });

  it("reports keptMemory: false for a shared-memory peer and leaves config alone without an instance", async () => {
    await call("POST", "/api/ryokos", { ...VALID, memory: "shared" });
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    const reload = vi.fn<Reload>().mockResolvedValue(SETTLES);
    expect((await call("DELETE", "/api/ryokos/hana", undefined, { reload })).body).toEqual({ ok: true, keptMemory: false });
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses main and unknown names", async () => {
    expect((await call("DELETE", "/api/ryokos/main")).status).toBe(400);
    expect((await call("DELETE", "/api/ryokos/nobody")).status).toBe(404);
  });
});

describe("POST /api/onboarding/slack/finish for a peer", () => {
  it("writes the peer's connector instance, keeping its other fields, and leaves the main Slack block alone", async () => {
    await call("POST", "/api/ryokos", VALID);
    const doc = config();
    doc.connectors.instances = [{ id: "slack-hana", type: "slack", employee: "hana", botToken: "xoxb-OLD", appToken: "xapp-OLD", respondTo: { channel: "mention" } }];
    fs.writeFileSync(CONFIG_PATH, yaml.dump(doc));
    writeSlackAppRecord({ teamId: "T1", appId: "A1", clientSecret: "SECRET", pendingBotToken: "xoxb-NEW" }, JINN_HOME, "hana");

    const { body } = await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-NEW" });
    expect(body).toMatchObject({ ok: true, instanceId: "slack-hana", team: "T-TEST" });
    expect(config().connectors.instances).toEqual([
      { id: "slack-hana", type: "slack", employee: "hana", botToken: "xoxb-NEW", appToken: "xapp-NEW", respondTo: { channel: "mention" } },
    ]);
    expect(config().connectors.slack).toEqual({ botToken: "xoxb-MAIN", appToken: "xapp-MAIN" });
    // That bot's setup secrets are dropped, the main record is untouched.
    expect(readSlackAppRecord(JINN_HOME, "hana")).not.toHaveProperty("pendingBotToken");
  });

  it("puts config.yaml back byte for byte when the instance does not start", async () => {
    await call("POST", "/api/ryokos", VALID);
    const before = fs.readFileSync(CONFIG_PATH);
    let saved = "";
    const reload = vi.fn<Reload>()
      .mockImplementationOnce(async () => { saved = fs.readFileSync(CONFIG_PATH, "utf8"); return { ...SETTLES, errors: ['Failed to start "slack-hana": invalid_auth'] }; })
      .mockResolvedValue(SETTLES);

    const { body } = await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-BAD", botToken: "xoxb-BAD" }, { reload });
    expect(yaml.load(saved)).toMatchObject({ connectors: { instances: [{ id: "slack-hana", botToken: "xoxb-BAD" }] } });
    expect(body).toMatchObject({ ok: false, stage: "reload", previous: "none", rolledBack: true, restored: { disk: true, running: false } });
    expect(fs.readFileSync(CONFIG_PATH).equals(before)).toBe(true);
  });

  it("is not failed by another connector's reload error", async () => {
    await call("POST", "/api/ryokos", VALID);
    const reload = vi.fn<Reload>().mockResolvedValue({ ...SETTLES, errors: ['Failed to start "slack-hana-2": invalid_auth'] });
    const { body } = await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-1", botToken: "xoxb-1" }, { reload });
    expect(body).toMatchObject({ ok: true });
  });

  it("does not save tokens Slack refuses", async () => {
    await call("POST", "/api/ryokos", VALID);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "invalid_auth" }) }) as Response));
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    const { body } = await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-1", botToken: "xoxb-1" });
    expect(body).toMatchObject({ ok: false, stage: "verify" });
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(before);
  });

  it("refuses a bot that is not a peer Ryoko", async () => {
    const { status } = await call("POST", "/api/onboarding/slack/finish", { bot: "nobody", appToken: "xapp-1", botToken: "xoxb-1" });
    expect(status).toBe(400);
  });

  it("the manual connect route accepts the same bot field", async () => {
    await call("POST", "/api/ryokos", VALID);
    const { body } = await call("POST", "/api/onboarding/slack/connect", { bot: "hana", appToken: "xapp-1", botToken: "xoxb-1" });
    expect(body).toMatchObject({ ok: true, instanceId: "slack-hana" });
    expect(config().connectors.instances[0]).toMatchObject({ id: "slack-hana", employee: "hana", botToken: "xoxb-1" });
  });
});

describe("GET /api/connectors/slack/channels?instance=", () => {
  const lister = (channels: unknown[]) => ({ name: "slack", listChannels: vi.fn(async () => channels) });

  it("lists the channels of the chosen instance, top-level slack by default", async () => {
    const connectors = new Map<string, unknown>([
      ["slack", lister([{ id: "C1", name: "main" }])],
      ["slack-hana", lister([{ id: "C2", name: "hana" }])],
      ["discord-vox", { name: "discord", listChannels: vi.fn() }],
    ]);
    expect((await call("GET", "/api/connectors/slack/channels", undefined, { connectors })).body).toEqual({ ok: true, channels: [{ id: "C1", name: "main" }] });
    expect((await call("GET", "/api/connectors/slack/channels?instance=slack-hana", undefined, { connectors })).body).toEqual({ ok: true, channels: [{ id: "C2", name: "hana" }] });
    const notSlack = await call("GET", "/api/connectors/slack/channels?instance=discord-vox", undefined, { connectors });
    expect(notSlack).toEqual({ status: 400, body: { ok: false, error: "slack_not_configured" } });
    expect((await call("GET", "/api/connectors/slack/channels?instance=missing", undefined, { connectors })).status).toBe(400);
  });
});

describe("names a deleted peer left behind", () => {
  it("are taken while its memory folder or Slack record remains", async () => {
    fs.mkdirSync(peerHomeDir("hana"), { recursive: true });
    fs.mkdirSync(path.join(JINN_HOME, "slack-apps"), { recursive: true });
    fs.writeFileSync(path.join(JINN_HOME, "slack-apps", "sora.json"), "{}");
    const hana = await call("POST", "/api/ryokos", VALID);
    const sora = await call("POST", "/api/ryokos", { ...VALID, displayName: "Sora" });
    expect([hana.body.ryoko.name, sora.body.ryoko.name]).toEqual(["hana-2", "sora-2"]);
  });

  it("a delete then a re-create never hands the old memory to the new Ryoko", async () => {
    await call("POST", "/api/ryokos", VALID);
    fs.writeFileSync(peerMemoryPath("hana"), "- old secret\n");
    await call("DELETE", "/api/ryokos/hana");
    const again = await call("POST", "/api/ryokos", VALID);
    expect(again.body.ryoko.name).toBe("hana-2");
    expect(fs.readFileSync(peerMemoryPath("hana-2"), "utf8")).toBe("");
  });
});

describe("peerExists — the one existence check", () => {
  it("accepts only a valid peer name with a managed peer YAML", async () => {
    await createPeer(VALID);
    fs.mkdirSync(path.join(ORG_DIR, "eng"), { recursive: true });
    fs.writeFileSync(path.join(ORG_DIR, "eng", "dev.yaml"), "name: dev\npersona: Builds.\npeer:\n  memory: own\n");
    fs.writeFileSync(path.join(ORG_DIR, "ryokos", "plain.yaml"), "name: plain\npersona: Builds.\n");
    expect(peerExists("hana")).toBe(true);
    for (const name of ["main", "dev", "plain", "nobody", "../hana", "Hana", 42, undefined]) expect(peerExists(name)).toBe(false);
  });
});

describe("a DELETE racing a Slack connect", () => {
  it("does not write the instance once the peer is gone (checked inside the config lock)", async () => {
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    const reload = vi.fn(async () => ({ status: "ok" as const }));
    const result = await connectSlackInstance(
      { verify: async () => ({ ok: true, bot: { ok: true }, app: { ok: true } }), reloadAfterWrite: reload },
      { id: "slack-hana", employee: "hana", botToken: "xoxb-1", appToken: "xapp-1", stillWanted: () => false },
    );
    expect(result).toEqual({ ok: false, instanceId: "slack-hana", error: "ryoko_not_found" });
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("finish for a peer deleted after the setup started is refused", async () => {
    await call("POST", "/api/ryokos", VALID);
    await call("DELETE", "/api/ryokos/hana");
    const { status } = await call("POST", "/api/onboarding/slack/finish", { bot: "hana", appToken: "xapp-1", botToken: "xoxb-1" });
    expect(status).toBe(400);
    expect(config().connectors.instances).toBeUndefined();
  });
});

describe("instanceRouteOptions", () => {
  const hana: Employee = { name: "hana", displayName: "Hana", department: "ryokos", rank: "executive", engine: "claude", persona: "Calm." };
  const registry = new Map([["hana", hana]]);

  it("routes to the bound employee, or to the main assistant when none is named", () => {
    expect(instanceRouteOptions("slack-hana", "hana", registry)).toEqual({ employee: hana });
    expect(instanceRouteOptions("slack-x", undefined, registry)).toEqual({});
  });

  it("drops the message when the bound employee does not exist, instead of answering as main", () => {
    expect(instanceRouteOptions("slack-sora", "sora", registry)).toBeNull();
  });
});
