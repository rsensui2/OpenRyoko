import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../shared/resolveBin.js", () => ({
  resolveBin: (bin: string) => `/usr/local/bin/${bin}`,
  formatSpawnError: (label: string, bin: string, err: Error) => `Failed to spawn ${label} (${bin}): ${err.message}`,
}));

import { spawn } from "node:child_process";
import { engineFallbackFailure, runEngineWithResponseTimeout } from "../../sessions/engine-fallback.js";
import type { JinnConfig, StreamDelta } from "../../shared/types.js";
import { ClaudeEngine } from "../claude.js";

/**
 * The response watchdog stops a turn that shows no activity for
 * `sessions.engineNoResponseTimeoutMs` (5 minutes) and hands the work to
 * another engine. A `claude -p` run only turns some of what it prints into
 * stream deltas: extended thinking, the input of a tool call (a long file for
 * Write) and a tool that is running (a deploy) produced none, so they looked
 * like silence and the run was stopped 5 minutes in.
 *
 * The stream-json lines below are the shapes Claude Code 2.1 prints with
 * `--verbose --include-partial-messages`, in the order it prints them.
 */

const minutes = (n: number) => n * 60_000;

type FakeClaude = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

/** Close the stand-in the way a finished process does. */
function end(proc: FakeClaude, code: number): void {
  proc.exitCode = code;
  proc.emit("close", code);
}

/** A stand-in for the next `claude` the engine spawns. */
function fakeClaude(): FakeClaude {
  const proc = new EventEmitter() as FakeClaude;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.exitCode = null;
  proc.killed = false;
  // No pid: kill() then signals this stand-in instead of a real process group.
  proc.kill = vi.fn(() => {
    proc.killed = true;
    end(proc, 143);
    return true;
  });
  vi.mocked(spawn).mockReturnValueOnce(proc as never);
  return proc;
}

/** Print stream-json lines, as one chunk of stdout. */
function print(proc: FakeClaude, ...lines: unknown[]): void {
  proc.stdout.emit("data", Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")));
}

const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null });
const thinking = streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Which hosts does this release touch?" } });
const toolInput = streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"content\":\"## Q3 report\\n" } });
const toolUse = (id: string, name = "Bash") => ({
  type: "assistant",
  message: { id: "msg_tool", content: [{ type: "tool_use", id, name, input: {} }] },
  parent_tool_use_id: null,
});
/** What the CLI prints once a tool call's input is complete — before the tool runs. */
const toolCallEnds = [
  streamEvent({ type: "content_block_stop", index: 1 }),
  streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
  streamEvent({ type: "message_stop" }),
];
/** A whole tool call, as streamed: block start, input, the finished call, and what follows it. */
const toolCall = (id: string, name = "Bash") => [
  streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } }),
  toolInput,
  toolUse(id, name),
  ...toolCallEnds,
];
const toolResult = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  parent_tool_use_id: null,
});
const answer = (text: string) => [
  { type: "assistant", message: { id: "msg_answer", content: [{ type: "text", text }] }, parent_tool_use_id: null },
  { type: "result", subtype: "success", is_error: false, result: text, session_id: "claude-session" },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T07:10:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
});

