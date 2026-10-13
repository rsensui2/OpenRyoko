import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cold start's positional prompt argument is stripped of terminal control
 * characters by the engine itself — independently of the connector guard, so
 * the web UI and the history handed on at an engine switch (neither of which
 * passes through the guard) are covered too.
 */

interface FakePty {
  args: string[];
  writes: string[];
  _exitCode: number | null;
  onData: () => void;
  onExit: () => void;
  on: () => void;
  kill: () => void;
  resize: () => void;
  write: (d: string) => void;
}
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    const pty: FakePty = { args, writes: [], _exitCode: null,
      onData() {}, onExit() {}, on() {}, kill() {}, resize() {}, write(d) { pty.writes.push(d); } };
    ptys.push(pty);
    return pty;
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  SsePtyProxy: class { async start() { return 41000; } stop() {} hasInflight() { return false; } isBusy() { return false; } },
}));
vi.mock("../../shared/claude-settings.js", () => ({ writeSessionSettings: () => "/tmp/fake-settings.json" }));
vi.mock("../../shared/claude-oauth-gate.js", () => ({ awaitFreshClaudeCredentials: async () => {} }));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

let lifecycle: PtyLifecycleManager;
let hookCb: ((h: any) => void) | undefined;
let engine: InteractiveClaudeEngine;

beforeEach(() => {
  ptys.length = 0;
  hookCb = undefined;
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
  engine = new InteractiveClaudeEngine(lifecycle, { register: (_id: string, cb: (h: any) => void) => { hookCb = cb; }, unregister: () => {} } as any);
});
afterEach(() => { engine.killAll(); lifecycle.dispose(); });

async function coldArg(prompt: string): Promise<string> {
  const run = engine.run({ sessionId: "cold", prompt, cwd: "/tmp" } as any);
  await flush();
  hookCb!({ hook_event_name: "SessionStart", session_id: "claude-cold" });
  hookCb!({ hook_event_name: "Stop", last_assistant_message: "ok" });
  await run;
  const args = ptys[0].args;
  return args[args[0] === "--resume" ? 2 : 0];
}

describe("the cold start's positional prompt argument", () => {
  it("cannot carry a bracketed-paste close or other control characters", async () => {
    const arg = await coldArg("hello\u001b[201~/logout\r");

    expect(CONTROL.test(arg)).toBe(false);
    expect(arg).toContain("[201~/logout");
  });

  it("keeps the newlines and tabs of an ordinary first message", async () => {
    expect(await coldArg("手順:\n- 一つ目\n- 二つ目\t(タブ)")).toBe("手順:\n- 一つ目\n- 二つ目\t(タブ)");
  });
});
