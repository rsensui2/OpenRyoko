import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable fake PTYs. Each pty.spawn() pushes one here so the test can drive
// its onExit precisely (reproducing the kill->respawn race timing).
interface FakePty {
  pid: number;
  _exitCode: number | null;
  _killCalled: boolean;
  writes: string[];
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  _errorCb?: (err: Error) => void;
  fireExit: () => void;
  /** Fire a PTY-master socket error (e.g. EIO) WITHOUT firing onExit — the
   *  issue #18 failure mode where the transport dies but the proc never exits. */
  fireError: (err?: Error) => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 1000 + ptys.length,
    _exitCode: null,
    _killCalled: false,
    writes: [],
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() { p._killCalled = true; }, // signal sent; real exit is async (fireExit)
    write(d) { p.writes.push(d); },
    resize() {},
    on(event, cb) { if (event === "error") p._errorCb = cb as (err: Error) => void; },
    fireExit() { p._exitCode = 0; p._exitCb?.({ exitCode: 0 }); },
    fireError(err) { p._errorCb?.(err ?? Object.assign(new Error("read EIO"), { code: "EIO" })); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }),
}));
// Avoid real sockets: the SSE proxy is exercised empirically elsewhere (Item A).
vi.mock("../sse-pty-proxy.js", () => ({
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41000; }
    stop() {}
    hasInflight() { return false; }
    isBusy() { return false; }
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));
// spawn() awaits the shared-OAuth refresh gate before pty.spawn(). Unmocked, it
// reads the real ~/.claude/.credentials.json — and when that token is within 90s
// of expiry (or expired), the gate serializes the spawn herd: the first spawn
// leads and opens a 25s refresh window that blocks every later spawn, so
// pty.spawn() is never reached within the test's 15ms flush and ptys[] stays
// empty. These tests exercise the PTY lifecycle, not the OAuth gate — stub it to
// resolve instantly so they don't depend on the runner's real credential state.
vi.mock("../../shared/claude-oauth-gate.js", () => ({
  awaitFreshClaudeCredentials: async () => {},
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

const flush = () => new Promise((r) => setTimeout(r, 15));

describe("InteractiveClaudeEngine — kill->respawn race (Item C)", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  it("a stale PTY's exit does not kill or poison the freshly-respawned turn", async () => {
    // Turn 1 (cold spawn).
    const p1 = engine.run({ sessionId: "s1", prompt: "a", cwd: "/tmp" } as any);
    await flush();
    const ptyA = ptys[0];
    expect(ptyA).toBeDefined();

    // api.ts interrupts the in-flight turn for a new message.
    engine.kill("s1", "Interrupted: new message received");
    const r1 = await p1;
    expect(r1.error).toBe("Interrupted: new message received");

    // Turn 2 (cold spawn — releaseSession cleared the warm entry).
    let r2: any;
    void engine.run({ sessionId: "s1", prompt: "b", cwd: "/tmp" } as any).then((v) => { r2 = v; });
    await flush();
    const ptyB = ptys[1];
    expect(ptyB).toBeDefined();
    expect(ptyB).not.toBe(ptyA);

    // The OLD PTY's SIGTERM finally takes effect — its exit fires AFTER ptyB was adopted.
    ptyA.fireExit();
    await flush();

    // Fix assertions: the stale exit neither killed ptyB nor settled turn 2.
    expect(ptyB._killCalled).toBe(false);
    expect(r2).toBeUndefined();

    // Turn 2 then completes normally via its own hooks — no double-error.
    hookCb!({ hook_event_name: "SessionStart", session_id: "c2" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done2" });
    await flush();
    expect(r2.result).toBe("done2");
    expect(r2.error).toBeUndefined();
  });

  it("a genuine crash of the current turn's PTY still interrupts (no hang)", async () => {
    const p = engine.run({ sessionId: "s2", prompt: "c", cwd: "/tmp" } as any);
    await flush();
    const ptyC = ptys[0];
    ptyC.fireExit(); // current PTY dies mid-turn with no Stop hook
    const r = await p;
    expect(r.error).toMatch(/claude process exited/);
  });

  it("clears permission-prompt recovery mode only after every parallel tool completes", async () => {
    const run = engine.run({ sessionId: "permission-manual", prompt: "run it", cwd: "/tmp" } as any);
    await flush();
    hookCb!({ hook_event_name: "SessionStart", session_id: "permission-native" });
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Read" });
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    hookCb!({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect((engine as any).active.get("permission-manual").permissionPromptPending).toBe(true);

    hookCb!({ hook_event_name: "PostToolUse", tool_name: "Read" });
    expect((engine as any).active.get("permission-manual").permissionPromptPending).toBe(true);
    hookCb!({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect((engine as any).active.get("permission-manual").permissionPromptPending).toBe(false);
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "approved" });
    expect((await run).result).toBe("approved");
  });

  it("replays a restored screen, then resets it before a new PTY stream", () => {
    const controls: string[] = [];
    const replay: string[] = [];
    (engine as any).streams.set("restored", {
      chunks: [Buffer.from("old screen")],
      totalBytes: 10,
      subscribers: new Set(),
      hasSeenPty: true,
    });
    const unsubscribe = engine.subscribeOutput(
      "restored",
      (data) => replay.push(data.toString()),
      (event) => controls.push(event.type),
    );
    expect(engine.getScrollback("restored").toString()).toBe("old screen");
    expect(replay).toEqual([]);

    (engine as any).wireProcToStream("restored", makeFakePty());
    expect(controls).toEqual(["reset"]);
    expect(engine.getScrollback("restored").length).toBe(0);
    unsubscribe();
  });
});

describe("InteractiveClaudeEngine — PTY socket error / EIO (issue #18)", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  const completeTurn = (sid: string) => {
    hookCb!({ hook_event_name: "SessionStart", session_id: sid });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "ok" });
  };

  it("an EIO with no onExit still interrupts the active turn AND evicts the warm handle", async () => {
    const p = engine.run({ sessionId: "s3", prompt: "x", cwd: "/tmp" } as any);
    await flush();
    const pty = ptys[0];
    expect(lifecycle.getWarm("s3")).toBeDefined();

    pty.fireError(); // socket dies (EIO); onExit is NOT fired
    const r = await p;

    // Turn settles (no hang until the watchdog) and the corpse is evicted so the
    // next turn can't reuse it.
    expect(r.error).toMatch(/socket error/);
    expect(lifecycle.getWarm("s3")).toBeUndefined();
    expect(pty._killCalled).toBe(true);
  });

  it("a warm PTY killed by EIO is not reused — the next turn cold-spawns a new PTY", async () => {
    // Turn 1 completes; PTY stays warm.
    const p1 = engine.run({ sessionId: "s4", prompt: "a", cwd: "/tmp" } as any);
    await flush();
    const ptyA = ptys[0];
    completeTurn("c1");
    await p1;
    expect(lifecycle.getWarm("s4")).toBeDefined();

    // EIO kills the idle warm PTY without onExit → must be evicted.
    ptyA.fireError();
    await flush();
    expect(lifecycle.getWarm("s4")).toBeUndefined();

    // Next turn must cold-spawn a brand-new PTY, NOT inject into the corpse.
    let r2: any;
    void engine.run({ sessionId: "s4", prompt: "b", cwd: "/tmp" } as any).then((v) => { r2 = v; });
    await flush();
    const ptyB = ptys[1];
    expect(ptyB).toBeDefined();
    expect(ptyB).not.toBe(ptyA);
    completeTurn("c2");
    await flush();
    expect(r2.result).toBe("ok");
    expect(r2.error).toBeUndefined();
  });

  it("EIO followed by a late onExit is idempotent (first cause wins, no double-settle)", async () => {
    const p = engine.run({ sessionId: "s5", prompt: "x", cwd: "/tmp" } as any);
    await flush();
    const pty = ptys[0];
    pty.fireError();             // EIO settles + evicts
    pty.fireExit();             // late exit must be a no-op (already handled)
    const r = await p;
    expect(r.error).toMatch(/socket error/); // not overwritten by "process exited"
    expect(lifecycle.getWarm("s5")).toBeUndefined();
  });
});

describe("InteractiveClaudeEngine — reviewed stall and submit races", () => {
  beforeEach(() => {
    ptys.length = 0;
  });

  it("evicts the PTY when a quiet turn crosses the stall backstop", async () => {
    vi.useFakeTimers();
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const registry = new HookRegistry();
    try {
      const engine = new InteractiveClaudeEngine(lifecycle, registry, undefined, 30 * 60_000);
      // A prior turn's orphan PreToolUse drains during register(). It must not
      // count as current work and suppress this turn's stall recovery.
      registry.deliver("stall", { hook_event_name: "PreToolUse", tool_name: "Bash" });
      const resultPromise = engine.run({ sessionId: "stall", prompt: "work", cwd: "/tmp" } as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(lifecycle.getWarm("stall")).toBeDefined();

      await vi.advanceTimersByTimeAsync(15 * 60_000 + 2_000);
      const result = await resultPromise;
      expect(result.error).toMatch(/^Turn stalled:/);
      expect(lifecycle.getWarm("stall")).toBeUndefined();
      expect(ptys.at(-1)?._killCalled).toBe(true);
    } finally {
      registry.dispose();
      lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("does not treat a previous turn's buffered tool hook as submit acknowledgement", async () => {
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const registry = new HookRegistry();
    try {
      const engine = new InteractiveClaudeEngine(lifecycle, registry);
      const first = engine.run({ sessionId: "submit", prompt: "one", cwd: "/tmp" } as any);
      await flush();
      registry.deliver("submit", { hook_event_name: "SessionStart", session_id: "claude-submit" });
      registry.deliver("submit", { hook_event_name: "Stop", last_assistant_message: "done" });
      await first;

      // Arrives after unregister and is buffered for the next register() drain.
      registry.deliver("submit", { hook_event_name: "PostToolUse", tool_name: "Bash" });
      const deltas: any[] = [];
      const second = engine.run({
        sessionId: "submit",
        prompt: "two",
        resumeSessionId: "claude-submit",
        cwd: "/tmp",
        onStream: (delta: any) => deltas.push(delta),
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 180));
      const warm = ptys[0];
      expect(warm.writes.filter((write) => write === "\r")).toHaveLength(1);
      expect(deltas).toEqual([]); // stale PostToolUse must not render in the new turn

      // The stale PostToolUse must not stop the retry loop.
      await new Promise((resolve) => setTimeout(resolve, 1_550));
      expect(warm.writes.filter((write) => write === "\r").length).toBeGreaterThanOrEqual(2);

      registry.deliver("submit", { hook_event_name: "UserPromptSubmit" });
      registry.deliver("submit", { hook_event_name: "Stop", last_assistant_message: "done two" });
      const result = await second;
      expect(result.result).toBe("done two");
    } finally {
      registry.dispose();
      lifecycle.dispose();
    }
  });
});
