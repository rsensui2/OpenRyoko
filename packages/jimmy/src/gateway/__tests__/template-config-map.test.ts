import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHIVE_RETENTION, DEFAULT_MAX_ARCHIVE_MB, DEFAULT_MAX_ENTRIES, resolveBackupSettings } from "../../backup/settings.js";
import { alertThrottleMinutes } from "../../cron/alert-throttle.js";
import { DEFAULT_MAX_ATTACHMENT_MB } from "../../shared/attachment-download.js";
import { JINN_HOME, TEMPLATE_DIR } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { CONFIG_CONFLICT_BODY, CONFIG_REVISION_HEADER } from "../config-revision.js";

// references/platform.md is the map an agent follows when it is asked to change
// a setting: which key, what it defaults to, when it takes effect. The settings
// this release added were described in the docs and the default config and
// missing from the map, so an agent asked about backups or the attachment limit
// found no row to start from. Nothing generates the map from the code. These
// hold the rows it gained to the defaults the gateway uses.

const read = (relative: string): string => fs.readFileSync(path.join(TEMPLATE_DIR, ...relative.split("/")), "utf-8");
const map = (): string => read("skills/openryoko-config/references/platform.md");
const source = (relative: string): string => fs.readFileSync(path.join(import.meta.dirname, "..", "..", ...relative.split("/")), "utf-8");

/** The table row of the settings map that names `key`. */
function row(key: string): string {
  const found = map().split("\n").find((line) => line.startsWith("|") && line.includes(key));
  expect(found, `platform.md has no table row for ${key}`).toBeDefined();
  return found!;
}

async function status(): Promise<any> {
  const config = {
    gateway: { port: 18999 },
    engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5" }, codex: { bin: "codex", model: "gpt-5.6-sol" } },
  };
  const context = { config, getConfig: () => config, sessionManager: {}, startTime: Date.now(), connectors: new Map(), emit: () => {} } as unknown as ApiContext;
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = "GET";
  req.url = "/api/status";
  req.headers = { host: "127.0.0.1" };
  let body: unknown;
  const res = { setHeader() { return this; }, writeHead() { return this; }, end(payload?: string) { body = payload ? JSON.parse(payload) : undefined; } } as unknown as ServerResponse;
  await handleApiRequest(req, res, context);
  return body;
}

describe("the settings map — settings this release added", () => {
  it("has a row for the backup settings, with the defaults the gateway uses", () => {
    const backup = row("backup.enabled");
    const defaults = resolveBackupSettings(undefined, JINN_HOME);

    expect(backup).toContain("`backup.enabled/directory/retention/maxArchiveMb/maxEntries`");
    expect(defaults.enabled).toBe(true);
    expect(backup).toContain("既定で有効");
    expect(defaults.defaultDirectory).toBe(true);
    expect(backup).toContain("`<ホーム>/backups`");
    expect(backup).toContain(`${DEFAULT_ARCHIVE_RETENTION}日分`);
    expect(backup).toContain(`${DEFAULT_MAX_ARCHIVE_MB} MB`);
    expect(backup).toContain(`${DEFAULT_MAX_ENTRIES}件`);
    expect(backup).toContain("`docs/backup.md`");
    // The one thing about a restore an agent must not get wrong.
    expect(backup).toContain("DBの復元は自分でしない");
  });

  it("has a row for the bundled skill sync, saying what the switch does and does not turn off", () => {
    const sync = row("skills.autoSync");

    expect(sync).toContain("既定で有効");
    expect(sync).toMatch(/`ryoko migrate` は設定に関係なく同期する/);
    expect(sync).toContain("`docs/skills.md`");
  });

  it("lists the cron alert throttle with its default, and says cron settings are read at each fire", () => {
    const cron = row("cron.defaultDelivery");

    expect(cron).toContain("alertThrottleMinutes");
    expect(cron).toContain(`既定${alertThrottleMinutes(undefined)}分`);
    expect(cron).toContain("発火のたびに読む");
    // The older caveat told the agent to work out whether a restart was needed.
    expect(map()).not.toContain("cronを開始時configで保持する版では、全体のcron既定変更の反映経路も確認");
  });

  it("has a row for the attachment limit, with its default and the connectors that take it", () => {
    const attachments = row("maxAttachmentMb");

    expect(attachments).toContain("`connectors.slack/discord/whatsapp`");
    expect(attachments).toContain(`既定${DEFAULT_MAX_ATTACHMENT_MB}（MB）`);
  });
});

describe("the settings map — what /api/status and /api/config answer", () => {
  it("names the three sections /api/status gained, as the route answers with them", async () => {
    const body = await status();
    const text = map();

    expect(body.engines.claude.health).toHaveProperty("state");
    expect(body).toHaveProperty("backup.level");
    expect(Object.keys(body.process)).toEqual(expect.arrayContaining(["unhandledRejections", "uncaughtExceptions"]));
    for (const named of ["`engines.<名前>.health`", "`backup`", "`process`", "`unhandledRejections`", "`uncaughtExceptions`"]) expect(text, named).toContain(named);
    // Still true, and still worth saying: `available` proves nothing.
    expect(text).toContain("`available: true` は版によって固定値");
  });

  it("gives the header and the answer of a refused save by the names the gateway uses", () => {
    const text = map();

    expect(text).toContain(`\`${CONFIG_REVISION_HEADER}\``);
    expect(text).toContain(`409（\`${CONFIG_CONFLICT_BODY.code}\`）`);
    expect(text).toContain("部分更新には付けない");
  });

  it("gives the size a save is refused at as the route has it", () => {
    expect(source("gateway/api.ts")).toContain("const CONFIG_BODY_MAX_BYTES = 1024 * 1024;");
    expect(map()).toContain("1 MBを超える本文は413で断る");
  });

  it("no longer tells the agent that `***` must never be sent back", () => {
    const skill = read("skills/openryoko-config/SKILL.md");

    expect(skill).not.toContain("マスク値 `***` をファイルへ保存しない");
    expect(skill).toContain("`PUT` に送り返してよい");
    expect(skill).toContain("`config.yaml` を直接編集するときは `***` を書かない");
    expect(map()).toContain("`***` を送り返すと保存済みの値を保つ");
  });

  it("tells the agent not to point a host-side CLI at a home it shares with a container", () => {
    expect(map()).toMatch(/ホスト側の `ryoko` をそのホームに向けない/);
  });
});
