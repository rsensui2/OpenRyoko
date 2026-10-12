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
  function interruptedSlackSession(thread: string, interruptedAt: string) {
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
    registry.insertMessage(session.id, "user", "本番にデプロイして");
    registry.updateSession(session.id, {
      status: "idle",
      engineSessionId: "engine-before-restart",
      transportMeta: restartResume.withRestartInterruptedMark(session.transportMeta, interruptedAt),
    });
    return session.id;
  }

  const bootDeps = () => ({
    config: STUB_CONFIG,
    port,
    queue: sessionManager.getQueue(),
    // No stagger in the test: run the first (and only) nudge right away.
    schedule: (run: () => Promise<void>) => { void run(); },
  });

  it("boot → one nudge turn → the reply lands in the original channel and thread", async () => {
    const interruptedAt = new Date(Date.now() - 30_000).toISOString();
    const sessionId = interruptedSlackSession("111.222", interruptedAt);

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

  it("a session the queue replay already re-dispatched is not resumed a second time", async () => {
    engineRun.mockClear();
    replyMessage.mockClear();
    requests.length = 0;
    const sessionId = interruptedSlackSession("333.444", new Date(Date.now() - 30_000).toISOString());
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
