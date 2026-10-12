import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { EngineResult, EngineRunOpts, InterruptibleEngine, JinnConfig } from "../../shared/types.js";

// The web runner (dashboard chats, child sessions, notification wake-ups) took
// every "Interrupted: …" engine error for "a newer message took over": it left
// a calm notice, returned, and wrote no outcome at all. For a Claude process
// that had simply died, that meant a child session stuck at "running" and a
// parent that was never told — until the status reconciler noticed a minute
// later. An engine that stops without being asked is now a failed turn here
// too, settled at once, while the stops the gateway does ask for are unchanged.
//
// Real registry, real /message and /stop routes, real callbacks.ts; only the
// engine is a fake.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "web-unrequested-stop-home-"));

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

const FAILURE = "claude stopped unexpectedly: claude process exited";

describe("web runner — an engine that stops without being asked is a failed turn", () => {
  let server: http.Server;
  let baseUrl: string;
  let registry: typeof import("../../sessions/registry.js");
  const realFetch = globalThis.fetch;
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  /** Runs the fake engine is holding open, by session — as a live Claude turn would be. */
  const held = new Map<string, (result: EngineResult) => void>();
  const prompts: string[] = [];
  let sequence = 0;

  const engine = {
    name: "claude",
    run: vi.fn((opts: EngineRunOpts) => {
      prompts.push(opts.prompt);
      // The process dies in the middle of the turn: nobody called kill().
      if (opts.prompt.startsWith("DIE")) return Promise.resolve<EngineResult>({ sessionId: "native", result: "", error: "Interrupted: claude process exited" });
      if (opts.prompt.startsWith("HOLD")) return new Promise<EngineResult>((resolve) => { held.set(opts.sessionId!, resolve); });
      return Promise.resolve<EngineResult>({ sessionId: "native", result: `了解: ${opts.prompt.slice(0, 20)}`, numTurns: 1 });
    }),
    // What every real engine does when the gateway asks it to stop.
    kill: vi.fn((sessionId: string, reason = "Interrupted") => {
      const settle = held.get(sessionId);
      held.delete(sessionId);
      settle?.({ sessionId: "native", result: "", error: reason, interruptRequested: true });
    }),
    isAlive: (sessionId: string) => held.has(sessionId),
    killAll: vi.fn(),
  } satisfies InterruptibleEngine;

  const post = (pathname: string, body?: unknown) => fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  function webSession(overrides: { parentSessionId?: string; employee?: string } = {}) {
    const key = `web:stop-${++sequence}`;
    return registry.createSession({ engine: "claude", source: "web", sourceRef: key, connector: "web", sessionKey: key, replyContext: { source: "web" }, ...overrides });
  }

  beforeAll(async () => {
    const { handleApiRequest } = await import("../api.js");
    registry = await import("../../sessions/registry.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const sessionManager = new SessionManager(STUB_CONFIG, new Map([["claude", engine]]), []);
    const context = {
      config: STUB_CONFIG,
      getConfig: () => STUB_CONFIG,
      sessionManager,
      startTime: 0,
      emit: (event: string, payload: unknown) => { emitted.push({ event, payload: payload as Record<string, unknown> }); },
      connectors: new Map(),
    };
    server = http.createServer((req, res) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void handleApiRequest(req, res, context as any);
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
    engine.run.mockClear();
    engine.kill.mockClear();
    prompts.length = 0;
    emitted.length = 0;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("a child whose Claude process died is settled as an error at once, and its parent is told", async () => {
    const parent = webSession();
    const child = webSession({ parentSessionId: parent.id, employee: "worker" });

    expect((await post(`/api/sessions/${child.id}/message`, { message: "DIE: 競合を調べて" })).status).toBe(200);

    await vi.waitFor(() => expect(registry.getSession(child.id)?.status).toBe("error"), { timeout: 10_000 });
    expect(registry.getSession(child.id)?.lastError).toBe(FAILURE);
    expect(emitted).toContainEqual({ event: "session:completed", payload: expect.objectContaining({ sessionId: child.id, error: FAILURE }) });
    // No "a newer message took over" notice: nothing took over.
    expect(registry.getMessages(child.id).map((m) => m.content)).not.toContain("🔄 新しいメッセージを踏まえて再検討");
    // The parent is woken through the normal callback, with the failure.
    await vi.waitFor(() => expect(prompts.some((prompt) => prompt.includes(`(session ${child.id}) encountered an error: ${FAILURE}`))).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(registry.getSession(parent.id)?.status).toBe("idle"), { timeout: 10_000 });
  });

  it("a turn a newer message interrupts is still not an error", async () => {
    const session = webSession();
    expect((await post(`/api/sessions/${session.id}/message`, { message: "HOLD: 長い調査" })).status).toBe(200);
    await vi.waitFor(() => expect(held.has(session.id)).toBe(true), { timeout: 10_000 });

    expect((await post(`/api/sessions/${session.id}/message`, { message: "やっぱりこちらを先に" })).status).toBe(200);

    expect(engine.kill).toHaveBeenCalledExactlyOnceWith(session.id, "Interrupted: new message received");
    await vi.waitFor(() => expect(prompts).toContain("やっぱりこちらを先に"), { timeout: 10_000 });
    await vi.waitFor(() => expect(registry.getSession(session.id)?.status).toBe("idle"), { timeout: 10_000 });
    const settled = registry.getSession(session.id)!;
    expect(settled.lastError).toBeNull();
    const transcript = registry.getMessages(session.id).map((m) => m.content);
    expect(transcript).toContain("🔄 新しいメッセージを踏まえて再検討");
    expect(transcript.some((content) => content.includes("stopped unexpectedly"))).toBe(false);
    expect(emitted.filter((e) => e.event === "session:completed" && e.payload.error)).toEqual([]);
  });

  it("a turn the operator stops is still not an error", async () => {
    const session = webSession();
    expect((await post(`/api/sessions/${session.id}/message`, { message: "HOLD: 長い調査" })).status).toBe(200);
    await vi.waitFor(() => expect(held.has(session.id)).toBe(true), { timeout: 10_000 });

    expect((await post(`/api/sessions/${session.id}/stop`)).status).toBe(200);

    expect(engine.kill).toHaveBeenCalledExactlyOnceWith(session.id, "Interrupted by user");
    await new Promise((r) => setTimeout(r, 300));
    const settled = registry.getSession(session.id)!;
    expect(settled.status).toBe("idle");
    expect(settled.lastError).toBeNull();
    expect(emitted.filter((e) => e.event === "session:completed" && e.payload.error)).toEqual([]);
  });
});
