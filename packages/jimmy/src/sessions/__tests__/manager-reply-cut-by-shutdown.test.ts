import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { hasUndeliveredReply } from "../origin-delivery.js";
import { getMessages, getSessionBySessionKey } from "../registry.js";
import {
  interruptRunningSessionsForShutdown,
  prepareRestartResume,
  readRestartResumeState,
  selectRestartResumeCandidates,
} from "../restart-resume.js";
import type { Connector, Engine, IncomingMessage, JinnConfig } from "../../shared/types.js";

// A connector turn records its reply, then delivers it, and only then leaves
// "running" — so a shutdown can land while the reply is on its way out. The
// shutdown stops the connectors, and the post fails. The runner catches that,
// records the reply as undelivered and settles the turn as an ordinary "idle".
//
// The next boot used to read that "idle" as "the reply went out" and leave the
// session alone: the conversation never got the answer, and nothing said so.

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../callbacks.js", async (original) => ({
  ...await original<typeof import("../callbacks.js")>(),
  notifyParentSession: vi.fn(),
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
  notifyDiscordChannel: vi.fn(),
}));

const CONFIG = {
  engines: { default: "claude", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
  connectors: {},
  logging: { level: "error", stdout: false },
  sessions: {},
} as unknown as JinnConfig;
const TWO_HOURS = 120 * 60_000;

let nextKey = 0;

/** A Discord turn whose reply is being posted when the shutdown reaches the session. */
function setup(post: () => Promise<string | undefined>) {
  const run = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "engine-session-1", result: "デプロイが完了しました。", numTurns: 1 });
  const manager = new SessionManager(CONFIG, new Map([["claude", { name: "claude", run }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string): Promise<string | undefined> => {
    interruptRunningSessionsForShutdown(); // server.ts cleanup: mark what is running, then stop the connectors
    return post();
  });
  const connector = {
    name: "discord",
    replyMessage,
    sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}),
    removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
    reconstructTarget: () => ({ channel: "C-shutdown" }),
  } as unknown as Connector;
  const sessionKey = `discord:reply-cut-by-shutdown-${++nextKey}`;
  const msg = {
    connector: "discord", source: "discord", sessionKey,
    channel: "C-shutdown", user: "owner", userId: "U-owner", text: "本番にデプロイして",
    attachments: [], raw: {}, replyContext: { channel: "C-shutdown" },
    transportMeta: { channelExternal: false },
  } as unknown as IncomingMessage;
  return { manager, connector, replyMessage, msg, sessionKey };
}

afterEach(() => {
  prepareRestartResume(); // a boot: "shutting down" is over
});

describe("a reply that was on its way out when the gateway shut down", () => {
  it("is picked up after the restart when the connector could no longer take it", async () => {
    const f = setup(async () => { throw new Error("Discord client is not ready"); });

    await f.manager.route(f.msg, f.connector);

    // The turn itself is a finished one, with the lost reply on record …
    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(session.status).toBe("idle");
    expect(hasUndeliveredReply(session)).toBe(true);
    expect(getMessages(session.id).filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["デプロイが完了しました。"]);
    // … and the shutdown's mark survived its completion, saying the reply had been recorded.
    expect(readRestartResumeState(session.transportMeta)).toMatchObject({ interruptedAt: expect.any(String), replyRecorded: true });

    const { candidates } = selectRestartResumeCandidates({ now: Date.now(), maxAgeMs: TWO_HOURS });

    expect(candidates.map((candidate) => candidate.id)).toContain(session.id);
  });

  it("is left alone after the restart when it did go out", async () => {
    const f = setup(async () => "M1");

    await f.manager.route(f.msg, f.connector);

    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(session.status).toBe("idle");
    expect(hasUndeliveredReply(session)).toBe(false);
    expect(readRestartResumeState(session.transportMeta)).toMatchObject({ interruptedAt: expect.any(String), replyRecorded: true });

    const { candidates, skipped } = selectRestartResumeCandidates({ now: Date.now(), maxAgeMs: TWO_HOURS });

    expect(candidates.map((candidate) => candidate.id)).not.toContain(session.id);
    expect(skipped).toContainEqual({ sessionId: session.id, reason: "answered" });
  });
});
