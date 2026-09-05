import { describe, it, expect } from "vitest";
import {
  scopeForChannelType,
  resolveRespondMode,
  evaluateRespondPolicy,
  hasMentionScope,
  respondPolicyNeedsTracking,
  shouldHandleReaction,
} from "../respond-policy.js";
import type { SlackRespondToConfig } from "../../../shared/types.js";

describe("scopeForChannelType", () => {
  it("maps im to im", () => {
    expect(scopeForChannelType("im")).toBe("im");
  });

  it("maps mpim to mpim", () => {
    expect(scopeForChannelType("mpim")).toBe("mpim");
  });

  it("maps channel to channel", () => {
    expect(scopeForChannelType("channel")).toBe("channel");
  });

  it("maps legacy private-channel type 'group' to channel", () => {
    expect(scopeForChannelType("group")).toBe("channel");
  });

  it("maps unknown/undefined to channel (safe default)", () => {
    expect(scopeForChannelType(undefined)).toBe("channel");
    expect(scopeForChannelType("something-new")).toBe("channel");
  });
});

describe("resolveRespondMode", () => {
  it("defaults every scope to always when config is absent", () => {
    expect(resolveRespondMode(undefined, "im")).toBe("always");
    expect(resolveRespondMode(undefined, "mpim")).toBe("always");
    expect(resolveRespondMode(undefined, "channel")).toBe("always");
  });

  it("defaults unset scopes to always when config is partial", () => {
    const config: SlackRespondToConfig = { channel: "mention" };
    expect(resolveRespondMode(config, "im")).toBe("always");
    expect(resolveRespondMode(config, "mpim")).toBe("always");
    expect(resolveRespondMode(config, "channel")).toBe("mention");
  });

  it("treats invalid values as always (config files are untyped YAML)", () => {
    const config = { channel: "sometimes" } as unknown as SlackRespondToConfig;
    expect(resolveRespondMode(config, "channel")).toBe("always");
  });
});

describe("evaluateRespondPolicy", () => {
  const mentionOnly: SlackRespondToConfig = {
    im: "always",
    mpim: "mention",
    channel: "mention",
  };

  it("allows everything when config is absent (legacy behavior)", () => {
    expect(
      evaluateRespondPolicy({
        config: undefined,
        channelType: "channel",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(true);
  });

  it("allows DMs without a mention under the mention-only config", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "im",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(true);
  });

  it("drops un-mentioned channel messages", () => {
    const decision = evaluateRespondPolicy({
      config: mentionOnly,
      channelType: "channel",
      wasMentioned: false,
      isEngagedThread: false,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("channel=mention");
  });

  it("drops un-mentioned group-DM (mpim) messages", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "mpim",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(false);
  });

  it("allows @-mentioned channel messages", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "channel",
        wasMentioned: true,
        isEngagedThread: false,
      }).allow,
    ).toBe(true);
  });

  it("allows un-mentioned follow-ups inside a bot-engaged thread by default", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "channel",
        wasMentioned: false,
        isEngagedThread: true,
      }).allow,
    ).toBe(true);
  });

  it("drops engaged-thread follow-ups when engagedThreads is false", () => {
    expect(
      evaluateRespondPolicy({
        config: { ...mentionOnly, engagedThreads: false },
        channelType: "channel",
        wasMentioned: false,
        isEngagedThread: true,
      }).allow,
    ).toBe(false);
  });

  it("treats legacy private-channel type 'group' under the channel scope", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "group",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(false);
  });

  it("drops everything in a never scope, even mentions", () => {
    expect(
      evaluateRespondPolicy({
        config: { channel: "never" },
        channelType: "channel",
        wasMentioned: true,
        isEngagedThread: true,
      }).allow,
    ).toBe(false);
  });
});

describe("hasMentionScope / respondPolicyNeedsTracking", () => {
  it("is false when config is absent", () => {
    expect(hasMentionScope(undefined)).toBe(false);
    expect(respondPolicyNeedsTracking(undefined)).toBe(false);
  });

  it("is false when no scope uses mention", () => {
    expect(hasMentionScope({ im: "always", channel: "never" })).toBe(false);
  });

  it("is true when any scope uses mention", () => {
    expect(hasMentionScope({ channel: "mention" })).toBe(true);
    expect(hasMentionScope({ mpim: "mention" })).toBe(true);
  });

  it("needs tracking only when engaged-thread continuation is on", () => {
    expect(respondPolicyNeedsTracking({ channel: "mention" })).toBe(true);
    expect(respondPolicyNeedsTracking({ channel: "mention", engagedThreads: false })).toBe(false);
  });
});

describe("shouldHandleReaction", () => {
  // Reactions carry no @-mention, so a mention-gated channel scope can never
  // be satisfied on this path. Without the gate a secondary bot sharing
  // channels with the primary bot double-handles every channel reaction.

  it("handles channel reactions when the channel scope is always", () => {
    expect(shouldHandleReaction({ channel: "always" }, "C123")).toBe(true);
  });

  it("ignores channel reactions when the channel scope is mention", () => {
    expect(shouldHandleReaction({ channel: "mention" }, "C123")).toBe(false);
  });

  it("ignores channel reactions when the channel scope is never", () => {
    expect(shouldHandleReaction({ channel: "never" }, "C123")).toBe(false);
  });

  it("always handles DM reactions regardless of the channel scope", () => {
    expect(shouldHandleReaction({ channel: "mention" }, "D123")).toBe(true);
    expect(shouldHandleReaction({ channel: "never" }, "D123")).toBe(true);
  });

  it("defaults to handling when respondTo is absent or invalid (legacy behavior)", () => {
    expect(shouldHandleReaction(undefined, "C123")).toBe(true);
    expect(shouldHandleReaction({} as SlackRespondToConfig, "C123")).toBe(true);
  });

  it("gates a DM-scope setting independently of the channel scope", () => {
    // im="never" does not silence DM reactions: the reaction path is gated on
    // the channel scope only, matching the pre-existing behavior.
    expect(shouldHandleReaction({ im: "never", channel: "always" }, "D123")).toBe(true);
  });

  it("treats a group DM (G…) as channel scope, not mpim — the conservative side", () => {
    // reaction_added has no channel_type; only "D…" is distinguishable, so a
    // group DM follows the channel scope exactly like a public channel.
    expect(shouldHandleReaction({ channel: "mention" }, "G123")).toBe(false);
    expect(shouldHandleReaction({ channel: "always" }, "G123")).toBe(true);
  });
});
