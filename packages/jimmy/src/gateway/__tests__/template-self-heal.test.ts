import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { GATEWAY_STOPPED_FLAG } from "../../backup/database-restore.js";
import { BACKUP_KINDS } from "../../backup/targets.js";
import { createSession, getMessages, getSession, insertMessage, updateSession } from "../../sessions/registry.js";
import { DEFAULT_RESUME_MAX_AGE_MINUTES, MAX_RESTART_RESUMES } from "../../sessions/restart-resume.js";
import { ATTACHMENTS_DIR, STALE_ATTACHMENTS_AFTER_MS } from "../../shared/attachments.js";
import { JINN_HOME, TEMPLATE_DIR } from "../../shared/paths.js";
import { MAX_USAGE_LIMIT_WAIT_MS } from "../../shared/rateLimit.js";
import type { Session } from "../../shared/types.js";
import { handleApiRequest, type ApiContext } from "../api.js";

// The self-heal skill is what an agent follows when something is broken, and an
// unedited copy of it is replaced in every home at the first start of a release.
// It used to teach three repairs that did the damage themselves: emptying tmp/,
// writing `[]` over an unreadable cron/jobs.json, and setting session statuses in
// the database by hand. Nothing generates the skill from the code, so this holds
// it to what the gateway really offers — and keeps those three from coming back.

const read = (relative: string): string => fs.readFileSync(path.join(TEMPLATE_DIR, ...relative.split("/")), "utf-8");
const skill = (): string => read("skills/self-heal/SKILL.md");
const source = (relative: string): string => fs.readFileSync(path.join(import.meta.dirname, "..", "..", ...relative.split("/")), "utf-8");

/** Every status a session can have. The two lines under it make the compiler
 *  fail when the Session type gains or loses one without this list following. */
const STATUSES = ["idle", "running", "error", "waiting", "interrupted"] as const;
const everyStatusIsListed: Exclude<Session["status"], (typeof STATUSES)[number]> extends never ? true : false = true;
const everyListedIsAStatus: (typeof STATUSES)[number] extends Session["status"] ? true : false = true;

function context(): ApiContext {
  const config = {
    gateway: { port: 18999 },
    engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5" }, codex: { bin: "codex", model: "gpt-5.6-sol" } },
  };
  return {
    config,
    getConfig: () => config,
    // The two routes below ask the manager for the session's engine and its queue, and for nothing else.
    sessionManager: { getEngine: () => undefined, getQueue: () => ({ clearQueue: () => {} }) },
    startTime: Date.now(),
    connectors: new Map(),
    emit: () => {},
  } as unknown as ApiContext;
}

async function call(method: string, url: string): Promise<{ status: number; body: any }> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res = {
    setHeader() { return this; },
    getHeader() { return undefined; },
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : undefined; },
  } as unknown as ServerResponse;
  await handleApiRequest(req, res, context());
  return captured;
}

describe("skills/self-heal — what it must not teach", () => {
  it("does not have an agent empty tmp/, write an empty jobs file, or set statuses in the database", () => {
    const text = skill();

    expect(text).not.toMatch(/Delete all contents/i);
    expect(text).not.toMatch(/fresh default/i);
    expect(text).not.toMatch(/Update their status/i);
    // Statuses no session has ever had: an agent told to write them wrote them.
    expect(text).not.toMatch(/`failed`|`cancelled`/);
    expect(everyStatusIsListed && everyListedIsAStatus).toBe(true);
  });

  it("does not name a command or a port from before the fork", () => {
    expect(skill()).not.toMatch(/\bjinn (stop|start)\b/);
    expect(skill()).not.toContain("3777");
  });
});

describe("skills/self-heal — restore before rebuilding", () => {
  it("sends a broken file to the backups, with every kind `--only` takes", () => {
    const text = skill();

    expect(text).toMatch(/Restore before you rebuild/);
    for (const needed of ["ryoko backup list", "ryoko backup restore <id> --only <kind> --dry-run", "docs/backup.md"]) expect(text, needed).toContain(needed);
    for (const kind of BACKUP_KINDS) expect(text, kind).toContain(`\`${kind}\``);
  });

  it("keeps an unreadable cron/jobs.json from being replaced with an empty list, as the cron-manager skill does", () => {
    const text = skill();

    expect(text).toMatch(/Never replace `cron\/jobs\.json` with an empty list `\[\]`/);
    expect(read("skills/cron-manager/SKILL.md")).toMatch(/Never replace an unreadable existing store with `\[\]`/);
    // The line the scheduler logs while the file cannot be read: the skill quotes it, so it has to be the real one.
    const logged = "Cron reload skipped; keeping previous registrations";
    expect(text).toContain(logged);
    expect(source("cron/reconcile.ts")).toContain(logged);
  });

  it("leaves a database restore to the operator, with the gateway stopped and inside the container", () => {
    const text = skill();

    expect(text).toMatch(/Never restore a database yourself/);
    expect(text).toContain(`ryoko backup restore sessions-<date> ${GATEWAY_STOPPED_FLAG}`);
    expect(text).toMatch(/stop the gateway, wait a minute/);
    expect(text).toMatch(/inside the container/);
  });

  it("says commands belong where the gateway runs, not on the host side of a shared home", () => {
    expect(skill()).toMatch(/Commands are run where the gateway runs\.[^\n]*a `ryoko` on the host cannot see the gateway/);
  });
});

