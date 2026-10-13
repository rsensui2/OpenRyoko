import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { ChannelType } from "discord.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { DiscordConnector } from "../../connectors/discord/index.js";
import { logger } from "../../shared/logger.js";
import type { Connector, JinnConfig } from "../../shared/types.js";

// Scripts, cron jobs and the send_message MCP tool treat this route's answer
// as the delivery receipt. It answered { status: "sent" } whatever happened,
// because the Discord connector swallowed its own send failures.
//
// The real DiscordConnector is used (only its client is replaced), so the
// route and the connector contract are pinned together.

function discordChannel(id: string, isThread = false) {
  return {
    id,
    type: isThread ? ChannelType.PublicThread : ChannelType.GuildText,
    parentId: isThread ? "C1" : null,
    isThread: () => isThread,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: "S1" })),
  };
}

function discordWith(channels: Record<string, unknown>): DiscordConnector {
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
  return connector;
}

describe("POST /api/connectors/:name/send", () => {
  let server: http.Server;
  let baseUrl: string;
  const connectors = new Map<string, Connector>();

  beforeAll(async () => {
    const config = { gateway: { port: 0, host: "127.0.0.1" } } as JinnConfig;
    const context = {
      config,
      getConfig: () => config,
      sessionManager: {} as never,
      startTime: 0,
      emit: () => {},
      connectors,
    } as unknown as ApiContext;
    server = http.createServer((req, res) => {
      void handleApiRequest(req, res, context);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    connectors.clear();
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function send(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/connectors/discord/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("still answers { status: \"sent\" } when Discord took the message", async () => {
    const channel = discordChannel("C1");
    connectors.set("discord", discordWith({ C1: channel }));

    await expect(send({ channel: "C1", text: "Ready for review" })).resolves.toEqual({
      status: 200,
      body: { status: "sent" },
    });
    expect(channel.send).toHaveBeenCalledWith("Ready for review");
  });

  it("answers an error carrying the reason when Discord refuses the message", async () => {
    const channel = discordChannel("C1");
    channel.send.mockRejectedValue(new Error("Missing Permissions"));
    connectors.set("discord", discordWith({ C1: channel }));

    const failed = await send({ channel: "C1", text: "Ready for review" });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Missing Permissions" });
  });

  it("answers an error when the channel does not exist", async () => {
    connectors.set("discord", discordWith({}));

    const failed = await send({ channel: "C404", text: "Ready for review" });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Unknown Channel" });
  });

  it("answers an error for a thread reply that was not delivered", async () => {
    const thread = discordChannel("T1", true);
    thread.send.mockRejectedValue(new Error("Thread is locked"));
    connectors.set("discord", discordWith({ T1: thread }));

    const failed = await send({ channel: "C1", thread: "T1", text: "Ready for review" });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Thread is locked" });
  });

  it("answers an error, not \"sent\", when only part of the message was delivered", async () => {
    const channel = discordChannel("C1");
    channel.send.mockResolvedValueOnce({ id: "S1" }).mockRejectedValue(new Error("rate limited"));
    connectors.set("discord", discordWith({ C1: channel }));

    const failed = await send({ channel: "C1", text: "a".repeat(1900) + "\n" + "b".repeat(500) });

    expect(failed.status).toBe(500);
    // The caller is told that part of it is already there, so it does not
    // simply send the whole message again.
    expect(failed.body).toEqual({ error: "Discord sendMessage: only 1 of 2 chunks were delivered (rate limited)" });
  });
});
