import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// Regression pin for issue #38 follow-up: a session woken by a notification
// (detached job finished) runs on the gateway's connector-less web path. Its
// final answer MUST come back to the original Slack channel/thread stored in
// reply_context — the 2026-08-04 accident left an externally-shared customer
// thread waiting on "生成中です" forever.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wake-test-home-"));

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

describe("notification wake-up delivers the reply to the origin connector", () => {
  let server: http.Server;
  let baseUrl: string;
  let replyMessage: ReturnType<typeof vi.fn>;
  let sessionId: string;

  beforeAll(async () => {
    const { handleApiRequest } = await import("../api.js");
    const { createSession } = await import("../../sessions/registry.js");
    const { SessionManager } = await import("../../sessions/manager.js");

    const engineRun = vi.fn(async () => ({
      result: "資料が完成しました。アップロード済みです。",
      sessionId: "engine-sess-1",
      numTurns: 1,
    }));
    const mockEngine = { run: engineRun } as unknown as Engine;
    const engines = new Map<string, Engine>([["claude", mockEngine]]);
    const sessionManager = new SessionManager(STUB_CONFIG, engines, ["slack"]);

    replyMessage = vi.fn(async () => "posted-ts");
    const fakeSlack = {
      name: "slack",
      replyMessage,
      addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({
        channel: typeof rc.channel === "string" ? rc.channel : "",
        thread: typeof rc.thread === "string" ? rc.thread : undefined,
        messageTs: typeof rc.messageTs === "string" ? rc.messageTs : undefined,
      }),
    } as unknown as Connector;

    const session = createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_EXTERNAL",
      connector: "slack",
      sessionKey: "slack:C_EXTERNAL:100.200",
      replyContext: { channel: "C_EXTERNAL", thread: "100.200", messageTs: "100.300" },
      transportMeta: { channelExternal: true },
      prompt: "資料を作って",
    });
    sessionId = session.id;

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
    baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("wakes the session and replies into the original channel/thread", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: '✅ Detached job "pdf-build" completed successfully (exit 0).',
        role: "notification",
      }),
    });
    expect(res.status).toBe(200);

    // The engine run + delivery happen asynchronously after the 200.
    await vi.waitFor(() => {
      expect(replyMessage).toHaveBeenCalledTimes(1);
    }, { timeout: 10_000 });

    const [target, text] = replyMessage.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toMatchObject({ channel: "C_EXTERNAL", thread: "100.200" });
    expect(text).toBe("資料が完成しました。アップロード済みです。");
  });

  it("a duplicate dedupeKey does not enqueue a second turn (monitor retry after lost response)", async () => {
    replyMessage.mockClear();
    const body = JSON.stringify({
      message: '✅ Detached job "dedupe-job" completed successfully (exit 0).',
      role: "notification",
      dedupeKey: "job:dedupe-job-1",
    });
    const first = await fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe("queued");

    const second = await fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("duplicate");

    await vi.waitFor(() => {
      expect(replyMessage).toHaveBeenCalledTimes(1); // one turn, one delivery
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 1000));
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it("a plain user message on the web path does NOT auto-post to the connector", async () => {
    replyMessage.mockClear();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "operator typing in web UI", role: "user" }),
    });
    expect(res.status).toBe(200);

    // Give the async run time to complete, then confirm no connector post.
    await new Promise((r) => setTimeout(r, 1500));
    expect(replyMessage).not.toHaveBeenCalled();
  });
});
