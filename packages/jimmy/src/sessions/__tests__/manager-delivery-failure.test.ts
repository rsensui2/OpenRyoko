import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { notifyParentSession } from "../callbacks.js";
import { getMessages, getSession, getSessionBySessionKey } from "../registry.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

// The reply used to be delivered BEFORE the turn's state was saved. A connector
// that rejected the reply threw past the save: the engine had finished, but its
// session id was never stored (a new conversation lost its whole context), the
// turn was marked as an error, the parent session was told the child had
// failed, and "Error: <transport error>" was posted back to the conversation.

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../callbacks.js", async (original) => ({
  ...await original<typeof import("../callbacks.js")>(),
  notifyParentSession: vi.fn(),
}));

const CONFIG = {
  engines: { default: "claude", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
  connectors: {},
  logging: { level: "error", stdout: false },
  sessions: {},
} as unknown as JinnConfig;

let nextKey = 0;

function setup(result: Partial<EngineResult> = {}) {
  const run = vi.fn<Engine["run"]>().mockResolvedValue({
    sessionId: "engine-session-1",
    result: "調査が終わりました。",
    numTurns: 1,
    ...result,
  });
  const manager = new SessionManager(CONFIG, new Map([["claude", { name: "claude", run }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string): Promise<string | undefined> => {
    throw new Error("connector offline");
  });
  const connector = {
    name: "discord",
    replyMessage,
    sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}),
    removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
    reconstructTarget: () => ({ channel: "C-delivery" }),
  } as unknown as Connector;
  const sessionKey = `discord:delivery-failure-${++nextKey}`;
  const msg = {
    connector: "discord", source: "discord", sessionKey,
    channel: "C-delivery", user: "owner", userId: "U-owner", text: "進捗を教えて",
    attachments: [], raw: {}, replyContext: { channel: "C-delivery" },
    transportMeta: { channelExternal: false },
  } as unknown as IncomingMessage;
  return { manager, run, connector, replyMessage, msg, sessionKey };
}

beforeEach(() => {
  vi.mocked(notifyParentSession).mockClear();
});

describe("SessionManager — the reply cannot be delivered", () => {
  it("still saves the engine session, so the conversation keeps its context", async () => {
    const { manager, run, connector, msg, sessionKey } = setup();

    await manager.route(msg, connector);

    const session = getSessionBySessionKey(sessionKey)!;
    expect(session.engineSessionId).toBe("engine-session-1");
    expect(getMessages(session.id).filter((m) => m.role === "assistant").map((m) => m.content))
      .toEqual(["調査が終わりました。"]);

    await manager.route({ ...msg, text: "続きをお願いします" }, connector);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].resumeSessionId).toBe("engine-session-1");
  });

  it("keeps the turn a completed one and does not tell the parent it failed", async () => {
    const { manager, connector, msg, sessionKey } = setup();

    await manager.route(msg, connector);

    const session = getSessionBySessionKey(sessionKey)!;
    expect(session.status).toBe("idle");
    expect(notifyParentSession).toHaveBeenCalledTimes(1);
    const [notified, outcome] = vi.mocked(notifyParentSession).mock.calls[0];
    expect(notified.id).toBe(session.id);
    expect(outcome).toMatchObject({ result: "調査が終わりました。", error: null });
  });

  it("records the reply as undelivered instead of posting the transport error", async () => {
    const { manager, connector, replyMessage, msg, sessionKey } = setup();

    await manager.route(msg, connector);

    const session = getSessionBySessionKey(sessionKey)!;
    expect(session.lastError).toContain("origin delivery failed");
    const notes = getMessages(session.id).filter((m) => m.role === "notification");
    expect(notes.some((m) => m.content.includes("NOT delivered to the original conversation"))).toBe(true);
    // One attempt at the reply, and no "Error: connector offline" sent after it.
    expect(replyMessage.mock.calls.map(([, text]) => text)).toEqual(["調査が終わりました。"]);
  });

  it("stops at the first turn that fails to land and records the rest as undelivered", async () => {
    const { manager, connector, replyMessage, msg, sessionKey } = setup({
      result: "三つ目の報告",
      turns: ["一つ目の報告", "二つ目の報告", "三つ目の報告"],
    });
    replyMessage.mockResolvedValueOnce("M1");

    await manager.route(msg, connector);

    const session = getSessionBySessionKey(sessionKey)!;
    expect(replyMessage.mock.calls.map(([, text]) => text)).toEqual(["一つ目の報告", "二つ目の報告"]);
    expect(session.engineSessionId).toBe("engine-session-1");
    expect(session.status).toBe("idle");
    expect(session.lastError).toContain("origin delivery failed");
  });

  it("reports an engine failure as the engine's, whatever happened to the reply", async () => {
    const { manager, connector, msg, sessionKey } = setup({ result: "", error: "engine crashed" });

    await manager.route(msg, connector);

    const session = getSessionBySessionKey(sessionKey)!;
    expect(session.status).toBe("error");
    expect(session.engineSessionId).toBe("engine-session-1");
    const [, outcome] = vi.mocked(notifyParentSession).mock.calls[0];
    expect(outcome).toMatchObject({ error: "engine crashed" });
  });

  it("fails toward its caller, and nowhere else, when it cannot even report a missing engine", async () => {
    const { connector, msg, sessionKey } = setup();
    const manager = new SessionManager(CONFIG, new Map());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      // The gateway's connector handlers catch and log a rejected route().
      await expect(manager.route(msg, connector)).rejects.toThrow("connector offline");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(manager.getQueue().isRunning(sessionKey)).toBe(false);
  });

  it("leaves no undelivered record when the reply lands", async () => {
    const { manager, connector, replyMessage, msg, sessionKey } = setup();
    replyMessage.mockResolvedValue("M1");

    await manager.route(msg, connector);

    const session = getSession(getSessionBySessionKey(sessionKey)!.id)!;
    expect(session.status).toBe("idle");
    expect(session.lastError).toBeNull();
    expect(getMessages(session.id).filter((m) => m.role === "notification")).toEqual([]);
  });
});
