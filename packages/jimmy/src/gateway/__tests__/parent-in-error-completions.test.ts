import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, EngineResult, JinnConfig, Session } from "../../shared/types.js";

// A child's completion is not sent to a parent that is in error — a rule that
// keeps a parent stopped by a usage limit or a lost login from running one
// failing turn per child that finishes. Two things were wrong with it.
//
// A parent whose Claude process died mid-turn is in error too (it used to be
// settled as if it had been interrupted). Nothing about it would fail again,
// yet every completion that followed was dropped: no turn, no post in its
// Slack thread — the thread just stopped.
//
// And "not sent" meant thrown away. A parent that could not be woken did not
// even have, in its transcript, the fact that a child had finished.
//
// Real registry, real callbacks.ts (authenticated POST), real /message route;
// only the engine and the Slack connector are fakes.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "parent-in-error-home-"));

const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "", fallback: [] },
    codex: { bin: "codex", model: "", fallback: [] },
  },
  connectors: {},
  sessions: {},
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

describe("child completions for a parent that is in error", () => {
  let server: http.Server;
  let baseUrl: string;
  let engineRun: ReturnType<typeof vi.fn>;
  let replyMessage: ReturnType<typeof vi.fn>;
  let registry: typeof import("../../sessions/registry.js");
  let callbacks: typeof import("../../sessions/callbacks.js");
  let originDelivery: typeof import("../../sessions/origin-delivery.js");
  let thread = 0;
  /** Sessions whose next engine run ends the way a dead Claude process does. */
  const diesOnNextRun = new Set<string>();
  const realFetch = globalThis.fetch;

  const prompts = () => engineRun.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
  const notifications = (sessionId: string) => registry.getMessages(sessionId).filter((m) => m.role === "notification");

  function slackParent(): Session {
    const ts = `${++thread}.000`;
    return registry.createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_TEAM",
      connector: "slack",
      sessionKey: `slack:C_TEAM:${ts}`,
      replyContext: { channel: "C_TEAM", thread: ts },
      transportMeta: { channelExternal: false },
      prompt: "3人に調査を頼んで、まとめて",
    });
  }

  /** A child finishes: the real callback path. */
  function complete(parent: Session, employee: string, result: { result?: string; error?: string }): Session {
    const key = `web:${parent.id}:${employee}`;
    const finished = registry.createSession({ engine: "claude", source: "web", sourceRef: key, connector: "web", sessionKey: key, replyContext: { source: "web" }, employee, parentSessionId: parent.id });
    callbacks.notifyParentSession(finished, result);
    return finished;
  }

  beforeAll(async () => {
    const api = await import("../api.js");
    registry = await import("../../sessions/registry.js");
    callbacks = await import("../../sessions/callbacks.js");
    originDelivery = await import("../../sessions/origin-delivery.js");
    const { SessionManager } = await import("../../sessions/manager.js");

    engineRun = vi.fn(async (opts: { prompt: string; sessionId?: string }): Promise<EngineResult> => {
      // The process dies in the middle of the turn: nobody called kill().
      if (opts.sessionId && diesOnNextRun.delete(opts.sessionId)) return { sessionId: "engine-parent", result: "", error: "Interrupted: claude process exited" };
      return { sessionId: "engine-parent", result: `報告を受け取りました (${engineRun.mock.calls.length})`, numTurns: 1 };
    });
    const sessionManager = new SessionManager(STUB_CONFIG, new Map<string, Engine>([["claude", { name: "claude", run: engineRun } as unknown as Engine]]), ["slack"]);

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
      void api.handleApiRequest(req, res, context as any);
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
  });

  beforeEach(() => {
    engineRun.mockClear();
    replyMessage.mockClear();
    diesOnNextRun.clear();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("a parent whose Claude process died mid-turn still gets the completions that follow", async () => {
    const parent = slackParent();
    diesOnNextRun.add(parent.id);

    // The first child finishes, and the turn it wakes the parent for dies.
    complete(parent, "researcher", { result: "一次調査が終わりました" });
    await vi.waitFor(() => expect(registry.getSession(parent.id)?.status).toBe("error"), { timeout: 10_000 });
    expect(registry.getSession(parent.id)?.lastError).toBe("claude stopped unexpectedly: claude process exited");
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();

    // Two more children finish, one after the other. Each must reach the parent.
    const second = complete(parent, "analyst", { result: "数値の分析が終わりました" });
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(registry.getSession(parent.id)?.status).toBe("idle"), { timeout: 5_000 });
    const third = complete(parent, "writer", { result: "下書きができました" });
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(2), { timeout: 5_000 });

    // One turn each, on the parent's own engine thread, answered in its Slack thread.
    expect(engineRun).toHaveBeenCalledTimes(3);
    expect(prompts()[1]).toContain(`replied in session ${second.id}`);
    expect(prompts()[2]).toContain(`replied in session ${third.id}`);
    expect((engineRun.mock.calls[1][0] as { resumeSessionId?: string }).resumeSessionId).toBe("engine-parent");
    for (const [target] of replyMessage.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(target).toMatchObject({ channel: "C_TEAM", thread: (parent.replyContext as { thread: string }).thread });
    }
    expect(notifications(parent.id)).toHaveLength(3);
    await vi.waitFor(() => expect(registry.getSession(parent.id)).toMatchObject({ status: "idle", lastError: null }), { timeout: 5_000 });
  }, 30_000);

  it("a parent stopped by a usage limit is not woken, and finds what its children reported in its transcript", async () => {
    const parent = slackParent();
    const limit = "claude usage limit reached. It resets Mon, 19 Oct, 03:00 (2026-10-19T03:00:00.000Z), which is too far off to wait for. Please try again after that.";
    registry.updateSession(parent.id, { status: "error", lastError: limit });

    const first = complete(parent, "researcher", { result: "一次調査が終わりました" });
    const second = complete(parent, "analyst", { error: "Something broke" });

    await vi.waitFor(() => expect(notifications(parent.id)).toHaveLength(2), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 300));

    // No turn was started: it would have failed on the limit, once per child.
    expect(engineRun).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
    expect(registry.getQueueItems(parent.sessionKey)).toEqual([]);
    expect(registry.getSession(parent.id)).toMatchObject({ status: "error", lastError: limit });
    // Both reports are in the transcript, each marked as not acted on.
    const notes = notifications(parent.id).map((m) => m.content);
    expect(notes.some((note) => note.includes(`replied in session ${first.id}`) && note.includes("Preview: 一次調査が終わりました"))).toBe(true);
    expect(notes.some((note) => note.includes(`(session ${second.id}) encountered an error: Something broke`))).toBe(true);
    for (const note of notes) expect(note).toContain("no turn was started");
    // … which is what the parent reads when it next runs.
    const transcript = await (await fetch(`${baseUrl}/api/sessions/${parent.id}?last=10`)).json() as { messages: Array<{ role: string; content: string }> };
    expect(transcript.messages.filter((m) => m.role === "notification").map((m) => m.content)).toEqual(notes);
  }, 30_000);

  // When the message saying that a turn failed cannot be delivered either, the
  // record of the lost message takes lastError. What the turn had failed with
  // must still decide whether the parent is woken.
  describe("when the parent's error message could not be delivered either", () => {
    /** A parent as its failed turn leaves it, once its error message was lost as well. */
    function parentWhoseErrorWasLost(turnError: string): Session {
      const parent = slackParent();
      registry.updateSession(parent.id, { status: "error", lastError: turnError });
      originDelivery.recordFailedOriginDelivery(registry.getSession(parent.id)!, undefined, "connector offline");
      const settled = registry.getSession(parent.id)!;
      expect(originDelivery.hasUndeliveredReply(settled)).toBe(true);
      expect(settled.lastError).not.toBe(turnError); // lastError is the record now
      return settled;
    }

    it("still wakes a parent whose engine had only died", async () => {
      const parent = parentWhoseErrorWasLost("claude stopped unexpectedly: claude process exited");

      const finished = complete(parent, "researcher", { result: "調査が終わりました" });

      await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(engineRun).toHaveBeenCalledTimes(1);
      expect(prompts()[0]).toContain(`replied in session ${finished.id}`);
      await vi.waitFor(() => expect(registry.getSession(parent.id)).toMatchObject({ status: "idle", lastError: null }), { timeout: 5_000 });
    }, 30_000);

    it("still does not wake a parent stopped by a lost login", async () => {
      const parent = parentWhoseErrorWasLost("Not logged in · Please run /login");
      const before = notifications(parent.id).length;

      complete(parent, "researcher", { result: "調査が終わりました" });

      await vi.waitFor(() => expect(notifications(parent.id)).toHaveLength(before + 1), { timeout: 5_000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(engineRun).not.toHaveBeenCalled();
      expect(replyMessage).not.toHaveBeenCalled();
      expect(notifications(parent.id).at(-1)!.content).toContain("no turn was started");
    }, 30_000);
  });
});
