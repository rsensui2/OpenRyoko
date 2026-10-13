import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// Regression pin for the "stuck child" stall: a delegated child whose engine
// process died mid-turn is left at status:"running" by the web runner (it
// reads "Interrupted: claude process exited" as "a newer message took over"
// and returns without a receipt). The reconciler used to reset such a child to
// idle with `error: null` — it looked like a success, and the parent that
// ended its turn waiting for the child's notification was never woken.
//
// Everything here is real except the engines and the Slack connector: the
// registry, the reconciler, callbacks.ts and the /message route.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-lost-child-home-"));

const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  sessions: {},
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

const STALE_MS = 120_000;

describe("status reconciler — a stuck child is settled with its error and the parent is woken", () => {
  let server: http.Server;
  let baseUrl: string;
  let parentEngineRun: ReturnType<typeof vi.fn>;
  let replyMessage: ReturnType<typeof vi.fn>;
  let registry: typeof import("../../sessions/registry.js");
  let reconciler: typeof import("../status-reconciler.js");
  let lostTurn: typeof import("../../sessions/lost-turn.js");
  let sessionManager: import("../../sessions/manager.js").SessionManager;
  let parentId: string;
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;

  /** The engine has no turn for anything: every "running" session is one whose engine was lost. */
  const lostEngines = () => new Map<string, Engine>([["claude", { isTurnRunning: () => false } as unknown as Engine]]);

  function sweepDeps(pendingStuck: Set<string>) {
    return {
      engines: lostEngines(),
      emit: (event: string, payload: unknown) => { emitted.push({ event, payload: payload as Record<string, unknown> }); },
      pendingStuck,
      // The same wiring startGateway uses.
      isOwned: (session: { sessionKey: string }) => sessionManager.getQueue().isRunning(session.sessionKey),
    };
  }

  function stuckChild(key: string): string {
    const child = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: key,
      connector: "web",
      sessionKey: key,
      replyContext: { source: "web" },
      employee: "worker",
      parentSessionId: parentId,
      prompt: "競合を調べて",
    });
    registry.insertMessage(child.id, "user", "競合を調べて");
    // What the web runner leaves behind when the engine reports "Interrupted: claude process exited".
    registry.insertMessage(child.id, "notification", "🔄 新しいメッセージを踏まえて再検討");
    registry.updateSession(child.id, { status: "running", lastActivity: new Date(Date.now() - STALE_MS).toISOString() });
    return child.id;
  }

  beforeAll(async () => {
    const { handleApiRequest } = await import("../api.js");
    registry = await import("../../sessions/registry.js");
    reconciler = await import("../status-reconciler.js");
    lostTurn = await import("../../sessions/lost-turn.js");
    const { SessionManager } = await import("../../sessions/manager.js");

    parentEngineRun = vi.fn(async () => ({ result: "worker が止まっていたので、もう一度依頼しました。", sessionId: "parent-engine-1", numTurns: 1 }));
    const engines = new Map<string, Engine>([["claude", { run: parentEngineRun } as unknown as Engine]]);
    sessionManager = new SessionManager(STUB_CONFIG, engines, ["slack"]);

    replyMessage = vi.fn(async () => "posted-ts");
    const fakeSlack = {
      name: "slack",
      replyMessage,
      addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({
        channel: typeof rc.channel === "string" ? rc.channel : "",
        thread: typeof rc.thread === "string" ? rc.thread : undefined,
      }),
    } as unknown as Connector;

    const context = {
      config: STUB_CONFIG,
      getConfig: () => STUB_CONFIG,
      sessionManager,
      startTime: 0,
      emit: () => {},
      connectors: new Map([["slack", fakeSlack]]),
    };
    server = http.createServer((req, res) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleApiRequest(req, res, context as any);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // callbacks.ts posts to this instance's own gateway port, read from config.yaml.
    fs.writeFileSync(path.join(process.env.RYOKO_HOME!, "config.yaml"), `gateway:\n  port: ${port}\n  host: 127.0.0.1\n`);
    // Fail closed: nothing in this suite may reach any other gateway.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${baseUrl}/`)) throw new Error(`test attempted to reach ${url}`);
      return realFetch(input, init);
    }) as typeof fetch;

    const parent = registry.createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_OPS",
      connector: "slack",
      sessionKey: "slack:C_OPS:10.20",
      replyContext: { channel: "C_OPS", thread: "10.20" },
      transportMeta: { channelExternal: false },
      prompt: "競合調査をお願い",
    });
    parentId = parent.id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("stuck child → settled with the reason → the parent runs a turn about it", async () => {
    const childId = stuckChild("web:lost-child-1");
    const deps = sweepDeps(new Set<string>());

    expect(reconciler.sweepOnce(deps)).toBe(0); // first observation only marks it
    expect(registry.getSession(childId)?.status).toBe("running");
    expect(parentEngineRun).not.toHaveBeenCalled();

    expect(reconciler.sweepOnce(deps)).toBe(1); // confirmed on the next sweep

    const child = registry.getSession(childId)!;
    expect(child.status).toBe("interrupted");
    expect(child.status).not.toBe("idle"); // never a success-looking receipt
    expect(child.lastError).toBe(lostTurn.LOST_TURN_ERROR);
    expect(emitted).toContainEqual({
      event: "session:completed",
      payload: expect.objectContaining({ sessionId: childId, result: null, error: lostTurn.LOST_TURN_ERROR }),
    });

    // The parent is woken through the normal child-callback path…
    await vi.waitFor(() => expect(parentEngineRun).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const prompt = (parentEngineRun.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain(`Employee "worker" (session ${childId}) encountered an error`);
    expect(prompt).toContain(lostTurn.LOST_TURN_ERROR);
    // …and, being a Slack-origin session, answers into its own thread.
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(replyMessage.mock.calls[0][0]).toMatchObject({ channel: "C_OPS", thread: "10.20" });

    // Exactly once: later sweeps have nothing left to report.
    expect(reconciler.sweepOnce(deps)).toBe(0);
    expect(reconciler.sweepOnce(deps)).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(parentEngineRun).toHaveBeenCalledTimes(1);
  });

  it("a child whose runner is still at work is left alone", async () => {
    parentEngineRun.mockClear();
    const key = "web:live-child-1";
    const childId = stuckChild(key);
    const queue = sessionManager.getQueue();
    let finish!: () => void;
    // A runner that holds the session's queue slot while it has no engine turn
    // (posting its reply, reviewing a goal, waiting on the SSH fallback).
    const runner = queue.enqueue(key, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(queue.isRunning(key)).toBe(true));
    const deps = sweepDeps(new Set<string>());

    for (let i = 0; i < 4; i++) expect(reconciler.sweepOnce(deps)).toBe(0);

    expect(registry.getSession(childId)?.status).toBe("running");
    expect(registry.getSession(childId)?.lastError).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(parentEngineRun).not.toHaveBeenCalled();

    finish();
    await runner;
  });
});
