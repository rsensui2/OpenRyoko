import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../index.js";
import { ConversationTracker } from "../conversation-tracker.js";
import { logger } from "../../../shared/logger.js";
import type { SlackRespondToConfig } from "../../../shared/types.js";

// start() asks Slack who the bot is exactly once. When that call fails — Slack
// answers ok:false at the moment the gateway boots or reloads, or cannot be
// reached — the connector kept running without its own user ID. A channel
// scope set to "mention" then never saw a mention, so every mention there was
// ignored until the next restart. Before the process safety net existed, the
// same outage crashed the gateway and the restart fixed it.

const BOT = "URYOKO";

type Listener = (args: { event: Record<string, unknown>; context?: Record<string, unknown> }) => Promise<void>;

async function startedConnector(options: { authTest: () => Promise<unknown>; respondTo?: SlackRespondToConfig }) {
  let onMessage!: Listener;
  let onReaction!: Listener;
  const handler = vi.fn();
  const reactedMessage = vi.fn().mockResolvedValue({ message: { ts: "3.000", user: "U1", text: "資料です。" } });
  const connector = Object.create(SlackConnector.prototype) as SlackConnector;
  Object.assign(connector as unknown as Record<string, unknown>, {
    app: {
      message: (listener: Listener) => { onMessage = listener; },
      event: (_name: string, listener: Listener) => { onReaction = listener; },
      start: vi.fn(),
      client: {
        auth: { test: vi.fn(options.authTest) },
        conversations: {
          replies: vi.fn().mockResolvedValue({ messages: [] }),
          history: vi.fn().mockResolvedValue({ messages: [] }),
          info: vi.fn().mockResolvedValue({ channel: { name: "general" } }),
        },
        users: { info: vi.fn().mockResolvedValue({ user: { name: "Taro" } }) },
        reactions: { add: vi.fn().mockResolvedValue({ ok: true }), get: reactedMessage },
        chat: { postMessage: vi.fn().mockResolvedValue({ ts: "9.000" }) },
      },
    },
    conversations: new ConversationTracker({}),
    triageConfig: undefined,
    respondTo: options.respondTo,
    botUserId: null,
    handler,
    allowedUsers: null,
    ignoreOldMessagesOnBoot: false,
    userInfoCache: new Map(),
    channelNameCache: new Map(),
    agentsCanvas: null,
  });
  await connector.start();

  let ts = 10;
  const message = (text: string, context?: Record<string, unknown>) =>
    onMessage({ event: { channel: "C1", user: "U1", ts: `${++ts}.000`, channel_type: "channel", text }, context });
  const reaction = (user: string, context?: Record<string, unknown>) =>
    onReaction({
      event: { item: { type: "message", channel: "C1", ts: "3.000" }, user, reaction: "thumbsup", event_ts: `${++ts}.000` },
      context,
    });
  return { handler, reactedMessage, message, reaction };
}

const lookupFails = async () => { throw new Error("An API error occurred: internal_error"); };
const lookupSucceeds = async () => ({ ok: true, user_id: BOT });

describe("SlackConnector — bot user ID after a failed start-up lookup", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a mention in a mention-only channel from the first event on", async () => {
    const slack = await startedConnector({ authTest: lookupFails, respondTo: { channel: "mention" } });

    // A listener only runs once Bolt has authorized the event, so the event's
    // context already carries the bot's user ID.
    await slack.message(`<@${BOT}> 進捗を教えて`, { botUserId: BOT });

    expect(slack.handler).toHaveBeenCalledTimes(1);
    expect(slack.handler.mock.calls[0][0].transportMeta).toMatchObject({ wasMentioned: true });
  });

  it("keeps the ID for later events, and still ignores messages that do not mention it", async () => {
    const slack = await startedConnector({ authTest: lookupFails, respondTo: { channel: "mention" } });

    await slack.message("誰か見ていますか", { botUserId: BOT });
    await slack.message(`<@${BOT}> お願いします`);

    expect(slack.handler).toHaveBeenCalledTimes(1);
    expect(slack.handler.mock.calls[0][0].text).toContain("お願いします");
  });

  it("recovers through a reaction event as well", async () => {
    const slack = await startedConnector({ authTest: lookupFails });

    // The bot's own reaction must be skipped, which needs its user ID.
    await slack.reaction(BOT, { botUserId: BOT });

    expect(slack.reactedMessage).not.toHaveBeenCalled();
    expect(slack.handler).not.toHaveBeenCalled();
  });

  it("does not replace the ID that start() resolved", async () => {
    const slack = await startedConnector({ authTest: lookupSucceeds, respondTo: { channel: "mention" } });

    await slack.message(`<@${BOT}> 進捗を教えて`, { botUserId: "USOMEONEELSE" });

    expect(slack.handler).toHaveBeenCalledTimes(1);
  });

  it("works as before for an event that carries no context", async () => {
    const slack = await startedConnector({ authTest: lookupSucceeds, respondTo: { channel: "mention" } });

    await slack.message(`<@${BOT}> 進捗を教えて`);

    expect(slack.handler).toHaveBeenCalledTimes(1);
  });
});
