import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake PTY per spawn, so run() can be driven to a StopFailure without a real
// `claude` process (same seams as claude-interactive-race.test.ts).
const ptys: Array<{ pid: number; _exitCode: number | null }> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const pty = {
      pid: 2000 + ptys.length, _exitCode: null as number | null,
      onData() {}, onExit() {}, kill() {}, write() {}, resize() {}, on() {},
    };
    ptys.push(pty);
    return pty;
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  SsePtyProxy: class {
    async start() { return 41000; }
    stop() {}
    hasInflight() { return false; }
    isBusy() { return false; }
  },
}));
vi.mock("../../shared/claude-oauth-gate.js", () => ({ awaitFreshClaudeCredentials: async () => {} }));

// The lookup reaches the keychain and the network in production. Every case
// here answers it from the test instead.
const claudeLimitReset = vi.fn<(options: { model?: string }) => Promise<{ resetsAt: number; window: string } | undefined>>();
vi.mock("../../shared/claude-limit-reset.js", () => ({
  claudeLimitReset: (options: { model?: string }) => claudeLimitReset(options),
}));

import { InteractiveClaudeEngine, rateLimitFromStopFailure } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { detectRateLimit } from "../../shared/rateLimit.js";

const RESETS_AT = Math.floor(Date.parse("2026-10-12T08:00:00.000Z") / 1000);
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

beforeEach(() => {
  ptys.length = 0;
  claudeLimitReset.mockReset();
  claudeLimitReset.mockResolvedValue({ resetsAt: RESETS_AT, window: "5h" });
});

describe("rateLimitFromStopFailure", () => {
  it("carries the reset and the window the usage source stated", async () => {
    const info = await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit" }, "claude-opus-5");
    expect(info).toEqual({ status: "rejected", rateLimitType: "interactive_detected", resetsAt: RESETS_AT, window: "5h" });
    expect(claudeLimitReset).toHaveBeenCalledExactlyOnceWith({ model: "claude-opus-5" });
  });

  it("keeps the bare rejection when no source has a reset", async () => {
    claudeLimitReset.mockResolvedValue(undefined);
    const info = await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit" });
    expect(info).toEqual({ status: "rejected", rateLimitType: "interactive_detected" });
  });

  it("keeps the bare rejection when the lookup itself fails", async () => {
    claudeLimitReset.mockRejectedValue(new Error("usage lookup exploded"));
    const info = await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit" });
    expect(info).toEqual({ status: "rejected", rateLimitType: "interactive_detected" });
  });

  it("does not ask the usage source about a failure that is not a rate limit", async () => {
    expect(await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "server_error" })).toBeNull();
    expect(await rateLimitFromStopFailure({ hook_event_name: "Stop", error: "rate_limit" })).toBeNull();
    expect(await rateLimitFromStopFailure(undefined)).toBeNull();
    expect(claudeLimitReset).not.toHaveBeenCalled();
  });
});

describe("InteractiveClaudeEngine — a turn that ends on the usage limit", () => {
  function harness() {
    let hook: ((payload: Record<string, unknown>) => void) | undefined;
    const hookRegistry = { register: (_id: string, cb: typeof hook) => { hook = cb; }, unregister: () => {} };
    const engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), hookRegistry as never);
    return { engine, fire: (payload: Record<string, unknown>) => hook?.(payload) };
  }

  it("settles with the reset attached, in the shape the session layer already reads", async () => {
    const { engine, fire } = harness();
    const pending = engine.run({ sessionId: "limit-1", prompt: "hello", cwd: "/tmp", model: "claude-opus-5" });
    await flush();
    fire({ hook_event_name: "SessionStart", session_id: "claude-1" });
    fire({ hook_event_name: "StopFailure", error: "rate_limit" });
    const result = await pending;

    expect(result.error).toBe("Interactive turn failed: rate_limit");
    expect(result.rateLimit).toEqual({ status: "rejected", rateLimitType: "interactive_detected", resetsAt: RESETS_AT, window: "5h" });
    expect(detectRateLimit(result)).toEqual({ limited: true, resetsAt: RESETS_AT });
    expect(claudeLimitReset).toHaveBeenCalledExactlyOnceWith({ model: "claude-opus-5" });
    engine.killAll();
  });

  it("still settles as a rate limit, exactly as before, when the lookup fails", async () => {
    claudeLimitReset.mockRejectedValue(new Error("usage API timed out"));
    const { engine, fire } = harness();
    const pending = engine.run({ sessionId: "limit-2", prompt: "hello", cwd: "/tmp" });
    await flush();
    fire({ hook_event_name: "SessionStart", session_id: "claude-2" });
    fire({ hook_event_name: "StopFailure", error: "rate_limit" });
    const result = await pending;

    expect(result).toMatchObject({ sessionId: "claude-2", result: "", error: "Interactive turn failed: rate_limit" });
    expect(result.rateLimit).toEqual({ status: "rejected", rateLimitType: "interactive_detected" });
    expect(detectRateLimit(result)).toEqual({ limited: true, resetsAt: undefined });
    engine.killAll();
  });

  it("leaves every other failure alone and never consults the usage source for it", async () => {
    const { engine, fire } = harness();
    const pending = engine.run({ sessionId: "limit-3", prompt: "hello", cwd: "/tmp" });
    await flush();
    fire({ hook_event_name: "SessionStart", session_id: "claude-3" });
    fire({ hook_event_name: "StopFailure", error: "authentication_failed" });
    const result = await pending;

    expect(result.error).toBe("Interactive turn failed: authentication_failed");
    expect(result.rateLimit).toBeUndefined();
    expect(claudeLimitReset).not.toHaveBeenCalled();
    engine.killAll();
  });
});
