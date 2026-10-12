import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig, Session } from "../../shared/types.js";

// A parent that delegates to N children used to run N turns when they
// finished — one queue row and one engine turn per notification — and a
// Slack-origin parent posted into its thread N times. Completions that arrive
// while the parent is busy now share the pending tail row, so the parent runs
// one turn for all of them.
//
// Real registry, real callbacks.ts (authenticated POST), real /message route;
// only the engine and the Slack connector are fakes.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "completion-batching-home-"));

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

const BUSY_PROMPT = "3人に調査を頼んで、まとめて";

describe("child completion notifications are batched for a busy parent", () => {
  let server: http.Server;
  let baseUrl: string;
  let engineRun: ReturnType<typeof vi.fn>;
  let replyMessage: ReturnType<typeof vi.fn>;
  let registry: typeof import("../../sessions/registry.js");
  let callbacks: typeof import("../../sessions/callbacks.js");
  let batching: typeof import("../../sessions/completion-batching.js");
  let restartResume: typeof import("../../sessions/restart-resume.js");
  let api: typeof import("../api.js");
  let port: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any;
  let releaseBusyTurn: () => void = () => {};
  let thread = 0;
  const realFetch = globalThis.fetch;

  const prompts = () => engineRun.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
  const notifications = (sessionId: string) => registry.getMessages(sessionId).filter((m) => m.role === "notification");
  const pendingRows = (session: Session) => registry.getQueueItems(session.sessionKey).filter((item) => item.status === "pending");

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
      prompt: BUSY_PROMPT,
    });
  }

  function child(parent: Session, employee: string): Session {
    const key = `web:${parent.id}:${employee}`;
    return registry.createSession({ engine: "claude", source: "web", sourceRef: key, connector: "web", sessionKey: key, replyContext: { source: "web" }, employee, parentSessionId: parent.id });
  }

  /** Put the parent in a turn that stays inside the engine until released. */
  async function occupy(parent: Session): Promise<void> {
    const res = await fetch(`${baseUrl}/api/sessions/${parent.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: BUSY_PROMPT, role: "user" }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  }

  /** A child finishes: the real callback path, awaited until the gateway has accepted it. */
  async function complete(parent: Session, employee: string, result: { result?: string; error?: string }): Promise<Session> {
    const before = notifications(parent.id).length;
    const finished = child(parent, employee);
    callbacks.notifyParentSession(finished, result);
    await vi.waitFor(() => expect(notifications(parent.id)).toHaveLength(before + 1), { timeout: 10_000 });
    return finished;
  }

  beforeAll(async () => {
    api = await import("../api.js");
    registry = await import("../../sessions/registry.js");
    callbacks = await import("../../sessions/callbacks.js");
    batching = await import("../../sessions/completion-batching.js");
    restartResume = await import("../../sessions/restart-resume.js");
    const { SessionManager } = await import("../../sessions/manager.js");

    engineRun = vi.fn(async (opts: { prompt: string }) => {
      if (opts.prompt === BUSY_PROMPT) await new Promise<void>((resolve) => { releaseBusyTurn = resolve; });
      return { result: `確認しました: ${opts.prompt.slice(0, 12)}`, sessionId: "engine-parent", numTurns: 1 };
    });
    const sessionManager = new SessionManager(STUB_CONFIG, new Map<string, Engine>([["claude", { run: engineRun } as unknown as Engine]]), ["slack"]);

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

    context = {
      config: STUB_CONFIG,
      getConfig: () => STUB_CONFIG,
      sessionManager,
      startTime: 0,
      emit: () => {},
      connectors: new Map([["slack", fakeSlack]]),
    };
    server = http.createServer((req, res) => {
      api.handleApiRequest(req, res, context);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
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
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("three children finish while the parent is busy → the parent runs ONE turn for all three", async () => {
    const parent = slackParent();
    await occupy(parent);

    const children = [
      await complete(parent, "researcher", { result: "競合A社の調査が終わりました" }),
      await complete(parent, "analyst", { result: "数値の分析が終わりました" }),
      await complete(parent, "writer", { result: "下書きができました" }),
    ];

    // Every completion is on record in the transcript, but they share one queue row.
    expect(notifications(parent.id)).toHaveLength(3);
    expect(pendingRows(parent)).toHaveLength(1);
    expect(engineRun).toHaveBeenCalledTimes(1); // still only the turn the parent was busy with

    releaseBusyTurn();
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));

    // One more turn — not three — and it carries all three completions, in order.
    expect(engineRun).toHaveBeenCalledTimes(2);
    const batch = prompts()[1];
    expect(batch).toContain("3 child-session updates");
    for (const finished of children) expect(batch).toContain(`session ${finished.id}`);
    expect(batch.indexOf(children[0].id)).toBeLessThan(batch.indexOf(children[1].id));
    expect(batch.indexOf(children[1].id)).toBeLessThan(batch.indexOf(children[2].id));
    expect(batch).toContain("下書きができました");
    // …and the Slack thread hears about them once.
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage.mock.calls[0][0]).toMatchObject({ channel: "C_TEAM", thread: parent.replyContext!.thread });
    expect(pendingRows(parent)).toHaveLength(0);
  });

  it("a failed child is never folded in: it gets its own turn, in arrival order", async () => {
    const parent = slackParent();
    await occupy(parent);

    const ok = await complete(parent, "researcher", { result: "調査が終わりました" });
    const failed = await complete(parent, "analyst", { error: "API quota exceeded" });
    const late = await complete(parent, "writer", { result: "下書きができました" });

    // success | failure | success — the failure is a fence, nothing reaches past it.
    expect(pendingRows(parent)).toHaveLength(3);

    releaseBusyTurn();
    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(4), { timeout: 10_000 });

    const [, first, second, third] = prompts();
    expect(first.startsWith(`📩 Employee "researcher" replied in session ${ok.id}`)).toBe(true);
    expect(second).toBe(`⚠️ Employee "analyst" (session ${failed.id}) encountered an error: API quota exceeded`);
    expect(third.startsWith(`📩 Employee "writer" replied in session ${late.id}`)).toBe(true);
    for (const prompt of [first, second, third]) expect(prompt).not.toContain("child-session updates");
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(3), { timeout: 10_000 });
  });

  it("an idle parent is woken at once; only what arrives during that turn is batched", async () => {
    const parent = slackParent();
    // Hold the first notification turn in the engine so the next two arrive while it runs.
    let releaseFirst!: () => void;
    engineRun.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return { result: "1件目を確認しました", sessionId: "engine-parent", numTurns: 1 };
    });

    const first = await complete(parent, "researcher", { result: "調査が終わりました" });
    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(prompts()[0].startsWith(`📩 Employee "researcher" replied in session ${first.id}`)).toBe(true);

    await complete(parent, "analyst", { result: "分析が終わりました" });
    await complete(parent, "writer", { result: "下書きができました" });
    expect(pendingRows(parent)).toHaveLength(1);

    releaseFirst();
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(engineRun).toHaveBeenCalledTimes(2);
    expect(prompts()[1]).toContain("2 child-session updates");
  });

  it("a completion that arrives after the parent was stopped is not swallowed by the batch the stop cancelled", async () => {
    const parent = slackParent();
    await occupy(parent);
    await complete(parent, "researcher", { result: "停止前に終わりました" });
    expect(pendingRows(parent)).toHaveLength(1);

    // The operator stops the parent: everything queued at this moment is cancelled.
    const stop = await fetch(`${baseUrl}/api/sessions/${parent.id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);

    // The busy turn has not unwound yet, so the cancelled row is still "pending"
    // in the database. A completion arriving now is new work and must run.
    const late = await complete(parent, "writer", { result: "停止後に終わりました" });
    releaseBusyTurn();

    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(engineRun).toHaveBeenCalledTimes(2); // the busy turn + the one for the late completion
    expect(prompts()[1].startsWith(`📩 Employee "writer" replied in session ${late.id}`)).toBe(true);
    expect(prompts()[1]).not.toContain("停止前に終わりました"); // what the stop cancelled stays cancelled
    expect(pendingRows(parent)).toHaveLength(0);
  });

  it("a completion that joins a batch nobody in this process is running dispatches it", async () => {
    const parent = slackParent();
    // A batch row a previous process left pending: no dispatcher holds it here.
    const orphaned = `📩 Employee "researcher" replied in session s-old.\nRead the latest messages: GET /api/sessions/s-old?last=N\n\nPreview: 再起動前に終わっていました`;
    registry.insertMessage(parent.id, "notification", orphaned);
    batching.acceptChildCompletion(parent.id, parent.sessionKey, orphaned);

    await complete(parent, "writer", { result: "下書きができました" });

    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).toContain("2 child-session updates");
    expect(prompts()[0]).toContain("再起動前に終わっていました");
    expect(prompts()[0]).toContain("下書きができました");
  });

  it("a batch left pending by a restart is replayed for a Slack-origin parent, into its thread", async () => {
    const parent = slackParent();
    const messages = ["researcher", "analyst"].map((employee) =>
      `📩 Employee "${employee}" replied in session s-${employee}.\nRead the latest messages: GET /api/sessions/s-${employee}?last=N\n\nPreview: ${employee} finished`);
    for (const message of messages) {
      registry.insertMessage(parent.id, "notification", message);
      batching.acceptChildCompletion(parent.id, parent.sessionKey, message);
    }
    expect(pendingRows(parent)).toHaveLength(1);

    api.resumePendingWebQueueItems(context);

    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).toBe(batching.completionBatchPrompt(messages));
    expect(replyMessage.mock.calls[0][0]).toMatchObject({ channel: "C_TEAM", thread: parent.replyContext!.thread });
  });

  it("a batch cut off by a graceful restart is not lost — its parent is nudged, even shortly after an earlier nudge", async () => {
    const parent = slackParent();
    // An earlier restart already nudged this parent a few minutes ago.
    registry.updateSession(parent.id, {
      transportMeta: { channelExternal: false, [restartResume.RESTART_RESUME_META_KEY]: { nudgedAt: [new Date(Date.now() - 5 * 60_000).toISOString()] } },
    });
    await occupy(parent);
    const children = [
      await complete(parent, "researcher", { result: "調査が終わりました" }),
      await complete(parent, "analyst", { result: "分析が終わりました" }),
    ];
    expect(pendingRows(parent)).toHaveLength(1);

    // The busy turn ends and the batch turn starts — and is still in the engine when the gateway shuts down.
    let killEngine!: (result: { sessionId: string; result: string; error: string }) => void;
    engineRun.mockImplementationOnce(() => new Promise((resolve) => { killEngine = resolve; }));
    releaseBusyTurn();
    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(prompts()[1]).toContain("2 child-session updates");

    // Graceful shutdown, as startGateway's cleanup does it: mark, then kill.
    expect(restartResume.interruptRunningSessionsForShutdown()).toBe(1);
    killEngine({ sessionId: "engine-parent", result: "", error: "Interrupted: gateway shutting down" });
    // The dying runner closes the batch row: nothing is left in the queue to replay.
    await vi.waitFor(() => expect(registry.getQueueItems(parent.sessionKey)).toHaveLength(0), { timeout: 10_000 });
    expect(replyMessage).not.toHaveBeenCalled();

    // The next boot, in startGateway's order.
    restartResume.prepareRestartResume();
    registry.recoverStaleSessions();
    registry.recoverStaleQueueItems();
    api.resumePendingWebQueueItems(context);
    const summary = restartResume.resumeRestartInterruptedSessions({
      config: STUB_CONFIG, port, queue: context.sessionManager.getQueue(), schedule: (run) => { void run(); },
    });

    // The two completions have no queue row any more, so the nudge is their only way back —
    // and the cooldown from the earlier nudge must not withhold it.
    expect(summary).toMatchObject({ planned: 1, skipped: 0 });
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(engineRun).toHaveBeenCalledTimes(3);
    expect(prompts()[2].startsWith(restartResume.RESTART_NUDGE_PREFIX)).toBe(true);
    expect(replyMessage.mock.calls[0][0]).toMatchObject({ channel: "C_TEAM", thread: parent.replyContext!.thread });
    // Both completions are still in the transcript the nudge sends the session back to.
    const transcript = notifications(parent.id).map((m) => m.content);
    for (const finished of children) expect(transcript.some((content) => content.includes(`replied in session ${finished.id}`))).toBe(true);
  });
});
