import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
  insertMessage: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: { port: 7777 } })),
}));

import { loadConfig } from "../../shared/config.js";

vi.mock("../../gateway/auth.js", () => ({
  readGatewayAuthToken: vi.fn(() => "test-token"),
}));

vi.mock("../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/jinn-home",
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { notifyParentSession, notifyDiscordChannel, notifyRateLimited } from "../callbacks.js";
import { logger } from "../../shared/logger.js";
import { readGatewayAuthToken } from "../../gateway/auth.js";
import { getSession, insertMessage } from "../registry.js";
import { unrequestedStopError } from "../unrequested-stop.js";
import type { Session } from "../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "child-001",
    engine: "claude",
    engineSessionId: null,
    source: "api",
    sourceRef: "api:test",
    connector: null,
    sessionKey: "test-key",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "test-employee",
    model: "opus",
    title: null,
    parentSessionId: "parent-001",
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    // `overrides` was declared but never applied, so every makeSession(...) argument in
    // this file was silently ignored — tests that meant to exercise a null parentSessionId
    // or an errored parent were passing for unrelated reasons.
    ...overrides,
  } as Session;
}

const originalFetch = globalThis.fetch;

describe("notifyParentSession — no parent", () => {
  it("does nothing if child has no parentSessionId", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    const child = makeSession({ parentSessionId: null });
    notifyParentSession(child, { result: "done" });

    await new Promise((r) => setTimeout(r, 150));
    expect(spy).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});

describe("notifyParentSession", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it('sends success notification saying "replied in session" with API pointer', async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "Some result" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");

    const body = JSON.parse(opts.body);
    expect(body.message).toContain("replied in session");
    expect(body.message).toContain("GET /api/sessions/child-001?last=N");
    expect(body.message).not.toContain("completed their task");
  });

  it("includes truncated 200-char preview for long results", async () => {
    const longResult = "x".repeat(300);
    const child = makeSession();

    notifyParentSession(child, { result: longResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // Should contain exactly 200 chars + "..."
    expect(body.message).toContain("x".repeat(200) + "...");
    expect(body.message).not.toContain("x".repeat(201));
  });

  it("includes full preview for short results", async () => {
    const shortResult = "Task done successfully";
    const child = makeSession();

    notifyParentSession(child, { result: shortResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(shortResult);
    expect(body.message).not.toContain("...");
  });

  it("error notifications contain the error message", async () => {
    const child = makeSession();

    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain("Something broke");
    expect(body.message).toContain("⚠️");
  });

  it('sends with "notification" role', async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.role).toBe("notification");
  });
});

describe("notifyParentSession — alwaysNotify suppression", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("skips notification when alwaysNotify is false (success)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips notification when alwaysNotify is false (error)", async () => {
    const child = makeSession();

    notifyParentSession(child, { error: "Something broke" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends notification when alwaysNotify is true", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("sends notification when options is undefined (backward compat)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

// A parent may have ended its turn expecting this notification. Suppressing it is a
// valid choice, but doing so in silence leaves a stalled parent with no trace anywhere:
// the session simply stops, and the only way to notice is for a human to ask.
describe("notifyParentSession — suppression leaves a trace", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // Default: a healthy parent. Each test narrows this to the case it covers.
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", status: "idle" }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("logs when alwaysNotify:false suppresses the notification", async () => {
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", status: "idle" }));

    notifyParentSession(makeSession(), { result: "done" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("alwaysNotify=false"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("parent-001"));
  });

  it("logs when the parent is gone", async () => {
    vi.mocked(getSession).mockReturnValue(undefined as never);

    notifyParentSession(makeSession(), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("logs when the parent is already in error", async () => {
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", status: "error" }));

    notifyParentSession(makeSession(), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("is in error"));
  });

  it("stays silent for an unlinked child — nobody is waiting on it", async () => {
    notifyParentSession(makeSession({ parentSessionId: null }), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// The gateway requires a bearer token on /api/sessions/:id/message. This path sent none,
// so every notification came back 401 — and since fetch() resolves on a 4xx rather than
// rejecting, the fire-and-forget .catch() never fired and the parent waited forever.
describe("notifyParentSession — authenticated delivery", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readGatewayAuthToken).mockReturnValue("test-token");
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", status: "idle" }));
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("sends the gateway bearer token", async () => {
    notifyParentSession(makeSession(), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("still posts when no token is configured", async () => {
    vi.mocked(readGatewayAuthToken).mockReturnValue(null);

    notifyParentSession(makeSession(), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("logs a rejected delivery instead of discarding it", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });

    notifyParentSession(makeSession(), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("401"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("parent-001"));
  });
});

// notifyDiscordChannel carries the rate-limit notices ("usage limit cleared", ...) and
// went through the same unauthenticated POST, so those notices were being dropped too.
describe("notifyDiscordChannel — authenticated delivery", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readGatewayAuthToken).mockReturnValue("test-token");
    vi.mocked(loadConfig).mockReturnValue({
      gateway: { port: 7777 },
      notifications: { connector: "slack", channel: "C123" },
    } as never);
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("sends the gateway bearer token", async () => {
    notifyDiscordChannel("usage limit cleared");
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/connectors/slack/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("logs a rejected delivery instead of discarding it", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });

    notifyDiscordChannel("usage limit cleared");
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("401"));
  });

  it("does nothing when no notification channel is configured", async () => {
    vi.mocked(loadConfig).mockReturnValue({ gateway: { port: 7777 } } as never);

    notifyDiscordChannel("usage limit cleared");
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// A parent that is busy when several children finish should run ONE turn for
// all of them. The gateway can only fold completions together if it can tell
// them from every other notification, so a successful completion names the
// child it reports. A failure never carries the flag: it stays its own turn.
describe("notifyParentSession — completion batching flag", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readGatewayAuthToken).mockReturnValue("test-token");
    vi.mocked(loadConfig).mockReturnValue({ gateway: { port: 7777 } } as never);
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", parentSessionId: null, status: "running" }));
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  const sentBody = () => JSON.parse(fetchSpy.mock.calls[0][1].body) as Record<string, unknown>;

  it("names the child on a successful completion", async () => {
    notifyParentSession(makeSession({ id: "child-042" }), { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sentBody()).toMatchObject({ role: "notification", completionOf: "child-042" });
    // The authenticated delivery is unchanged.
    expect((fetchSpy.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("leaves an error unmarked, so it is never folded into a batch", async () => {
    notifyParentSession(makeSession({ id: "child-042" }), { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sentBody()).toMatchObject({ role: "notification" });
    expect(sentBody()).not.toHaveProperty("completionOf");
  });

  it("leaves a rate-limit notice unmarked — the child has not completed", async () => {
    notifyRateLimited(makeSession({ id: "child-042" }), "12:30");
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sentBody()).not.toHaveProperty("completionOf");
  });
});

// A parent in error used to lose every completion its children sent: the
// notification was dropped, and not even its transcript showed that a child
// had finished. Two kinds of parent are in error, and they need different things.
describe("notifyParentSession — a parent in error", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readGatewayAuthToken).mockReturnValue("test-token");
    vi.mocked(loadConfig).mockReturnValue({ gateway: { port: 7777 } } as never);
    vi.mocked(insertMessage).mockReturnValue(undefined as never);
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  const parentInError = (lastError: string | null) =>
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", parentSessionId: null, status: "error", lastError }));
  const recorded = () => vi.mocked(insertMessage).mock.calls.map(([sessionId, role, content]) => ({ sessionId, role, content: String(content) }));

  describe("because its engine stopped without being asked to", () => {
    // Its process died. The engine session and the transcript are intact, and
    // the next turn starts a new process — nothing about it would fail again.
    beforeEach(() => { parentInError(unrequestedStopError("claude", "claude process exited")); });

    it("is woken for a child's completion like any other parent", async () => {
      notifyParentSession(makeSession({ id: "child-042" }), { result: "調査が終わりました" });
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");
      expect(JSON.parse(String(init.body))).toMatchObject({ role: "notification", completionOf: "child-042" });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      expect(insertMessage).not.toHaveBeenCalled(); // the gateway records what it accepts
    });

    it("is woken for a child's failure too", async () => {
      notifyParentSession(makeSession({ id: "child-042" }), { error: "Something broke" });
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).message).toContain("Something broke");
    });
  });

  describe("for a reason its next turn would meet again", () => {
    // A usage limit, a lost login: waking it would run one failing turn per
    // child that finishes. It is not woken — but what its children reported is
    // written into its transcript, where it (or the operator) finds it later.
    it.each([
      "claude usage limit reached. It resets Mon, 19 Oct, 03:00 (2026-10-19T03:00:00.000Z), which is too far off to wait for. Please try again after that.",
      "Not logged in · Please run /login",
      "Engine response timeout",
      null,
    ])("records the completion in its transcript and does not wake it: %s", async (lastError) => {
      parentInError(lastError);

      notifyParentSession(makeSession({ id: "child-042", employee: "researcher" }), { result: "調査が終わりました" });
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(recorded()).toHaveLength(1);
      const [entry] = recorded();
      expect(entry).toMatchObject({ sessionId: "parent-001", role: "notification" });
      // The same report a woken parent gets …
      expect(entry.content).toContain('Employee "researcher" replied in session child-042');
      expect(entry.content).toContain("GET /api/sessions/child-042?last=N");
      expect(entry.content).toContain("Preview: 調査が終わりました");
      // … marked as one nobody has acted on.
      expect(entry.content).toContain("no turn was started");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("is in error"));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("parent-001"));
    });

    it("records a child's failure as well", async () => {
      parentInError("Not logged in · Please run /login");

      notifyParentSession(makeSession({ id: "child-042" }), { error: "Something broke" });
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(recorded()).toHaveLength(1);
      expect(recorded()[0].content).toContain("encountered an error: Something broke");
    });

    it("records a child's rate-limit notice as well", async () => {
      parentInError("Not logged in · Please run /login");

      notifyRateLimited(makeSession({ id: "child-042" }), "12:30");
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(recorded()).toHaveLength(1);
      expect(recorded()[0].content).toContain("rate-limited and will auto-resume around 12:30");
    });

    it("logs it when the record cannot be written, and does not throw", async () => {
      parentInError("Not logged in · Please run /login");
      vi.mocked(insertMessage).mockImplementation(() => { throw new Error("database is locked"); });

      expect(() => notifyParentSession(makeSession({ id: "child-042" }), { result: "done" })).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("database is locked"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("parent-001"));
    });
  });
});
