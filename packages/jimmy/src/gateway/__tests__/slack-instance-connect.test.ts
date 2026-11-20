import fs from "node:fs";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import { connectSlackInstance, NEW_PEER_RESPOND_TO } from "../slack-instance-connect.js";

/* A peer Ryoko's Slack connector: a new one starts mention-only in channels
 * (it usually shares them with the main Ryoko); an existing one keeps the
 * behavior the person already chose. */

const verified = async () => ({ ok: true as const, bot: { ok: true, team: "Example", user: "peer" }, app: { ok: true } });
const reloadOk = async () => ({ status: "ok" as const, connectorsReload: { started: ["slack-sales"], stopped: [], errors: [] } });

function instances(): Array<Record<string, unknown>> {
  const config = (yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) ?? {}) as { connectors?: { instances?: Array<Record<string, unknown>> } };
  return config.connectors?.instances ?? [];
}

let saved: string | null = null;
beforeEach(() => {
  saved = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : null;
  fs.writeFileSync(CONFIG_PATH, "gateway:\n  port: 7777\n");
});
afterEach(() => {
  if (saved === null) fs.rmSync(CONFIG_PATH, { force: true });
  else fs.writeFileSync(CONFIG_PATH, saved);
});

describe("connectSlackInstance", () => {
  it("starts a new peer mention-only in channels", async () => {
    const result = await connectSlackInstance({ verify: verified as never, reloadAfterWrite: reloadOk }, { id: "slack-sales", employee: "sales", botToken: "xoxb-1", appToken: "xapp-1" });
    expect(result.ok).toBe(true);
    expect(instances()).toEqual([{ id: "slack-sales", type: "slack", employee: "sales", botToken: "xoxb-1", appToken: "xapp-1", respondTo: { ...NEW_PEER_RESPOND_TO } }]);
  });

  it("keeps the behavior of a peer that was already set up", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ connectors: { instances: [{ id: "slack-sales", type: "slack", employee: "sales", botToken: "xoxb-old", appToken: "xapp-old", respondTo: { channel: "always" } }] } }));
    await connectSlackInstance({ verify: verified as never, reloadAfterWrite: reloadOk }, { id: "slack-sales", employee: "sales", botToken: "xoxb-2", appToken: "xapp-2" });
    expect(instances()[0]).toMatchObject({ botToken: "xoxb-2", appToken: "xapp-2", respondTo: { channel: "always" } });
  });
});