describe("what a `claude -p` run reports as its last activity", () => {
  it("is the last line it printed, thinking and tool input included, though neither streams a delta", async () => {
    const engine = new ClaudeEngine();
    const proc = fakeClaude();
    const streamed: StreamDelta[] = [];
    const run = engine.run({ prompt: "Write the report.", cwd: "/tmp", sessionId: "writer", onStream: (delta) => streamed.push(delta) });

    await vi.advanceTimersByTimeAsync(minutes(4));
    print(proc, thinking);
    expect(engine.getLastActivityAt("writer")).toBe(Date.now());

    await vi.advanceTimersByTimeAsync(minutes(4));
    print(proc, toolInput);
    const lastLineAt = Date.now();
    expect(engine.getLastActivityAt("writer")).toBe(lastLineAt);

    await vi.advanceTimersByTimeAsync(minutes(3));
    expect(engine.getLastActivityAt("writer")).toBe(lastLineAt);
    expect(streamed).toEqual([]);

    print(proc, ...answer("Written."));
    end(proc, 0);
    expect((await run).result).toBe("Written.");
  });

  it("is the present moment while a tool runs — until its own result, not the next line — for up to 15 minutes", async () => {
    const engine = new ClaudeEngine();
    const proc = fakeClaude();
    const run = engine.run({ prompt: "Deploy the release.", cwd: "/tmp", sessionId: "deploy" });

    print(proc, toolUse("toolu_deploy"));
    const toolStartedAt = Date.now();
    await vi.advanceTimersByTimeAsync(20);
    print(proc, ...toolCallEnds);
    const lastLineAt = Date.now();

    await vi.advanceTimersByTimeAsync(minutes(15) - 21);
    expect(engine.getLastActivityAt("deploy")).toBe(Date.now());

    // Treated as hung from here: the last line the run printed is all that counts.
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now() - toolStartedAt).toBe(minutes(15));
    expect(engine.getLastActivityAt("deploy")).toBe(lastLineAt);

    print(proc, toolResult("toolu_deploy"));
    const returnedAt = Date.now();
    await vi.advanceTimersByTimeAsync(minutes(1));
    expect(engine.getLastActivityAt("deploy")).toBe(returnedAt);

    print(proc, ...answer("Deployed."));
    end(proc, 0);
    await run;
  });

  it("follows a tool over SSH too, where the CLI streams no partial messages", async () => {
    const engine = new ClaudeEngine();
    const proc = fakeClaude();
    const run = engine.run({ prompt: "Deploy the release.", cwd: "/tmp", sessionId: "remote", sshHost: "build-host" });
    expect(vi.mocked(spawn).mock.calls[0][1].join(" ")).not.toContain("--include-partial-messages");

    print(proc, toolUse("toolu_deploy"));
    await vi.advanceTimersByTimeAsync(minutes(9));
    expect(engine.getLastActivityAt("remote")).toBe(Date.now());

    print(proc, toolResult("toolu_deploy"), ...answer("Deployed."));
    end(proc, 0);
    expect((await run).result).toBe("Deployed.");
  });

  it("keeps following a newer run of the session when an older one exits", async () => {
    const engine = new ClaudeEngine();
    const older = fakeClaude();
    const olderRun = engine.run({ prompt: "First.", cwd: "/tmp", sessionId: "shared" });
    const newer = fakeClaude();
    const newerRun = engine.run({ prompt: "Second.", cwd: "/tmp", sessionId: "shared" });

    print(newer, toolUse("toolu_newer"));
    print(older, ...answer("First done."));
    end(older, 0);
    await olderRun;

    await vi.advanceTimersByTimeAsync(minutes(9));
    expect(engine.getLastActivityAt("shared")).toBe(Date.now());
    expect(engine.isAlive("shared")).toBe(true);

    print(newer, toolResult("toolu_newer"), ...answer("Second done."));
    end(newer, 0);
    await newerRun;
    expect(engine.getLastActivityAt("shared")).toBe(0);
  });

  it.each([
    ["exits", (_engine: ClaudeEngine, proc: FakeClaude) => end(proc, 0)],
    ["is stopped", (engine: ClaudeEngine) => engine.kill("forgotten", "Interrupted: stopped")],
    ["fails to start", (_engine: ClaudeEngine, proc: FakeClaude) => proc.emit("error", new Error("spawn claude ENOENT"))],
  ])("is forgotten once the process %s", async (_label, ending) => {
    const engine = new ClaudeEngine();
    const proc = fakeClaude();
    const run = engine.run({ prompt: "Deploy the release.", cwd: "/tmp", sessionId: "forgotten" }).catch((error: unknown) => error);

    print(proc, toolUse("toolu_deploy"), ...toolCallEnds);
    expect(engine.getLastActivityAt("forgotten")).toBe(Date.now());

    ending(engine, proc);
    await run;
    expect(engine.getLastActivityAt("forgotten")).toBe(0);
    expect(engine.isAlive("forgotten")).toBe(false);
  });
});

