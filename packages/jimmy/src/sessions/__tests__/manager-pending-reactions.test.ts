import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { createSession, deleteSession, getSessionBySessionKey, updateSession } from "../registry.js";
import type { Connector, Engine, EngineRunOpts, IncomingMessage, JinnConfig, Target } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../goal-execution.js", () => ({
  sessionGoalOptions: () => ({}),
  runWithSessionGoal: (engine: Engine, opts: EngineRunOpts) => engine.run(opts),
}));

afterEach(() => vi.restoreAllMocks());
let sequence = 0;

function setup(missingEngine = false) {
  const config = {
    engines: { default: "codex", codex: { bin: "codex" } },
    connectors: { slack: {} }, sessions: {}, logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;
  const run = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "native-test", result: "完了しました。" });
  const engines = new Map<string, Engine>();
  if (!missingEngine) engines.set("codex", { name: "codex", run } as Engine);
  const manager = new SessionManager(config, engines);
  const sessionKey = `slack:pending-reactions-${++sequence}`;
  const msg = {
    connector: "slack", source: "slack", sessionKey, channel: "C-pending", thread: "thread-pending",
    messageId: "100.000002", user: "Test", userId: "U-test", text: "確認してください", attachments: [], raw: {},
    replyContext: { channel: "C-pending", thread: "thread-pending" },
    transportMeta: { channelExternal: false },
  } as IncomingMessage;
  const reactions = new Map<string, Set<string>>([[msg.messageId!, new Set(["eyes"])]]);
  const events: Array<{ type: "add" | "remove"; emoji: string; messageTs: string }> = [];
  const changeReaction = (type: "add" | "remove", target: Target, emoji: string) => {
    const messageTs = target.messageTs!;
    events.push({ type, emoji, messageTs });
    if (!reactions.has(messageTs)) reactions.set(messageTs, new Set());
    if (type === "add") reactions.get(messageTs)!.add(emoji);
    else reactions.get(messageTs)!.delete(emoji);
  };
  const replyMessage = vi.fn(async () => undefined);
  const connector = {
    name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async (target: Target, emoji: string) => { changeReaction("add", target, emoji); }),
    removeReaction: vi.fn(async (target: Target, emoji: string) => { changeReaction("remove", target, emoji); }),
    getCapabilities: () => ({ threading: true, messageEdits: false, reactions: true, attachments: false }),
    reconstructTarget: () => ({ channel: "C-pending", thread: "thread-pending" }),
  } as unknown as Connector;
  return { manager, connector, msg, run, replyMessage, reactions, events };
}

async function occupyQueue(fixture: ReturnType<typeof setup>) {
  const session = createSession({ engine: "codex", source: "slack", connector: "slack",
    sourceRef: fixture.msg.sessionKey, sessionKey: fixture.msg.sessionKey, replyContext: fixture.msg.replyContext });
  updateSession(session.id, { status: "running" });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const head = fixture.manager.getQueue().enqueue(fixture.msg.sessionKey, async () => {
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await started;
  return { head, release, session };
}

describe("SessionManager pending reaction cleanup", () => {
  it("clears only the cancelled message's indicators when its queue callback never starts", async () => {
    const fixture = setup();
    const { manager, connector, msg, reactions, run } = fixture;
    const { head, release } = await occupyQueue(fixture);
    reactions.set("100.000001", new Set(["eyes"]));
    const routed = manager.route(msg, connector);
    await vi.waitFor(() => expect(manager.getQueue().getPendingCount(msg.sessionKey)).toBe(1));
    expect(reactions.get(msg.messageId!)).toEqual(new Set(["eyes", "clock1"]));
    manager.getQueue().clearQueue(msg.sessionKey);
    release();
    await Promise.all([head, routed]);
    expect(run).not.toHaveBeenCalled();
    expect(reactions.get(msg.messageId!)).toEqual(new Set());
    expect(reactions.get("100.000001")).toEqual(new Set(["eyes"]));
  });

  it("clears pending indicators when enqueue rejects before invoking the callback", async () => {
    const { manager, connector, msg, reactions, run } = setup();
    reactions.get(msg.messageId!)!.add("clock1");
    vi.spyOn(manager.getQueue(), "enqueue").mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(manager.route(msg, connector)).rejects.toThrow("queue unavailable");
    expect(run).not.toHaveBeenCalled();
    expect(reactions.get(msg.messageId!)).toEqual(new Set());
  });

  it("clears indicators if the session disappears while waiting in the queue", async () => {
    const fixture = setup();
    const { manager, connector, msg, reactions, run } = fixture;
    const { head, release } = await occupyQueue(fixture);
    const routed = manager.route(msg, connector);
    await vi.waitFor(() => expect(manager.getQueue().getPendingCount(msg.sessionKey)).toBe(1));
    deleteSession(getSessionBySessionKey(msg.sessionKey)!.id);
    release();
    await Promise.all([head, routed]);
    expect(run).not.toHaveBeenCalled();
    expect(reactions.get(msg.messageId!)).toEqual(new Set());
  });

  it("clears indicators on an unavailable-engine early return", async () => {
    const { manager, connector, msg, reactions, replyMessage, run } = setup(true);
    reactions.get(msg.messageId!)!.add("clock1");
    await manager.route(msg, connector);
    expect(replyMessage).toHaveBeenCalledWith(expect.objectContaining({ messageTs: msg.messageId }), expect.stringContaining('engine "codex" not available'));
    expect(run).not.toHaveBeenCalled();
    expect(reactions.get(msg.messageId!)).toEqual(new Set());
  });

  it("clears processing indicators when a reset suppresses the engine's orphaned response", async () => {
    const { manager, connector, msg, reactions, run, replyMessage } = setup();
    run.mockImplementation(async () => {
      deleteSession(getSessionBySessionKey(msg.sessionKey)!.id);
      return { sessionId: "native-test", result: "This response belongs to the reset session." };
    });
    await manager.route(msg, connector);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(reactions.get(msg.messageId!)).toEqual(new Set());
  });

  it("removes the queue clock at startup but preserves an intentional final eyes reaction", async () => {
    const { manager, connector, msg, reactions, run, events } = setup();
    reactions.get(msg.messageId!)!.add("clock1");
    const payload = Buffer.from(JSON.stringify({ suppressPublic: true, react: "eyes" })).toString("base64url");
    run.mockImplementation(async () => {
      expect(reactions.get(msg.messageId!)).toEqual(new Set(["eyes"]));
      return { sessionId: "native-test", result: `<!--RYOKO-DISPOSITION:v1:${payload}-->` };
    });
    await manager.route(msg, connector);
    expect(run).toHaveBeenCalledOnce();
    expect(reactions.get(msg.messageId!)).toEqual(new Set(["eyes"]));
    expect(events.at(-1)).toEqual({ type: "add", emoji: "eyes", messageTs: msg.messageId });
    const removals = events.map((event, index) => ({ ...event, index }))
      .filter((event) => event.type === "remove" && event.emoji === "eyes");
    expect(removals.at(-1)?.index).toBeLessThan(events.length - 1);
  });
});
