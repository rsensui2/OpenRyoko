import { beforeEach, describe, expect, it, vi } from "vitest";

// One controllable fake PTY per spawn (same seams as claude-interactive-race.test.ts).
interface FakePty { pid: number; _exitCode: number | null; killed: boolean; args: string[] }
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    const pty = {
      pid: 3000 + ptys.length, _exitCode: null as number | null, killed: false, args,
      onData() {}, onExit() {}, write() {}, resize() {}, on() {},
      kill() { pty.killed = true; },
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
// A turn that ends on the usage limit asks the usage source for the reset. In
// production that reaches the keychain and the network; never from a test.
vi.mock("../../shared/claude-limit-reset.js", () => ({ claudeLimitReset: async () => undefined }));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/**
 * What the session layer relies on when it moves a session to another engine
 * and stops the one it leaves (`engine.kill(sessionId, "Interrupted: engine
 * switched")`): only that session's PTY goes, and its conversation can still be
 * resumed when the session comes back.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

function harness() {
  const hooks = new Map<string, (payload: Record<string, unknown>) => void>();
  const unregistered: string[] = [];
  const hookRegistry = {
    register: (id: string, listener: (payload: Record<string, unknown>) => void) => { hooks.set(id, listener); },
    unregister: (id: string) => { hooks.delete(id); unregistered.push(id); },
  };
  // As the gateway wires it: releasing a PTY also drops that session's hook listener.
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4, onCleanup: (id) => hookRegistry.unregister(id) });
  const engine = new InteractiveClaudeEngine(lifecycle, hookRegistry as never);
  const fire = (id: string, payload: Record<string, unknown>) => hooks.get(id)?.(payload);
  return { engine, lifecycle, fire, unregistered };
}

/** Run one turn that ends on the usage limit, leaving the session's PTY warm. */
async function limitedTurn(h: ReturnType<typeof harness>, sessionId: string, claudeSessionId: string) {
  const pending = h.engine.run({ sessionId, prompt: "hello", cwd: "/tmp" });
  await flush();
  h.fire(sessionId, { hook_event_name: "SessionStart", session_id: claudeSessionId });
  h.fire(sessionId, { hook_event_name: "StopFailure", error: "rate_limit" });
  return pending;
}

beforeEach(() => { ptys.length = 0; });

describe("InteractiveClaudeEngine — being stopped for one session on an engine switch", () => {
  it("ends that session's warm PTY and leaves another session's running turn alone", async () => {
    const h = harness();
    const limited = await limitedTurn(h, "switching", "claude-switching");
    expect(limited.error).toBe("Interactive turn failed: rate_limit");
    expect(h.engine.isAlive("switching")).toBe(true); // the PTY outlives the failed turn

    let other: { result?: string; error?: string } | undefined;
    void h.engine.run({ sessionId: "bystander", prompt: "hi", cwd: "/tmp" }).then((value) => { other = value; });
    await flush();
    h.fire("bystander", { hook_event_name: "SessionStart", session_id: "claude-bystander" });

    h.engine.kill("switching", "Interrupted: engine switched");

    expect(ptys.map((pty) => pty.killed)).toEqual([true, false]);
    expect(h.engine.isAlive("switching")).toBe(false);
    expect(h.unregistered.filter((id) => id === "bystander")).toEqual([]);
    expect(other).toBeUndefined(); // still in flight, untouched

    // The bystander's turn settles on its own Stop hook, exactly as it would have.
    h.fire("bystander", { hook_event_name: "Stop", last_assistant_message: "done" });
    await flush();
    expect(other).toMatchObject({ result: "done", error: undefined });
    h.engine.killAll();
  });

  it("can still resume the conversation it was stopped in when the session comes back", async () => {
    const h = harness();
    await limitedTurn(h, "switching", "claude-switching");
    h.engine.kill("switching", "Interrupted: engine switched");

    // Back on Claude after the limit cleared: the session layer hands over the saved id.
    const pending = h.engine.run({ sessionId: "switching", prompt: "continue", cwd: "/tmp", resumeSessionId: "claude-switching" });
    await flush();

    expect(ptys).toHaveLength(2); // a fresh PTY, not the one that was stopped
    expect(ptys[1].args.slice(0, 2)).toEqual(["--resume", "claude-switching"]);
    h.fire("switching", { hook_event_name: "SessionStart", session_id: "claude-switching" });
    h.fire("switching", { hook_event_name: "Stop", last_assistant_message: "continued" });
    expect(await pending).toMatchObject({ sessionId: "claude-switching", result: "continued" });
    h.engine.killAll();
  });

  it("leaves no lost-Stop recovery or watchdog timer armed for the session it stopped", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const pending = h.engine.run({ sessionId: "switching", prompt: "hello", cwd: "/tmp" });
      await vi.advanceTimersByTimeAsync(15);
      h.fire("switching", { hook_event_name: "SessionStart", session_id: "claude-switching" });
      h.fire("switching", { hook_event_name: "StopFailure", error: "rate_limit" });
      await pending;

      h.engine.kill("switching", "Interrupted: engine switched");
      h.lifecycle.dispose(); // the lifecycle's own sweep is the only timer that would remain

      // The turn's recovery and watchdog timers ended when it settled, so there
      // is nothing left that could "recover" an answer for the stopped session.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(ptys).toHaveLength(1);
      expect(h.engine.isAlive("switching")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is harmless for a session that holds no PTY at all", () => {
    const h = harness();

    expect(() => h.engine.kill("never-started", "Interrupted: engine switched")).not.toThrow();
    expect(ptys).toHaveLength(0);
  });
});
