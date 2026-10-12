import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { DiscordConnector } from "../../connectors/discord/index.js";
import { SessionManager } from "../manager.js";
import { deliverToOriginConnector } from "../origin-delivery.js";
import { createSession, getMessages, getSession } from "../registry.js";
import { logger } from "../../shared/logger.js";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// origin-delivery retries a rejected send and reports "failed" so its callers
// can persist that the conversation was left without an answer. That only ever
// worked for Slack: the Discord connector swallowed its failures and resolved,
// so a lost reply was reported as "delivered".
//
// The real DiscordConnector is used here; only its client is replaced.

function discordChannel(id = "C1") {
  return {
    id,
    type: ChannelType.GuildText,
    isThread: () => false,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: "S1" })),
  };
}

function discordWith(channels: Record<string, unknown>): Connector {
  const connector = new DiscordConnector({ botToken: "test-token" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = {
    user: { id: "BOT" },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id in channels) return channels[id];
        throw new Error("Unknown Channel");
      }),
    },
  };
  return connector as unknown as Connector;
}

let nextKey = 0;

function discordSession() {
  const key = `discord:origin-delivery-${++nextKey}`;
  return createSession({
    engine: "claude",
    source: "discord",
    sourceRef: key,
    connector: "discord",
    sessionKey: key,
    replyContext: { channel: "C1", thread: null, messageTs: "M0" },
    transportMeta: { channelExternal: true },
    prompt: "資料を作って",
  });
}

const TWO_CHUNKS = "a".repeat(1900) + "\n" + "b".repeat(500);

describe("origin delivery through the Discord connector", () => {
  beforeEach(() => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries and reports \"failed\" when Discord refuses the reply", async () => {
    const channel = discordChannel();
    channel.send.mockRejectedValue(new Error("Missing Permissions"));
    const connectors = new Map([["discord", discordWith({ C1: channel })]]);

    await expect(deliverToOriginConnector(discordSession(), "完成しました", connectors, [1, 1])).resolves.toBe("failed");

    expect(channel.send).toHaveBeenCalledTimes(3);
  });

  it("reports \"failed\" when the channel no longer exists", async () => {
    const connectors = new Map([["discord", discordWith({})]]);

    await expect(deliverToOriginConnector(discordSession(), "完成しました", connectors, [1])).resolves.toBe("failed");
  });

  it("reports a partly delivered reply as failed, without sending it again", async () => {
    const channel = discordChannel();
    channel.send.mockResolvedValueOnce({ id: "S1" }).mockRejectedValue(new Error("rate limited"));
    const connectors = new Map([["discord", discordWith({ C1: channel })]]);

    // Not "delivered": the conversation is missing the rest of the reply.
    await expect(deliverToOriginConnector(discordSession(), TWO_CHUNKS, connectors, [1, 1])).resolves.toBe("failed");

    // Both chunks were attempted exactly once: no retry repeated the first.
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  const CONFIG = {
    gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
    connectors: {},
    sessions: {},
    logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;

  async function deliverBackgroundReply(channel: ReturnType<typeof discordChannel>, text: string) {
    const manager = new SessionManager(CONFIG, new Map<string, Engine>(), ["discord"]);
    manager.setConnectorProvider(() => new Map([["discord", discordWith({ C1: channel })]]));
    const session = discordSession();

    vi.useFakeTimers();
    const handled = manager.handleOrphanHook(session.id, { hook_event_name: "Stop", last_assistant_message: text });
    await vi.advanceTimersByTimeAsync(10_000);
    await handled;
    return {
      lastError: getSession(session.id)?.lastError,
      notes: getMessages(session.id).filter((m) => m.role === "notification").map((m) => m.content),
    };
  }

  it("persists an undelivered background reply on the session", async () => {
    const channel = discordChannel();
    channel.send.mockRejectedValue(new Error("Missing Permissions"));

    const recorded = await deliverBackgroundReply(channel, "遅れましたが完成しました");

    expect(recorded.lastError).toContain("origin delivery failed");
    expect(recorded.notes.some((note) => note.includes("NOT delivered to the original conversation"))).toBe(true);
  });

  it("persists a partly delivered background reply too, and warns against reposting what landed", async () => {
    const channel = discordChannel();
    channel.send.mockResolvedValueOnce({ id: "S1" }).mockRejectedValue(new Error("rate limited"));

    const recorded = await deliverBackgroundReply(channel, TWO_CHUNKS);

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(recorded.lastError).toContain("origin delivery failed");
    expect(recorded.notes).toHaveLength(1);
    expect(recorded.notes[0]).toContain("NOT delivered to the original conversation");
    expect(recorded.notes[0]).toContain("only the beginning");
  });
});
