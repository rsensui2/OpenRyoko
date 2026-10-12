import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiscordConnector } from "../../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../../connectors/discord/remote.js";
import { TelegramConnector } from "../../connectors/telegram/index.js";
import { WhatsAppConnector } from "../../connectors/whatsapp/index.js";
import type { ConnectorInstance } from "../../shared/types.js";
import { connectorConfig } from "../connector-config.js";

/* A connector's settings are whatever config.yaml says about it: the block
 * under its key, or its entry in `connectors.instances`. The gateway makes
 * connectors in three places — at the top level, for each instance at boot,
 * and again for each instance when the config is reloaded — and each place
 * handed the settings over in its own way. The top-level Slack connector got a
 * hand-written list of keys, so a key nobody added to the list was silently
 * ignored there: `respondTo` never took effect, `maxAttachmentMb` neither, yet
 * both worked for an instance. An instance, for its part, never got its
 * `employee`. Every place now goes through connectorConfig(). */

const SLACK = {
  appToken: "xapp-1",
  botToken: "xoxb-1",
  employee: "aiko",
  allowFrom: ["U1"],
  ignoreOldMessagesOnBoot: false,
  maxAttachmentMb: 500,
  respondTo: { im: "always", channel: "mention", engagedThreads: false },
  triage: { enabled: true, persona: "quiet" },
  goalExtraction: { enabled: true },
  agentsCanvas: { enabled: true, channelId: "C1" },
  providerAuth: { enabled: true },
  somethingAddedNextYear: { on: true },
};

describe("connectorConfig", () => {
  it("hands a top-level connector everything written under its key", () => {
    expect(connectorConfig(SLACK)).toEqual(SLACK);
  });

  it("hands an instance everything written for it, its id and employee included", () => {
    const instance: ConnectorInstance = { id: "slack-sales", type: "slack", ...SLACK };
    expect(connectorConfig(instance)).toEqual({ id: "slack-sales", ...SLACK });
  });

  it("leaves out only `type`, which says which connector to make and nothing about how", () => {
    expect(Object.keys(connectorConfig({ id: "x", type: "telegram", botToken: "t" }))).toEqual(["id", "botToken"]);
  });

  it("gives the same settings wherever they are written", () => {
    const { id: _id, ...fromInstance } = connectorConfig({ id: "slack-sales", type: "slack", ...SLACK } as ConnectorInstance);
    expect(fromInstance).toEqual(connectorConfig(SLACK));
  });

  it("hands out a copy: a connector that tidies its settings does not edit the gateway's config", () => {
    const block = { botToken: "t", guildId: 123456789 };
    const config = connectorConfig(block);
    expect(config).not.toBe(block);
    new DiscordConnector(config as never); // normalises guildId to a string, in what it was given
    expect(block.guildId).toBe(123456789);
  });
});

describe("what reaches a connector, from either place its settings can be written", () => {
  const written = <T extends object>(settings: T) => [
    ["at the top level", connectorConfig(settings)],
    ["for an instance", connectorConfig({ id: "named", type: "x", ...settings } as unknown as ConnectorInstance)],
  ] as const;

  it.each(written({ botToken: "t", employee: "aiko", maxAttachmentMb: 500, respondTo: { channel: "mention" } }))(
    "Discord, written %s: the employee it is bound to, and its own settings",
    (_where, config) => {
      const connector = new DiscordConnector(config as never);
      expect(connector.getEmployee()).toBe("aiko"); // what GET /api/connectors reports
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((connector as any).config).toMatchObject({ maxAttachmentMb: 500, respondTo: { channel: "mention" } });
    },
  );

  it.each(written({ proxyVia: "http://primary.test", proxyViaToken: "tok", respondTo: { channel: "never" } }))(
    "Discord in remote mode, written %s: its respondTo gate",
    (_where, config) => {
      const connector = new RemoteDiscordConnector(config as never);
      connector.onMessage(() => {});
      expect(connector.willDeliver({ isDM: false, wasBotAddressed: true, isEngagedThread: false })).toBe(false);
      expect(connector.willDeliver({ isDM: true, wasBotAddressed: false, isEngagedThread: false })).toBe(true);
    },
  );

  it.each(written({ botToken: "123:abc", allowFrom: [42], ignoreOldMessagesOnBoot: false }))(
    "Telegram, written %s: who may talk to it",
    (_where, config) => {
      const connector = new TelegramConnector(config as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect([...(connector as any).allowedUsers]).toEqual([42]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((connector as any).ignoreOldMessagesOnBoot).toBe(false);
    },
  );
});

describe("what reaches a WhatsApp connector", () => {
  it.each([
    ["at the top level", connectorConfig({ maxAttachmentMb: 500, allowFrom: ["447700900000@s.whatsapp.net"] })],
    ["for an instance", connectorConfig({ id: "wa-main", type: "whatsapp", maxAttachmentMb: 500, allowFrom: ["447700900000@s.whatsapp.net"] })],
  ])("written %s: its attachment limit and who may talk to it", (_where, config) => {
    const connector = new WhatsAppConnector(config as never); // creates its credentials directory, inside the test home
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((connector as any).config.maxAttachmentMb).toBe(500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect([...(connector as any).allowedJids]).toEqual(["447700900000@s.whatsapp.net"]);
  });
});

describe("gateway/server.ts makes every connector from connectorConfig()", () => {
  /* startGateway is not booted by any test, so the wiring is pinned in the
   * source: each place a connector is made, of each kind, takes its settings
   * from connectorConfig() — the block for a top-level connector, the whole
   * entry for an instance — and no place lists keys by hand any more. */
  const server = fs.readFileSync(path.join(import.meta.dirname, "..", "server.ts"), "utf-8");
  /**
   * Where each `new <Class>(` gets its first argument: the argument itself, or —
   * when that is a name — the nearest `const <name> = …` above the call.
   */
  const settingsOf = (className: string) =>
    [...server.matchAll(new RegExp(`\\bnew ${className}\\(\\s*([^,)\\n]*)`, "g"))].map((match) => {
      const argument = match[1].trim();
      if (!/^\w+$/.test(argument)) return argument;
      const declared = server.lastIndexOf(`const ${argument} = `, match.index);
      return declared === -1 ? argument : server.slice(declared, server.indexOf("\n", declared));
    });

  it.each([
    ["SlackConnector", 3],
    ["DiscordConnector", 3],
    ["RemoteDiscordConnector", 1],
    ["TelegramConnector", 3],
    ["WhatsAppConnector", 3],
  ])("%s: all %i places", (className, places) => {
    const made = settingsOf(className);
    expect(made).toHaveLength(places);
    for (const source of made) expect(source, `a ${className} is made from \`${source}\`, not from connectorConfig()`).toContain("connectorConfig(");
  });

  it("takes a top-level connector's settings from its whole block, and an instance's from its whole entry", () => {
    const sources = [...server.matchAll(/connectorConfig\(([^)]*)\)/g)].map((match) => match[1]);
    expect(sources.filter((source) => source === "instance")).toHaveLength(8); // four kinds, at boot and on reload
    expect(sources.filter((source) => source !== "instance").sort()).toEqual([
      "cfg.connectors.discord",
      "cfg.connectors.discord",
      "cfg.connectors.slack",
      "cfg.connectors.telegram",
      "cfg.connectors.whatsapp",
    ]);
  });

  it("no longer lists a connector's keys by hand", () => {
    expect(server).not.toMatch(/:\s*cfg\.connectors\.(slack|discord|telegram|whatsapp)\.\w+,/);
    expect(server).not.toContain("...typeConfig");
  });
});
