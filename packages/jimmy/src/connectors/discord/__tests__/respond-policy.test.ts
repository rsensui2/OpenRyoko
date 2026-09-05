import { describe, it, expect } from "vitest";
import {
  scopeForChannel,
  resolveRespondMode,
  evaluateRespondPolicy,
  hasMentionScope,
  respondPolicyNeedsTracking,
  wasBotAddressed,
  addressesOnlyOthers,
} from "../respond-policy.js";
import type { DiscordRespondToConfig } from "../../../shared/types.js";

const BOT = "999000999";

describe("scopeForChannel", () => {
  it("maps DMs (1:1 and group) to dm", () => {
    expect(scopeForChannel(true)).toBe("dm");
  });

  it("maps guild channels and threads to channel", () => {
    expect(scopeForChannel(false)).toBe("channel");
  });
});

describe("resolveRespondMode", () => {
  it("defaults every scope to always when config is absent", () => {
    expect(resolveRespondMode(undefined, "dm")).toBe("always");
    expect(resolveRespondMode(undefined, "channel")).toBe("always");
  });

  it("defaults unset scopes to always when config is partial", () => {
    const config: DiscordRespondToConfig = { channel: "mention" };
    expect(resolveRespondMode(config, "dm")).toBe("always");
    expect(resolveRespondMode(config, "channel")).toBe("mention");
  });

  it("treats invalid values as always (config files are untyped YAML)", () => {
    const config = { channel: "sometimes" } as unknown as DiscordRespondToConfig;
    expect(resolveRespondMode(config, "channel")).toBe("always");
  });
});

describe("hasMentionScope", () => {
  it("is false without config or without mention scopes", () => {
    expect(hasMentionScope(undefined)).toBe(false);
    expect(hasMentionScope({ dm: "always", channel: "never" })).toBe(false);
  });

  it("is true when any scope is mention", () => {
    expect(hasMentionScope({ channel: "mention" })).toBe(true);
    expect(hasMentionScope({ dm: "mention" })).toBe(true);
  });
});

describe("respondPolicyNeedsTracking", () => {
  it("needs tracking only for mention scopes with engagedThreads on", () => {
    expect(respondPolicyNeedsTracking(undefined)).toBe(false);
    expect(respondPolicyNeedsTracking({ channel: "always" })).toBe(false);
    expect(respondPolicyNeedsTracking({ channel: "mention" })).toBe(true);
    expect(respondPolicyNeedsTracking({ channel: "mention", engagedThreads: false })).toBe(false);
  });
});

describe("evaluateRespondPolicy", () => {
  const mentionOnly: DiscordRespondToConfig = { dm: "always", channel: "mention" };

  it("allows everything when config is absent (legacy behavior)", () => {
    expect(
      evaluateRespondPolicy({
        config: undefined,
        isDM: false,
        wasMentioned: false,
        isEngagedThread: false,
      }),
    ).toEqual({ allow: true });
  });

  it("allows DMs without a mention under dm=always", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        isDM: true,
        wasMentioned: false,
        isEngagedThread: false,
      }),
    ).toEqual({ allow: true });
  });

  it("drops un-mentioned channel messages under channel=mention", () => {
    const decision = evaluateRespondPolicy({
      config: mentionOnly,
      isDM: false,
      wasMentioned: false,
      isEngagedThread: false,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("respondTo.channel=mention");
  });

  it("allows mentioned channel messages under channel=mention", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        isDM: false,
        wasMentioned: true,
        isEngagedThread: false,
      }),
    ).toEqual({ allow: true });
  });

  it("allows un-mentioned messages in engaged threads by default", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        isDM: false,
        wasMentioned: false,
        isEngagedThread: true,
      }),
    ).toEqual({ allow: true });
  });

  it("drops un-mentioned engaged-thread messages when engagedThreads=false", () => {
    const decision = evaluateRespondPolicy({
      config: { ...mentionOnly, engagedThreads: false },
      isDM: false,
      wasMentioned: false,
      isEngagedThread: true,
    });
    expect(decision.allow).toBe(false);
  });

  it("drops everything, mentions included, under never", () => {
    const decision = evaluateRespondPolicy({
      config: { dm: "never", channel: "never" },
      isDM: true,
      wasMentioned: true,
      isEngagedThread: false,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("respondTo.dm=never");
  });
});

describe("wasBotAddressed", () => {
  it("is true for a direct @-mention of the bot", () => {
    expect(
      wasBotAddressed({
        botUserId: BOT,
        mentionedUserIds: new Set([BOT, "12345"]),
        repliedToUserId: undefined,
      }),
    ).toBe(true);
  });

  it("is true for a reply to one of the bot's messages (ping on or off)", () => {
    expect(
      wasBotAddressed({
        botUserId: BOT,
        mentionedUserIds: new Set(),
        repliedToUserId: BOT,
      }),
    ).toBe(true);
  });

  it("is false without a mention or reply-to-bot", () => {
    expect(
      wasBotAddressed({
        botUserId: BOT,
        mentionedUserIds: new Set(["12345"]),
        repliedToUserId: "12345",
      }),
    ).toBe(false);
  });

  it("fails closed when the bot user id is unresolved", () => {
    expect(
      wasBotAddressed({
        botUserId: undefined,
        mentionedUserIds: new Set([BOT]),
        repliedToUserId: BOT,
      }),
    ).toBe(false);
  });
});

describe("addressesOnlyOthers", () => {
  it("is true when the message @-mentions only other users", () => {
    expect(
      addressesOnlyOthers({
        botUserId: BOT,
        mentionedUserIds: new Set(["12345"]),
        repliedToUserId: undefined,
      }),
    ).toBe(true);
  });

  it("is true when the message replies to another user's message", () => {
    expect(
      addressesOnlyOthers({
        botUserId: BOT,
        mentionedUserIds: new Set(),
        repliedToUserId: "12345",
      }),
    ).toBe(true);
  });

  it("is false when the bot is among the mentioned users", () => {
    expect(
      addressesOnlyOthers({
        botUserId: BOT,
        mentionedUserIds: new Set([BOT, "12345"]),
        repliedToUserId: undefined,
      }),
    ).toBe(false);
  });

  it("is false with no explicit addressees (@everyone/@here carry none)", () => {
    expect(
      addressesOnlyOthers({
        botUserId: BOT,
        mentionedUserIds: new Set(),
        repliedToUserId: undefined,
      }),
    ).toBe(false);
  });

  it("is false when the bot user id is unresolved (never drop on unknown identity)", () => {
    expect(
      addressesOnlyOthers({
        botUserId: undefined,
        mentionedUserIds: new Set(["12345"]),
        repliedToUserId: undefined,
      }),
    ).toBe(false);
  });
});
