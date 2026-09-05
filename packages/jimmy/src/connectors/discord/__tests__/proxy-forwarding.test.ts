import { describe, it, expect, vi, afterEach } from "vitest";
import { MessageType } from "discord.js";
import { DiscordConnector } from "../index.js";

const BOT = "999000999";

function fakeChannel(input: { id: string; isThread?: boolean; isDM?: boolean } ) {
  return {
    id: input.id,
    name: "general",
    isThread: () => input.isThread ?? false,
    isDMBased: () => input.isDM ?? false,
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: "S1" }),
  };
}

function fakeIncoming(input: { channelId: string; isThread?: boolean }) {
  return {
    id: "M1",
    type: MessageType.Default,
    content: "hello",
    author: { id: "U1", username: "user", bot: false },
    system: false,
    webhookId: undefined,
    createdTimestamp: Date.now() + 60_000,
    guild: { id: "G1" },
    channel: {
      id: input.channelId,
      name: "general",
      isDMBased: () => false,
      isThread: () => input.isThread ?? false,
      isTextBased: () => true,
    },
    mentions: { users: new Map(), repliedUser: null },
    reference: undefined,
    fetchReference: vi.fn().mockRejectedValue(new Error("no reference")),
    attachments: new Map(),
  };
}

function connectorWith(
  config: ConstructorParameters<typeof DiscordConnector>[0],
  channel: ReturnType<typeof fakeChannel>,
): DiscordConnector {
  const connector = new DiscordConnector({ botToken: "test-token", ...config });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = {
    user: { id: BOT },
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
  };
  return connector;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tracker = (connector: DiscordConnector) => (connector as any).engagedThreads;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engagement recording guards", () => {
  it("records nothing when no consumer exists (no mention scope, no routing)", async () => {
    const connector = connectorWith({}, fakeChannel({ id: "T9", isThread: true }));
    await connector.replyMessage({ channel: "C1", thread: "T9" }, "hi");
    expect(tracker(connector).has("T9")).toBe(false);
  });

  it("records the thread — not the chunk id — for thread sends", async () => {
    const connector = connectorWith(
      { respondTo: { channel: "mention" } },
      fakeChannel({ id: "T9", isThread: true }),
    );
    await connector.replyMessage({ channel: "C1", thread: "T9" }, "hi");
    expect(tracker(connector).has("T9")).toBe(true);
    expect(tracker(connector).has("S1")).toBe(false);
  });

  it("records the sent message id for flat guild channel sends (future thread root)", async () => {
    const connector = connectorWith(
      { respondTo: { channel: "mention" } },
      fakeChannel({ id: "C1" }),
    );
    await connector.sendMessage({ channel: "C1" }, "hi");
    expect(tracker(connector).has("S1")).toBe(true);
  });

  it("records nothing for DM sends", async () => {
    const connector = connectorWith(
      { respondTo: { channel: "mention" } },
      fakeChannel({ id: "D1", isDM: true }),
    );
    await connector.sendMessage({ channel: "D1" }, "hi");
    expect(tracker(connector).has("S1")).toBe(false);
    expect(tracker(connector).has("D1")).toBe(false);
  });

  it("records nothing under dm=mention alone — DMs have no threads to consume it", async () => {
    const connector = connectorWith(
      { respondTo: { dm: "mention" } },
      fakeChannel({ id: "C1" }),
    );
    await connector.sendMessage({ channel: "C1" }, "hi");
    expect(tracker(connector).has("S1")).toBe(false);
  });

  it("records for channelRouting only when the id itself is a routing key", async () => {
    const unrouted = connectorWith(
      { channelRouting: { OTHER: "http://remote.test" } },
      fakeChannel({ id: "T9", isThread: true }),
    );
    await unrouted.replyMessage({ channel: "C1", thread: "T9" }, "hi");
    expect(tracker(unrouted).has("T9")).toBe(false);

    const routed = connectorWith(
      { channelRouting: { T9: "http://remote.test" } },
      fakeChannel({ id: "T9", isThread: true }),
    );
    await routed.replyMessage({ channel: "C1", thread: "T9" }, "hi");
    expect(tracker(routed).has("T9")).toBe(true);
  });
});

describe("routing forwards addressing and engagement to the remote", () => {
  function stubProxyFetch() {
    const calls: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
        calls.push(JSON.parse(init?.body ?? "{}"));
        headers.push(init?.headers ?? {});
        return { ok: true, status: 200, statusText: "OK" };
      }),
    );
    return { calls, headers };
  }

  it("forwards isEngagedThread=true after the bot replied in the routed thread", async () => {
    const connector = connectorWith(
      { channelRouting: { T9: "http://remote.test" } },
      fakeChannel({ id: "T9", isThread: true }),
    );
    await connector.replyMessage({ channel: "C1", thread: "T9" }, "hi");

    const { calls } = stubProxyFetch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(fakeIncoming({ channelId: "T9", isThread: true }));
    expect(calls).toHaveLength(1);
    const meta = calls[0].transportMeta as Record<string, unknown>;
    expect(meta.isEngagedThread).toBe(true);
    expect(meta.wasBotAddressed).toBe(false);
    expect(meta.addressesOnlyOthers).toBe(false);
    expect(meta.isDM).toBe(false);
  });

  it("forwards isEngagedThread=false for a thread the bot never engaged", async () => {
    const connector = connectorWith(
      { channelRouting: { T9: "http://remote.test" } },
      fakeChannel({ id: "T9", isThread: true }),
    );
    const { calls } = stubProxyFetch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(fakeIncoming({ channelId: "T9", isThread: true }));
    expect(calls).toHaveLength(1);
    expect((calls[0].transportMeta as Record<string, unknown>).isEngagedThread).toBe(false);
  });

  it("authenticates routed delivery with the route's bearer token and forwards speaker identity", async () => {
    const connector = connectorWith(
      { channelRouting: { C1: { url: "http://remote.test", token: "route-secret" } } },
      fakeChannel({ id: "C1" }),
    );
    const { calls, headers } = stubProxyFetch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(fakeIncoming({ channelId: "C1" }));
    expect(headers[0].Authorization).toBe("Bearer route-secret");
    const meta = calls[0].transportMeta as Record<string, unknown>;
    expect(meta.speakerDiscordId).toBe("U1");
    expect(meta.isGroupDM).toBe(false);
  });

  it("sends no Authorization header for a plain-URL route (auth-disabled remote)", async () => {
    const connector = connectorWith(
      { channelRouting: { C1: "http://remote.test" } },
      fakeChannel({ id: "C1" }),
    );
    const { headers } = stubProxyFetch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(fakeIncoming({ channelId: "C1" }));
    expect(headers[0].Authorization).toBeUndefined();
  });
});
