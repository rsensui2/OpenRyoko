import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { StreamDelta } from "../../shared/types.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { AntigravityEngine, buildAntigravityPrompt } from "../antigravity.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  proc.pid = undefined; // no process group: signals go to proc.kill
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  return proc;
}

const line = (event: unknown) => Buffer.from(`${JSON.stringify(event)}\n`);

describe("AntigravityEngine", () => {
  let engine: AntigravityEngine;
  let proc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    engine = new AntigravityEngine();
    proc = createMockProcess();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(proc);
  });

  it("sends the prompt as one stream-JSON line and returns the result with its conversation id", async () => {
    const deltas: StreamDelta[] = [];
    const running = engine.run({ prompt: "hello", cwd: "/tmp", bin: "agy", sessionId: "s1", onStream: (d) => deltas.push(d) });

    expect(mockSpawn.mock.calls[0][1]).toContain("--output-format");
    expect(JSON.parse(proc.stdin.end.mock.calls[0][0])).toEqual({ event: "user", message: { content: "hello" } });
    expect(engine.isAlive("s1")).toBe(true);

    proc.stdout.emit("data", line({ event: "init", conversation_id: "conv-1" }));
    proc.stdout.emit("data", line({ event: "step_update", step_update: { step_type: "tool", tool_name: "view_file", step_index: 1, state: "ACTIVE" } }));
    proc.stdout.emit("data", line({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "hi " } }));
    proc.stdout.emit("data", line({ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "there", usage: { input_tokens: 100, cache_read_tokens: 400 } } }));
    proc.stdout.emit("data", line({ event: "result", result: { status: "SUCCESS", response: "hi there", usage: { input_tokens: 9999 } } }));

    await expect(running).resolves.toEqual({ sessionId: "conv-1", result: "hi there", numTurns: 1, contextTokens: 500 });
    // The answer streamed already; the result does not repeat it.
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "text", "text", "context"]);
    expect(engine.isAlive("s1")).toBe(false);
  });

  it("shows the result as text when nothing streamed", async () => {
    const deltas: StreamDelta[] = [];
    const running = engine.run({ prompt: "x", cwd: "/tmp", onStream: (d) => deltas.push(d) });
    proc.stdout.emit("data", line({ event: "result", result: { status: "SUCCESS", response: "only at the end" } }));
    await running;
    expect(deltas).toEqual([{ type: "text", content: "only at the end" }]);
  });

  it("resumes a conversation with --conversation", async () => {
    const running = engine.run({ prompt: "again", cwd: "/tmp", resumeSessionId: "conv-1", systemPrompt: "SYS" });
    expect(mockSpawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--conversation", "conv-1"]));
    // A resumed conversation already has the system prompt.
    expect(JSON.parse(proc.stdin.end.mock.calls[0][0]).message.content).toBe("again");
    proc.stdout.emit("data", line({ event: "result", result: { status: "SUCCESS", response: "ok" } }));
    await expect(running).resolves.toMatchObject({ sessionId: "conv-1", result: "ok" });
  });

  it("reports an ERROR result as an error", async () => {
    const running = engine.run({ prompt: "x", cwd: "/tmp" });
    proc.stdout.emit("data", line({ event: "result", result: { conversation_id: "", status: "ERROR", error: "authentication failed or timed out" } }));
    await expect(running).resolves.toMatchObject({ result: "", error: "authentication failed or timed out" });
  });

  it("fails with agy's stderr when it exits without a result", async () => {
    const running = engine.run({ prompt: "x", cwd: "/tmp" });
    proc.stderr.emit("data", Buffer.from("Error: authentication required.\n"));
    proc.emit("close", 1);
    const result = await running;
    expect(result.error).toBe("Antigravity exited with code 1: Error: authentication required.");
    expect(result.interruptRequested).toBeUndefined();
  });

  it("marks a stop the gateway asked for as requested", async () => {
    const running = engine.run({ prompt: "x", cwd: "/tmp", sessionId: "s2" });
    engine.kill("s2", "Interrupted: new message");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    proc.emit("close", null);
    await expect(running).resolves.toMatchObject({ error: "Interrupted: new message", interruptRequested: true });
  });

  it("rejects with install hints when agy cannot be spawned", async () => {
    const running = engine.run({ prompt: "x", cwd: "/tmp", bin: "agy" });
    proc.emit("error", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));
    await expect(running).rejects.toThrow(/agy/);
  });
});

describe("buildAntigravityPrompt", () => {
  it("puts the system prompt first on a new conversation and lists attachments", () => {
    expect(buildAntigravityPrompt({ prompt: "P", cwd: "/", systemPrompt: "S", attachments: ["/a.png"] }))
      .toBe("S\n\n---\n\nP\n\nAttached files:\n- /a.png");
  });
});