describe("the response watchdog over a `claude -p` run", () => {
  const config = {
    engines: { default: "claude", claude: { bin: "claude" } },
    sessions: { engineNoResponseTimeoutMs: minutes(5) },
    connectors: {},
    logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;

  /** Start a watched run; the engine is started on the next tick. */
  async function watched(sessionId: string) {
    const engine = new ClaudeEngine();
    const proc = fakeClaude();
    const pending = runEngineWithResponseTimeout(engine, { prompt: "Do the job.", cwd: "/tmp", sessionId }, config);
    await vi.advanceTimersByTimeAsync(0);
    return { proc, pending };
  }

  it("lets a deploy run for 12 minutes", async () => {
    const { proc, pending } = await watched("cron-deploy");

    print(proc, ...toolCall("toolu_deploy"));
    await vi.advanceTimersByTimeAsync(minutes(12));
    expect(proc.kill).not.toHaveBeenCalled();

    print(proc, toolResult("toolu_deploy"), ...answer("Deployed."));
    end(proc, 0);
    expect(await pending).toMatchObject({ result: "Deployed." });
  });

  it("lets the model think for 9 minutes before it writes anything", async () => {
    const { proc, pending } = await watched("cron-thinker");

    for (let minute = 0; minute < 9; minute++) {
      await vi.advanceTimersByTimeAsync(minutes(1));
      print(proc, thinking);
    }
    expect(proc.kill).not.toHaveBeenCalled();

    print(proc, ...answer("Here is the plan."));
    end(proc, 0);
    expect(await pending).toMatchObject({ result: "Here is the plan." });
  });

  it("lets the model spend 9 minutes writing the content of one long file", async () => {
    const { proc, pending } = await watched("cron-writer");

    print(proc, streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_write", name: "Write", input: {} } }));
    for (let minute = 0; minute < 9; minute++) {
      await vi.advanceTimersByTimeAsync(minutes(1));
      print(proc, toolInput);
    }
    expect(proc.kill).not.toHaveBeenCalled();

    print(proc, toolUse("toolu_write", "Write"), ...toolCallEnds, toolResult("toolu_write"), ...answer("Saved the report."));
    end(proc, 0);
    expect(await pending).toMatchObject({ result: "Saved the report." });
  });

  it("counts a long line that is still arriving", async () => {
    const { proc, pending } = await watched("cron-long-line");

    const message = JSON.stringify(answer("A very long report.")[0]);
    await vi.advanceTimersByTimeAsync(minutes(4));
    proc.stdout.emit("data", Buffer.from(message.slice(0, 40)));
    await vi.advanceTimersByTimeAsync(minutes(4));
    proc.stdout.emit("data", Buffer.from(`${message.slice(40)}\n`));
    expect(proc.kill).not.toHaveBeenCalled();

    print(proc, answer("A very long report.")[1]);
    end(proc, 0);
    expect(await pending).toMatchObject({ result: "A very long report." });
  });

  it("does not take the CLI's keep-alive heartbeat for work", async () => {
    const { proc, pending } = await watched("cron-idle");

    for (let minute = 0; minute < 4; minute++) {
      await vi.advanceTimersByTimeAsync(minutes(1));
      print(proc, { type: "keep_alive" });
    }
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minutes(1));
    expect(proc.kill).toHaveBeenCalled();
    expect((await pending).error).toBe("Engine response timeout");
  });

  it("still stops a tool that hangs, after 15 to 20 minutes, so another engine may take over", async () => {
    const { proc, pending } = await watched("cron-hung");

    print(proc, ...toolCall("toolu_hung"));
    await vi.advanceTimersByTimeAsync(minutes(15) - 1);
    expect(proc.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(minutes(5));
    expect(proc.kill).toHaveBeenCalled();
    const result = await pending;
    expect(result.error).toBe("Engine response timeout");
    expect(engineFallbackFailure(result)).toBe("timeout");
  });
});
