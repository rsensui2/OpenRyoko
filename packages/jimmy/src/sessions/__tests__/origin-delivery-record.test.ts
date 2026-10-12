import { describe, expect, it, vi } from "vitest";
import { hasUndeliveredReply, recordFailedOriginDelivery } from "../origin-delivery.js";
import { createSession, getMessages, getSession, updateSession } from "../registry.js";

// A cron job whose reply could not be delivered ends with this record, and the
// cron run log and the operator's alert quote its lastError. With a fixed text
// there, the operator learned that delivery failed but not why — the reason
// (channel_not_found, say) was only in the gateway log.

const LEGACY = "origin delivery failed — reply not posted to the original conversation";

let nextKey = 0;

function recordFor(reason?: string) {
  const key = `slack:origin-delivery-record-${++nextKey}`;
  const session = createSession({
    engine: "claude",
    source: "slack",
    sourceRef: key,
    connector: "slack",
    sessionKey: key,
    replyContext: { channel: "C1", thread: "1.000" },
    prompt: "資料を作って",
  });
  const emit = vi.fn();
  recordFailedOriginDelivery(session, emit, reason);
  const notes = getMessages(session.id).filter((m) => m.role === "notification").map((m) => m.content);
  return { lastError: getSession(session.id)!.lastError ?? "", note: notes[0] ?? "", notes, emit };
}

describe("recordFailedOriginDelivery", () => {
  it("keeps the wording callers without a reason have always had", () => {
    const recorded = recordFor();

    expect(recorded.lastError).toBe(LEGACY);
    expect(recorded.notes).toHaveLength(1);
    expect(recorded.note).toContain("NOT delivered to the original conversation");
    expect(recorded.note).not.toContain("Reason:");
  });

  it.each(["", "   ", "\n\t"])("treats a blank reason (%j) as no reason", (reason) => {
    expect(recordFor(reason).lastError).toBe(LEGACY);
  });

  it("appends the reason to lastError and to the note", () => {
    const recorded = recordFor("An API error occurred: channel_not_found");

    expect(recorded.lastError).toBe(`${LEGACY}: An API error occurred: channel_not_found`);
    expect(recorded.note).toContain("Reason: An API error occurred: channel_not_found");
  });

  it("says how much of a partly delivered reply landed", () => {
    const recorded = recordFor("Slack replyMessage: only 1 of 4 chunks were delivered (request timed out)");

    expect(recorded.lastError).toBe(`${LEGACY}: Slack replyMessage: only 1 of 4 chunks were delivered (request timed out)`);
  });

  // Synthetic values in the shape of each credential.
  const slackToken = "xoxb-" + "1234567890-abcdefghijklmnop";
  const slackAppToken = "xapp-" + "1-A0000000000-1234567890123-" + "abcdef0123456789abcdef0123456789";
  const telegramToken = "1234567890:" + "AAE" + "abcdefghijklmnopqrstuvwxyz012345";
  const discordToken = `${Buffer.from("123456789012345678").toString("base64")}.GAbCdE.` + "abcdefghijklmnopqrstuvwxyz_";

  it.each([
    ["a Slack bot token", `invalid_auth for ${slackToken}`, slackToken],
    ["a Slack app token", `socket closed for ${slackAppToken}`, slackAppToken],
    ["a Telegram bot token in an API URL", `request to https://api.telegram.org/bot${telegramToken}/sendMessage failed`, telegramToken],
    ["a Discord bot token", `login failed with ${discordToken}`, discordToken],
    ["a bearer header", "401 from proxy (Authorization: Bearer abcdef0123456789abcdef)", "abcdef0123456789abcdef"],
  ])("never stores %s that the reason carried", (_label, reason, secret) => {
    const recorded = recordFor(reason);

    expect(recorded.lastError.startsWith(`${LEGACY}: `)).toBe(true);
    expect(recorded.lastError).toContain("[REDACTED]");
    expect(recorded.lastError).not.toContain(secret);
    expect(recorded.note).not.toContain(secret);
    expect(JSON.stringify(recorded.emit.mock.calls)).not.toContain(secret);
  });

  it("keeps the readable part of a Telegram URL around the masked token", () => {
    const recorded = recordFor(`request to https://api.telegram.org/bot${telegramToken}/sendMessage failed`);

    expect(recorded.lastError).toBe(`${LEGACY}: request to https://api.telegram.org/bot[REDACTED]/sendMessage failed`);
  });

  it("folds a multi-line reason into one line", () => {
    const recorded = recordFor("Request failed\n    at Object.send (client.js:10:5)\n\n  cause:\tECONNRESET");

    expect(recorded.lastError).toBe(`${LEGACY}: Request failed at Object.send (client.js:10:5) cause: ECONNRESET`);
  });

  it("cuts a long reason off at 300 characters", () => {
    const recorded = recordFor("x".repeat(1_000));

    expect(recorded.lastError).toBe(`${LEGACY}: ${"x".repeat(300)}…`);
  });

  it("cuts between characters, never through one", () => {
    const recorded = recordFor("😀".repeat(400));

    // 300 whole characters: cutting by UTF-16 unit would stop after 150 of
    // them, and could leave half of one behind.
    expect(recorded.lastError).toBe(`${LEGACY}: ${"😀".repeat(300)}…`);
  });

  it("masks before it cuts, so a credential at the cut-off does not leak its first characters", () => {
    const recorded = recordFor(`${"a".repeat(292)} ${slackToken}`);

    expect(recorded.lastError).not.toContain("xoxb");
    expect(recorded.note).not.toContain("xoxb");
  });
});

// The restart nudge has to tell a reply that went out from one whose delivery
// failed and was recorded here — both leave the session idle. It asks this
// module, which wrote the record, instead of reading lastError's wording itself.
describe("hasUndeliveredReply", () => {
  function session() {
    const key = `slack:origin-delivery-record-${++nextKey}`;
    return createSession({ engine: "claude", source: "slack", sourceRef: key, connector: "slack", sessionKey: key, replyContext: { channel: "C1", thread: "1.000" } });
  }

  it.each([undefined, "An API error occurred: channel_not_found", "Slack replyMessage: only 1 of 4 chunks were delivered (request timed out)"])(
    "is true for the record recordFailedOriginDelivery leaves (reason: %j)", (reason) => {
      const created = session();
      recordFailedOriginDelivery(created, undefined, reason);
      expect(hasUndeliveredReply(getSession(created.id)!)).toBe(true);
    });

  it("is false for a session with no such record", () => {
    const created = session();
    expect(hasUndeliveredReply(getSession(created.id)!)).toBe(false);
    updateSession(created.id, { status: "error", lastError: "Not logged in · Please run /login" });
    expect(hasUndeliveredReply(getSession(created.id)!)).toBe(false);
  });

  it("is false again once a later turn has settled and reset lastError", () => {
    const created = session();
    recordFailedOriginDelivery(created, undefined, "channel_not_found");
    updateSession(created.id, { status: "idle", lastError: null });
    expect(hasUndeliveredReply(getSession(created.id)!)).toBe(false);
  });
});
