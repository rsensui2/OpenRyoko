import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
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

import { notifyParentSession, notifyDiscordChannel } from "../callbacks.js";
import { logger } from "../../shared/logger.js";
import { readGatewayAuthToken } from "../../gateway/auth.js";
import { getSession } from "../registry.js";
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