describe("skills/self-heal — sessions are handled through the API", () => {
  it("explains every status a session can have, and no other", () => {
    const section = skill().split("\n### 5. Check Sessions\n")[1]?.split("\n### ")[0] ?? "";
    const explained = [...section.matchAll(/^- `([a-z]+)`: /gm)].map((match) => match[1]);

    expect(explained.sort()).toEqual([...STATUSES].sort());
  });

  it("gives the wait for a usage limit the length the gateway uses", () => {
    expect(MAX_USAGE_LIMIT_WAIT_MS).toBe(6 * 60 * 60_000);
    expect(skill()).toMatch(/`waiting`: [^\n]*for up to six hours/);
  });

  it("does not promise that every interrupted session is woken: it gives the limits the gateway has", () => {
    const interrupted = skill().split("\n").find((line) => line.startsWith("- `interrupted`: ")) ?? "";

    expect(interrupted).toContain(`up to ${MAX_RESTART_RESUMES} per start`);
    expect(interrupted).toContain(`an interruption of the last ${DEFAULT_RESUME_MAX_AGE_MINUTES} minutes`);
    // What an agent needs to know about the ones left behind.
    expect(interrupted).toMatch(/One that was not woken stays `interrupted` until a new message continues it/);
    // Where the sentence sends the reader has to exist.
    expect(read("docs/architecture.md")).toContain("\n## Session Lifecycle\n");
  });

  it("names a stop that keeps the conversation and a reset that keeps the transcript — and both do", async () => {
    const text = skill();
    expect(text).toContain("ryoko api POST /api/sessions/<id>/stop");
    expect(text).toContain("ryoko api POST /api/sessions/<id>/reset");

    const key = `web:self-heal-${Date.now()}`;
    const session = createSession({ engine: "claude", source: "web", sourceRef: key, connector: "web", sessionKey: key, prompt: "Please continue" });
    insertMessage(session.id, "user", "Please continue");
    updateSession(session.id, { status: "error", lastError: "stuck", engineSessionId: "engine-conversation-1" });

    expect((await call("POST", `/api/sessions/${session.id}/stop`)).status).toBe(200);
    expect(getSession(session.id)).toMatchObject({ status: "idle", lastError: null, engineSessionId: "engine-conversation-1" });

    expect((await call("POST", `/api/sessions/${session.id}/reset`)).status).toBe(200);
    expect(getSession(session.id)).toMatchObject({ status: "idle", engineSessionId: null });
    expect(getMessages(session.id).map((message) => message.content)).toEqual(["Please continue"]);
  });
});

describe("skills/self-heal — what it reads from the gateway", () => {
  it("names sections of /api/status that the route really answers with", async () => {
    const { status, body } = await call("GET", "/api/status");
    const text = skill();

    expect(status).toBe(200);
    expect(Object.keys(body.process)).toEqual(expect.arrayContaining(["unhandledRejections", "uncaughtExceptions"]));
    expect(body.backup).toHaveProperty("level");
    expect(body.backup).toHaveProperty("targets");
    expect(body.storage).toHaveProperty("level");
    expect(body.engines.claude.health).toHaveProperty("state");
    for (const named of ["`process`", "`unhandledRejections`", "`uncaughtExceptions`", "`backup`", "`targets`", "`engines.<name>.health`", "`storage`", "`connectors`"]) {
      expect(text, named).toContain(named);
    }
  });

  it("checks the config keys the gateway reads, with the port the default config ships", () => {
    const shipped = yaml.load(read("config.default.yaml")) as { gateway: { port: number }; engines: { default: string } };
    const text = skill();

    expect(text).toContain(`\`gateway.port\` is a number (${shipped.gateway.port} unless it was changed)`);
    expect(text).toContain("`engines.default`");
    expect(shipped.engines.default).toBeTruthy();
  });
});

describe("skills/self-heal — tmp/ is working state", () => {
  it("tells the agent to leave tmp/ alone, naming what the gateway keeps there", () => {
    const text = skill();
    const attachments = `${path.relative(JINN_HOME, ATTACHMENTS_DIR).split(path.sep).join("/")}/`;

    expect(text).toMatch(/Do not delete the contents of `tmp\/`/);
    expect(attachments).toBe("tmp/attachments/");
    expect(text).toContain(`\`${attachments}\``);
    expect(text).toContain("`tmp/engine-health.json`");
    expect(source("shared/engine-health.ts")).toMatch(/path\.join\(JINN_HOME, "tmp", "engine-health\.json"\)/);
  });

  it("gives the age at which leftover attachments are swept as the gateway has it", () => {
    expect(skill()).toContain(`leftovers older than ${STALE_ATTACHMENTS_AFTER_MS / 3_600_000} hours`);
  });
});
