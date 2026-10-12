import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// A Slack turn runs on the connector path and owns no queue row, so nothing
// replayed it after a restart: the thread the user was waiting in went silent,
// with no reply and no notice. The boot nudge wakes such a session through the
// notification route, whose reply is delivered to the conversation the session
// came from.
//
// Real registry, real /message route, real restart-resume module (including
// its authenticated POST); only the engine and the Slack connector are fakes.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "restart-resume-home-"));

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

describe("restart resume — a Slack session interrupted mid-turn is nudged and answers in its own thread", () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let engineRun: ReturnType<typeof vi.fn>;
  let replyMessage: ReturnType<typeof vi.fn>;
  let registry: typeof import("../../sessions/registry.js");
  let restartResume: typeof import("../../sessions/restart-resume.js");
  let api: typeof import("../api.js");
  let sessionManager: import("../../sessions/manager.js").SessionManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any;
  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    api = await import("../api.js");
    const { handleApiRequest } = api;
    registry = await import("../../sessions/registry.js");
    restartResume = await import("../../sessions/restart-resume.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const { ensureGatewayAuthToken } = await import("../auth.js");
    // The gateway mints this at boot; the nudge must present it like every other internal caller.
    ensureGatewayAuthToken(process.env.RYOKO_HOME!);

    engineRun = vi.fn(async () => ({ result: "再起動で中断していたデプロイを確認しました。完了しています。", sessionId: "engine-resumed", numTurns: 1 }));
    sessionManager = new SessionManager(STUB_CONFIG, new Map<string, Engine>([["claude", { run: engineRun } as unknown as Engine]]), ["slack"]);

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
      handleApiRequest(req, res, context);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // Fail closed: nothing in this suite may reach any other gateway.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${baseUrl}/`)) throw new Error(`test attempted to reach ${url}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, authorization: headers.Authorization, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  /** A Slack conversation as a graceful shutdown leaves it once the killed connector turn has settled. */
  function interruptedSlackSession(thread: string): { sessionId: string; interruptedAt: string } {
    const session = registry.createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_DEPLOY",
      connector: "slack",
      sessionKey: `slack:C_DEPLOY:${thread}`,
      replyContext: { channel: "C_DEPLOY", thread },
      transportMeta: { channelExternal: false },
      prompt: "本番にデプロイして",
    });
    // The connector turn: its request recorded, the engine at work…
    registry.insertMessage(session.id, "user", "本番にデプロイして");
    registry.updateSession(session.id, { status: "running", engineSessionId: "engine-before-restart" });
    // …the gateway shuts down, and the killed turn's completion writes idle over the shutdown status.
    restartResume.interruptRunningSessionsForShutdown();
    registry.updateSession(session.id, { status: "idle", lastError: null });
    const interruptedAt = restartResume.readRestartResumeState(registry.getSession(session.id)!.transportMeta).interruptedAt!;
    return { sessionId: session.id, interruptedAt };
  }

  const bootDeps = () => ({
    config: STUB_CONFIG,
    port,
    queue: sessionManager.getQueue(),
    // No stagger in the test: run the first (and only) nudge right away.
    schedule: (run: () => Promise<void>) => { void run(); },
  });

  /**
   * The nudge takes the mark off once its POST has returned, which can be after
   * the turn it started has already settled. Every test shares one registry, so
   * a test that ends on a nudge waits for this: left behind, the mark is counted
   * by the next test's boot.
   */
  const markConsumed = (sessionId: string): Promise<void> => vi.waitFor(
    () => expect(restartResume.readRestartResumeState(registry.getSession(sessionId)!.transportMeta).interruptedAt).toBeUndefined(),
    { timeout: 10_000 },
  );

  it("boot → one nudge turn → the reply lands in the original channel and thread", async () => {
    const { sessionId, interruptedAt } = interruptedSlackSession("111.222");
    expect(interruptedAt).toEqual(expect.any(String));

    const summary = restartResume.resumeRestartInterruptedSessions(bootDeps());
    expect(summary).toMatchObject({ planned: 1, skipped: 0, deferred: 0 });

    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    // The wake-up went to this gateway's own notification route, authenticated.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${baseUrl}/api/sessions/${sessionId}/message`);
    expect(requests[0].authorization).toMatch(/^Bearer .+/);
    expect(requests[0].body).toMatchObject({ role: "notification", dedupeKey: `restart-resume:${sessionId}:${interruptedAt}` });

    // The engine was resumed on the session's own engine thread, with the nudge as its prompt.
    expect(engineRun).toHaveBeenCalledTimes(1);
    const opts = engineRun.mock.calls[0][0] as { prompt: string; resumeSessionId?: string };
    expect(opts.prompt.startsWith(restartResume.RESTART_NUDGE_PREFIX)).toBe(true);
    expect(opts.prompt).toContain("Do NOT trigger it again");
    expect(opts.resumeSessionId).toBe("engine-before-restart");

    // Delivery target = where the conversation lives, not the web runner.
    const [target, text] = replyMessage.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toMatchObject({ channel: "C_DEPLOY", thread: "111.222" });
    expect(text).toBe("再起動で中断していたデプロイを確認しました。完了しています。");

    // The mark is consumed and the nudge is on record for the loop guard.
    await vi.waitFor(() => expect(restartResume.readRestartResumeState(registry.getSession(sessionId)!.transportMeta).nudgedAt).toHaveLength(1));
    expect(restartResume.readRestartResumeState(registry.getSession(sessionId)!.transportMeta).interruptedAt).toBeUndefined();
    expect(registry.getMessages(sessionId).filter((m) => m.role === "notification" && m.content.startsWith(restartResume.RESTART_NUDGE_PREFIX))).toHaveLength(1);

    // A second boot has nothing left to nudge.
    await vi.waitFor(() => expect(registry.getSession(sessionId)?.status).toBe("idle"));
    expect(restartResume.resumeRestartInterruptedSessions(bootDeps())).toMatchObject({ planned: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it("a reply that was recorded but never posted is asked for again, and reaches the thread this time", async () => {
    engineRun.mockClear();
    replyMessage.mockClear();
    requests.length = 0;
    const session = registry.createSession({
      engine: "claude", source: "slack", sourceRef: "C_DEPLOY", connector: "slack", sessionKey: "slack:C_DEPLOY:999.000",
      replyContext: { channel: "C_DEPLOY", thread: "999.000" }, transportMeta: { channelExternal: false }, prompt: "本番にデプロイして",
    });
    // The connector turn finished its work and recorded the reply; the post was still in flight…
    registry.insertMessage(session.id, "user", "本番にデプロイして");
    registry.insertMessage(session.id, "assistant", "デプロイが完了しました。");
    registry.updateSession(session.id, { status: "running", engineSessionId: "engine-before-restart" });
    // …when the gateway shut down, and the process was gone before the turn could write its final status.
    restartResume.interruptRunningSessionsForShutdown();
    expect(registry.getSession(session.id)?.status).toBe("interrupted");
    expect(restartResume.readRestartResumeState(registry.getSession(session.id)!.transportMeta)).toMatchObject({ replyRecorded: true });
    // The model does what the nudge asks: it answers with the same reply.
    engineRun.mockImplementationOnce(async () => ({ result: "デプロイが完了しました。", sessionId: "engine-resumed", numTurns: 1 }));

    expect(restartResume.resumeRestartInterruptedSessions(bootDeps())).toMatchObject({ planned: 1, skipped: 0 });

    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const prompt = (engineRun.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt.startsWith(restartResume.RESTART_NUDGE_PREFIX)).toBe(true);
    expect(prompt).toContain("none of it, or only the beginning");
    expect(prompt).toContain("Send what is missing");
    expect(prompt).not.toContain("Pick the request back up");
    const [target, text] = replyMessage.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toMatchObject({ channel: "C_DEPLOY", thread: "999.000" });
    expect(text).toBe("デプロイが完了しました。");
    await vi.waitFor(() => expect(registry.getSession(session.id)?.status).toBe("idle"));
    await markConsumed(session.id);
  });

  it("a reply whose delivery failed during the shutdown is asked for too, and its record is cleared once it lands", async () => {
    engineRun.mockClear();
    replyMessage.mockClear();
    requests.length = 0;
    const { hasUndeliveredReply, recordFailedOriginDelivery } = await import("../../sessions/origin-delivery.js");
    const session = registry.createSession({
      engine: "claude", source: "slack", sourceRef: "C_DEPLOY", connector: "slack", sessionKey: "slack:C_DEPLOY:888.000",
      replyContext: { channel: "C_DEPLOY", thread: "888.000" }, transportMeta: { channelExternal: false }, prompt: "本番にデプロイして",
    });
    // The connector turn finished its work and recorded the reply; the post was in flight when the gateway shut down…
    registry.insertMessage(session.id, "user", "本番にデプロイして");
    registry.insertMessage(session.id, "assistant", "デプロイが完了しました。手順書も更新済みです。");
    registry.updateSession(session.id, { status: "running", engineSessionId: "engine-before-restart" });
    restartResume.interruptRunningSessionsForShutdown();
    // …and this time the post came back — as a failure, after the first of its two chunks. The turn's
    // completion settles it as a finished turn and puts the lost reply on record.
    registry.updateSession(session.id, { status: "idle", lastError: null });
    recordFailedOriginDelivery(registry.getSession(session.id)!, undefined, "Slack replyMessage: only 1 of 2 chunks were delivered (socket closed)");
    expect(registry.getSession(session.id)).toMatchObject({ status: "idle" });
    // The model does what the nudge asks: it sends the part that is missing.
    engineRun.mockImplementationOnce(async () => ({ result: "手順書も更新済みです。", sessionId: "engine-resumed", numTurns: 1 }));

    expect(restartResume.resumeRestartInterruptedSessions(bootDeps())).toMatchObject({ planned: 1, skipped: 0 });

    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const prompt = (engineRun.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt.startsWith(restartResume.RESTART_NUDGE_PREFIX)).toBe(true);
    expect(prompt).toContain("none of it, or only the beginning");
    expect(prompt).toContain("Do not repost a part that is already there.");
    expect(prompt).not.toContain("Pick the request back up");
    const [target, text] = replyMessage.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toMatchObject({ channel: "C_DEPLOY", thread: "888.000" });
    expect(text).toBe("手順書も更新済みです。");
    await vi.waitFor(() => expect(registry.getSession(session.id)?.status).toBe("idle"));
    expect(hasUndeliveredReply(registry.getSession(session.id)!)).toBe(false);
    // Nothing left for a second boot.
    await vi.waitFor(() => expect(restartResume.readRestartResumeState(registry.getSession(session.id)!.transportMeta).interruptedAt).toBeUndefined());
    expect(restartResume.resumeRestartInterruptedSessions(bootDeps())).toMatchObject({ planned: 0 });
  });

  it("a session that finds its reply had arrived ends the nudge turn without a post", async () => {
    engineRun.mockClear();
    replyMessage.mockClear();
    requests.length = 0;
    const { hasUndeliveredReply, silentOriginAnswer } = await import("../../sessions/origin-delivery.js");
    const session = registry.createSession({
      engine: "claude", source: "slack", sourceRef: "C_DEPLOY", connector: "slack", sessionKey: "slack:C_DEPLOY:777.000",
      replyContext: { channel: "C_DEPLOY", thread: "777.000" }, transportMeta: { channelExternal: true }, prompt: "本番にデプロイして",
    });
    // The reply was recorded and the post in flight when the process went away — and the post had in fact landed.
    registry.insertMessage(session.id, "user", "本番にデプロイして");
    registry.insertMessage(session.id, "assistant", "デプロイが完了しました。");
    registry.updateSession(session.id, { status: "running", engineSessionId: "engine-before-restart" });
    restartResume.interruptRunningSessionsForShutdown();
    const silent = silentOriginAnswer(registry.getSession(session.id)!)!;
    // The model checks the thread, sees its reply there, and ends the way the nudge tells it to.
    engineRun.mockImplementationOnce(async () => ({ result: `スレッドを確認: 返信は届いていた。\n\n${silent}`, sessionId: "engine-resumed", numTurns: 1 }));

    expect(restartResume.resumeRestartInterruptedSessions(bootDeps())).toMatchObject({ planned: 1, skipped: 0 });

    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // The nudge handed the session that line, on a line of its own.
    expect((engineRun.mock.calls[0][0] as { prompt: string }).prompt.split("\n")).toContain(silent);
    await vi.waitFor(() => expect(registry.getSession(session.id)?.status).toBe("idle"), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    // Nothing went to the customer's thread — not the remark, not the trailer.
    expect(replyMessage).not.toHaveBeenCalled();
    // A post that was deliberately not made is not a failed delivery.
    expect(hasUndeliveredReply(registry.getSession(session.id)!)).toBe(false);
    expect(registry.getMessages(session.id).filter((m) => m.role === "notification" && m.content.includes("NOT delivered"))).toEqual([]);
    await markConsumed(session.id);
  });

  it("a session the queue replay already re-dispatched is not resumed a second time", async () => {
    engineRun.mockClear();
    replyMessage.mockClear();
    requests.length = 0;
    const { sessionId } = interruptedSlackSession("333.444");
    const key = registry.getSession(sessionId)!.sessionKey;
    // What resumePendingWebQueueItems leaves behind for a replayed wake-up:
    // the session is running again and its queue slot is taken.
    registry.updateSession(sessionId, { status: "running" });
    let finish!: () => void;
    const replayed = sessionManager.getQueue().enqueue(key, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(sessionManager.getQueue().isRunning(key)).toBe(true));

    expect(restartResume.resumeRestartInterruptedSessions(bootDeps())).toMatchObject({ planned: 0, skipped: 1 });

    await new Promise((r) => setTimeout(r, 300));
    expect(requests).toEqual([]);
    expect(engineRun).not.toHaveBeenCalled();
    expect(restartResume.readRestartResumeState(registry.getSession(sessionId)!.transportMeta).interruptedAt).toBeUndefined();
    finish();
    await replayed;
    registry.updateSession(sessionId, { status: "idle" }); // the replayed turn settles
  });
  it("the boot sequence, in the order startGateway runs it, resumes each interrupted session exactly once", async () => {
    engineRun.mockClear();
    replyMessage.mockClear();
    requests.length = 0;
    const lastAlive = new Date(Date.now() - 60_000).toISOString();

    // (a) A Slack turn the previous process was killed in: still "running", no queue row.
    const slack = registry.createSession({
      engine: "claude", source: "slack", sourceRef: "C_DEPLOY", connector: "slack", sessionKey: "slack:C_DEPLOY:555.666",
      replyContext: { channel: "C_DEPLOY", thread: "555.666" }, transportMeta: { channelExternal: false }, prompt: "ログを調べて",
    });
    registry.insertMessage(slack.id, "user", "ログを調べて");
    registry.updateSession(slack.id, { status: "running", lastActivity: lastAlive });

    // (b) A web turn killed the same way: its queue row was running, so the queue replays it.
    const web = registry.createSession({
      engine: "claude", source: "web", sourceRef: "web:boot-order", connector: "web", sessionKey: "web:boot-order",
      replyContext: { source: "web" }, prompt: "レポートを作って",
    });
    registry.insertMessage(web.id, "user", "レポートを作って");
    const webRow = registry.enqueueQueueItem(web.id, web.sessionKey, "レポートを作って");
    registry.markQueueItemRunning(webRow);
    registry.updateSession(web.id, { status: "running", lastActivity: lastAlive });

    // (c) A session whose restart nudge was itself in flight — the turn that may have restarted the gateway.
    const looping = registry.createSession({
      engine: "claude", source: "slack", sourceRef: "C_DEPLOY", connector: "slack", sessionKey: "slack:C_DEPLOY:777.888",
      replyContext: { channel: "C_DEPLOY", thread: "777.888" }, prompt: "アップデートして",
    });
    const nudgedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const nudgeText = restartResume.restartResumeMessage(looping, new Date(Date.now() - 3 * 60_000).toISOString());
    registry.insertMessage(looping.id, "notification", nudgeText);
    const nudgeRow = registry.enqueueQueueItem(looping.id, looping.sessionKey, nudgeText);
    registry.markQueueItemRunning(nudgeRow);
    registry.updateSession(looping.id, {
      status: "running", lastActivity: lastAlive,
      transportMeta: { [restartResume.RESTART_RESUME_META_KEY]: { nudgedAt: [nudgedAt] } },
    });

    // startGateway, boot half:
    expect(restartResume.prepareRestartResume()).toEqual({ marked: 3, cancelledNudges: 1 });
    expect(registry.recoverStaleSessions()).toBe(3);
    registry.recoverStaleQueueItems();
    api.resumePendingWebQueueItems(context);
    const summary = restartResume.resumeRestartInterruptedSessions(bootDeps());

    // (a) is nudged; (b) was replayed and (c) falls under the loop guard.
    expect(summary).toMatchObject({ planned: 1, skipped: 2 });
    await vi.waitFor(() => expect(engineRun).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));

    const prompts = engineRun.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
    expect(prompts.filter((prompt) => prompt === "レポートを作って")).toHaveLength(1); // (b): its own prompt, once
    expect(prompts.filter((prompt) => prompt.startsWith(restartResume.RESTART_NUDGE_PREFIX))).toHaveLength(1); // (a): one nudge
    expect(engineRun).toHaveBeenCalledTimes(2); // (c): nothing ran
    expect(requests.map((request) => request.url)).toEqual([`${baseUrl}/api/sessions/${slack.id}/message`]);
    expect(replyMessage.mock.calls[0][0]).toMatchObject({ channel: "C_DEPLOY", thread: "555.666" });
    expect(registry.getQueueItem(nudgeRow)?.status).toBe("cancelled");
    for (const session of [slack, web, looping]) {
      await vi.waitFor(() => expect(restartResume.readRestartResumeState(registry.getSession(session.id)!.transportMeta).interruptedAt).toBeUndefined());
    }
    expect(registry.getSession(looping.id)?.status).toBe("interrupted"); // left for the operator
  });
});
