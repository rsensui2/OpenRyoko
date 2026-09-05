import { describe, it, expect, vi } from "vitest";
import { deliverToOriginConnector } from "../origin-delivery.js";
import type { Connector, Session } from "../../shared/types.js";

// Issue #38 follow-up: a turn triggered outside the connector route (detached
// job wake-up, orphan Stop hook) must deliver its answer back to the original
// conversation via the session's stored reply_context — the accident left an
// externally-shared Slack thread waiting on "生成中です" forever.

function makeConnector() {
  const replyMessage = vi.fn(async () => "ts-1");
  const addReaction = vi.fn(async () => {});
  const connector = {
    name: "slack",
    replyMessage,
    addReaction,
    getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
    reconstructTarget: (rc: Record<string, unknown>) => ({
      channel: typeof rc.channel === "string" ? rc.channel : "",
      thread: typeof rc.thread === "string" ? rc.thread : undefined,
      messageTs: typeof rc.messageTs === "string" ? rc.messageTs : undefined,
    }),
  } as unknown as Connector;
  return { connector, replyMessage, addReaction };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    engine: "claude",
    engineSessionId: null,
    source: "slack",
    sourceRef: "C777",
    connector: "slack",
    sessionKey: "slack:C777:111.222",
    replyContext: { channel: "C777", thread: "111.222", messageTs: "111.333" },
    messageId: null,
    transportMeta: { channelExternal: true },
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-08-04T00:00:00Z",
    lastActivity: "2026-08-04T00:00:00Z",
    lastError: null,
    ...overrides,
  } as Session;
}

describe("deliverToOriginConnector", () => {
  it("replies into the original channel/thread from reply_context", async () => {
    const { connector, replyMessage } = makeConnector();
    const delivered = await deliverToOriginConnector(makeSession(), "資料が完成しました", new Map([["slack", connector]]));

    expect(delivered).toBe("delivered");
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const [target, text] = replyMessage.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toMatchObject({ channel: "C777", thread: "111.222" });
    expect(text).toBe("資料が完成しました");
  });

  it("strips a disposition trailer before posting (external channel safety)", async () => {
    const { connector, replyMessage } = makeConnector();
    const internal = Buffer.from(JSON.stringify({ internal: "operator note" })).toString("base64url");
    const text = `公開する返信\n\n<!--RYOKO-DISPOSITION:v1:${internal}-->`;
    await deliverToOriginConnector(makeSession(), text, new Map([["slack", connector]]));

    const [, posted] = replyMessage.mock.calls[0] as unknown as [unknown, string];
    expect(posted).toBe("公開する返信");
    expect(posted).not.toContain("operator note");
  });

  it("reports no_target for a web session (no connector)", async () => {
    const { connector, replyMessage } = makeConnector();
    const session = makeSession({ connector: null, replyContext: { source: "web" } as never });
    const delivered = await deliverToOriginConnector(session, "answer", new Map([["slack", connector]]));

    expect(delivered).toBe("no_target");
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it("reports no_target when reply_context has no addressable channel", async () => {
    const { connector, replyMessage } = makeConnector();
    const session = makeSession({ replyContext: { source: "web" } as never });
    const delivered = await deliverToOriginConnector(session, "answer", new Map([["slack", connector]]));

    expect(delivered).toBe("no_target");
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it("suppresses empty text (intentional no-post, not an error)", async () => {
    const { connector, replyMessage } = makeConnector();
    const delivered = await deliverToOriginConnector(makeSession(), "   ", new Map([["slack", connector]]));

    expect(delivered).toBe("suppressed");
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it("isUndeliveredToOrigin: web session (pseudo connector \"web\") is NOT an undelivered failure", async () => {
    const { isUndeliveredToOrigin } = await import("../origin-delivery.js");
    // Production web sessions: createSession defaults connector to the source.
    const webSession = makeSession({ connector: "web", source: "web", replyContext: { source: "web" } as never });
    expect(isUndeliveredToOrigin("no_target", webSession)).toBe(false);

    // A Slack session whose connector is missing/down IS an undelivered failure.
    const slackSession = makeSession();
    expect(isUndeliveredToOrigin("no_target", slackSession)).toBe(true);
    expect(isUndeliveredToOrigin("failed", webSession)).toBe(true);
    expect(isUndeliveredToOrigin("suppressed", slackSession)).toBe(false);
    expect(isUndeliveredToOrigin("delivered", slackSession)).toBe(false);
  });

  it("retries a transient connector error and delivers", async () => {
    const { connector, replyMessage } = makeConnector();
    replyMessage.mockRejectedValueOnce(new Error("slack down"));
    const delivered = await deliverToOriginConnector(makeSession(), "answer", new Map([["slack", connector]]), [1]);

    expect(delivered).toBe("delivered");
    expect(replyMessage).toHaveBeenCalledTimes(2);
  });

  it("returns \"failed\" (not skipped) when every attempt fails — caller must surface it", async () => {
    const { connector, replyMessage } = makeConnector();
    replyMessage.mockRejectedValue(new Error("slack down"));
    const delivered = await deliverToOriginConnector(makeSession(), "answer", new Map([["slack", connector]]), [1]);

    expect(delivered).toBe("failed");
    expect(replyMessage).toHaveBeenCalledTimes(2);
  });
});
