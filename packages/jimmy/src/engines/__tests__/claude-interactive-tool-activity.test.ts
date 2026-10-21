import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The interactive engine reports activity from its SSE proxy: the bytes of
 * Claude's API requests. A tool that Claude runs locally sends nothing
 * upstream until it returns, so a deploy longer than the response watchdog's
 * 5 minutes looked like a stalled engine. It counts now, from its PreToolUse
 * hook until its PostToolUse — or PostToolUseFailure, when it fails — for as
 * long as a tool run may take (claude-activity.ts).
 */

const upstream = vi.hoisted(() => ({ at: 0 }));

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 4242,
    _exitCode: null,
    onData() {},
    onExit() {},
    on() {},
    write() {},
    resize() {},
    kill() {},
  })),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  SsePtyProxy: class {
    async start() { return 41000; }
    stop() {}
    hasInflight() { return false; }
    isBusy() { return false; }
    getLastActivityAt() { return upstream.at; }
  },
}));
// Never the real credential refresh gate from a test (see claude-interactive-race.test.ts).
vi.mock("../../shared/claude-oauth-gate.js", () => ({ awaitFreshClaudeCredentials: async () => {} }));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import type { EngineResult, EngineRunOpts, InterruptibleEngine, StreamDelta } from "../../shared/types.js";

const START = Date.parse("2026-10-22T07:10:00Z");
const minutes = (n: number) => n * 60_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

type Hook = Record<string, unknown>;
type Deliver = (hook: Hook, delivery?: { buffered: boolean; receivedAt: number }) => void;

const lifecycles: PtyLifecycleManager[] = [];

function makeEngine(remoteFallback?: InterruptibleEngine) {
  let deliver: Deliver = () => {};
  const registry = { register: (_id: string, callback: Deliver) => { deliver = callback; }, unregister: () => {} };
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
  lifecycles.push(lifecycle);
  const engine = new InteractiveClaudeEngine(lifecycle, registry as never, remoteFallback);
  return { engine, hook: (hook: Hook, delivery?: { buffered: boolean; receivedAt: number }) => deliver(hook, delivery) };
}

/** A turn on a fresh PTY that Claude has started; the last API response ended a moment ago. */
async function startedTurn(sessionId: string, onStream?: (delta: StreamDelta) => void) {
  const { engine, hook } = makeEngine();
  const run = engine.run({ sessionId, prompt: "Deploy the release.", cwd: "/tmp", onStream } as EngineRunOpts);
  await flush();
  hook({ hook_event_name: "SessionStart", session_id: `claude-${sessionId}` });
  upstream.at = Date.now() - 2_000;
  return { engine, hook, run };
}

async function finish(hook: (hook: Hook) => void, run: Promise<EngineResult>): Promise<EngineResult> {
  hook({ hook_event_name: "Stop", last_assistant_message: "Done." });
  return run;
}

beforeEach(() => {
  // Only the clock is fake: the engine's own timers keep real time and stay quiet.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  upstream.at = 0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
});

describe("InteractiveClaudeEngine — a local tool run is activity", () => {
  it("counts from PreToolUse until PostToolUse, for up to 15 minutes, though nothing goes upstream", async () => {
    const { engine, hook, run } = await startedTurn("deploy");
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const toolStartedAt = Date.now();

    vi.setSystemTime(toolStartedAt + minutes(15) - 1);
    expect(engine.getLastActivityAt("deploy")).toBe(Date.now());
    vi.setSystemTime(toolStartedAt + minutes(15));
    expect(engine.getLastActivityAt("deploy")).toBe(upstream.at); // treated as hung

    hook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(engine.getLastActivityAt("deploy")).toBe(upstream.at);
    expect((await finish(hook, run)).result).toBe("Done.");
  });

  it("ends a tool run on PostToolUseFailure, which a failed tool sends instead of PostToolUse", async () => {
    const streamed: StreamDelta[] = [];
    const { engine, hook, run } = await startedTurn("failed", (delta) => streamed.push(delta));
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash" });

    vi.setSystemTime(Date.now() + minutes(6));
    expect(engine.getLastActivityAt("failed")).toBe(upstream.at);
    expect(streamed).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "Bash" }));
    await finish(hook, run);
  });

  it("measures the cap from the last tool hook while another tool still runs", async () => {
    const { engine, hook, run } = await startedTurn("parallel");
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    vi.setSystemTime(START + minutes(14));
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash" });

    vi.setSystemTime(START + minutes(20));
    expect(engine.getLastActivityAt("parallel")).toBe(Date.now());
    hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash" });
    expect(engine.getLastActivityAt("parallel")).toBe(upstream.at);
    await finish(hook, run);
  });

  it("does not count a hook buffered from before the turn", async () => {
    const { engine, hook, run } = await startedTurn("buffered");
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" }, { buffered: true, receivedAt: START - 1_000 });

    vi.setSystemTime(Date.now() + minutes(6));
    expect(engine.getLastActivityAt("buffered")).toBe(upstream.at);
    await finish(hook, run);
  });

  it("does not count a tool while a permission prompt is reported pending", async () => {
    const { engine, hook, run } = await startedTurn("gated");
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    hook({ hook_event_name: "Notification", notification_type: "permission_prompt" });

    vi.setSystemTime(Date.now() + minutes(6));
    expect(engine.getLastActivityAt("gated")).toBe(upstream.at);
    engine.kill("gated", "Interrupted: stopped");
    await run;
  });

  it("reports the headless engine's activity for a turn it hands over to run over SSH", () => {
    const remote: InterruptibleEngine = {
      name: "claude",
      run: async () => ({ sessionId: "remote", result: "ok" }),
      kill: () => {},
      isAlive: () => true,
      killAll: () => {},
      getLastActivityAt: () => START - 1_000,
    };
    const { engine } = makeEngine(remote);
    expect(engine.getLastActivityAt("over-ssh")).toBe(START - 1_000);
  });
});
