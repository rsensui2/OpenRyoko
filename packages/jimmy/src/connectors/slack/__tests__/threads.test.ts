import { describe, it, expect } from "vitest";

import { deriveSessionKey, buildReplyContext, isOldSlackMessage } from "../threads.js";

describe("deriveSessionKey", () => {
  it("keys a non-threaded DM message to one long-lived session per user", () => {
    expect(
      deriveSessionKey({ channel: "D1", user: "U1", ts: "100.0", channel_type: "im" }),
    ).toBe("slack:dm:U1");
  });

  it("keys a threaded DM message to its own per-thread session", () => {
    expect(
      deriveSessionKey({
        channel: "D1",
        user: "U1",
        ts: "200.0",
        thread_ts: "100.0",
        channel_type: "im",
      }),
    ).toBe("slack:dm:U1:100.0");
  });

  it("keeps two DM threads on separate sessions", () => {
    const a = deriveSessionKey({ channel: "D1", user: "U1", ts: "201.0", thread_ts: "100.0", channel_type: "im" });
    const b = deriveSessionKey({ channel: "D1", user: "U1", ts: "301.0", thread_ts: "300.0", channel_type: "im" });
    expect(a).not.toBe(b);
  });

  it("keys a channel root message by its own ts", () => {
    expect(
      deriveSessionKey({ channel: "C1", user: "U1", ts: "100.0", channel_type: "channel" }),
    ).toBe("slack:C1:100.0");
  });

  it("keys a channel thread reply by thread_ts so it matches the root", () => {
    expect(
      deriveSessionKey({ channel: "C1", user: "U1", ts: "200.0", thread_ts: "100.0", channel_type: "channel" }),
    ).toBe("slack:C1:100.0");
  });

  // Not every event carries channel_type; one without it is a channel message.
  it("keys a root message that has no channel_type by its own ts", () => {
    expect(
      deriveSessionKey({ channel: "C123", user: "U123", ts: "1700000000.000100" }),
    ).toBe("slack:C123:1700000000.000100");
  });

  it("keys a thread reply that has no channel_type by thread_ts", () => {
    expect(
      deriveSessionKey({ channel: "C123", user: "U123", ts: "1700000100.000200", thread_ts: "1700000000.000100" }),
    ).toBe("slack:C123:1700000000.000100");
  });

  it("treats a thread_ts equal to the message's own ts as a root message", () => {
    expect(
      deriveSessionKey({ channel: "C123", user: "U123", ts: "1700000000.000100", thread_ts: "1700000000.000100" }),
    ).toBe("slack:C123:1700000000.000100");
  });
});

describe("buildReplyContext", () => {
  it("replies on the main timeline for a non-threaded DM", () => {
    const ctx = buildReplyContext({ channel: "D1", user: "U1", ts: "100.0", channel_type: "im" });
    expect(ctx).toMatchObject({ channel: "D1", thread: null, messageTs: "100.0" });
  });

  it("replies inside the thread for a threaded DM", () => {
    const ctx = buildReplyContext({
      channel: "D1",
      user: "U1",
      ts: "200.0",
      thread_ts: "100.0",
      channel_type: "im",
    });
    expect(ctx).toMatchObject({ channel: "D1", thread: "100.0", messageTs: "200.0" });
  });

  it("threads channel replies under the root message", () => {
    const root = buildReplyContext({ channel: "C1", user: "U1", ts: "100.0", channel_type: "channel" });
    expect(root).toMatchObject({ thread: "100.0" });
    const reply = buildReplyContext({ channel: "C1", user: "U1", ts: "200.0", thread_ts: "100.0", channel_type: "channel" });
    expect(reply).toMatchObject({ thread: "100.0" });
  });

  // The whole context, not just the thread: it is stored as-is on the session.
  it("is exactly channel, thread and messageTs for a channel root message", () => {
    expect(
      buildReplyContext({ channel: "C123", ts: "1700000000.000100", channel_type: "channel" }),
    ).toStrictEqual({ channel: "C123", thread: "1700000000.000100", messageTs: "1700000000.000100" });
  });

  it("is the thread's root plus the reply's own ts for a thread reply", () => {
    expect(
      buildReplyContext({ channel: "C123", ts: "1700000100.000200", thread_ts: "1700000000.000100" }),
    ).toStrictEqual({ channel: "C123", thread: "1700000000.000100", messageTs: "1700000100.000200" });
  });

  it("is a null thread and nothing more for a non-threaded DM", () => {
    expect(
      buildReplyContext({ channel: "D123", ts: "1700000000.000100", channel_type: "im" }),
    ).toStrictEqual({ channel: "D123", thread: null, messageTs: "1700000000.000100" });
  });
});

describe("isOldSlackMessage", () => {
  it("treats a message older than boot time as old", () => {
    expect(isOldSlackMessage("100.0", 200_000)).toBe(true);
  });

  it("treats a message newer than boot time as not old", () => {
    expect(isOldSlackMessage("300.0", 200_000)).toBe(false);
  });

  it("returns false for a missing ts", () => {
    expect(isOldSlackMessage(undefined, 200_000)).toBe(false);
  });
});
