import { describe, it, expect } from "vitest";
import {
  ANTIGRAVITY_TURN_TIMEOUT_MS,
  antigravityUserLine,
  buildAntigravityArgs,
  parseAntigravityStreamLine,
} from "../antigravity-protocol.js";

describe("buildAntigravityArgs", () => {
  it("runs a fresh turn in stream-JSON print mode with the turn's time limit", () => {
    expect(buildAntigravityArgs({ prompt: "hi", cwd: "/tmp" })).toEqual([
      "--dangerously-skip-permissions",
      "--print-timeout", `${ANTIGRAVITY_TURN_TIMEOUT_MS / 1000}s`,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ]);
  });

  it("resumes the conversation and passes model and effort", () => {
    const args = buildAntigravityArgs({
      prompt: "hi", cwd: "/tmp", resumeSessionId: "conv-1", model: "Gemini 3.5 Pro", effortLevel: "high",
    });
    expect(args.slice(0, 6)).toEqual(["--conversation", "conv-1", "--model", "Gemini 3.5 Pro", "--effort", "high"]);
  });

  it("leaves effort to agy when it is 'default', and drops Claude-only flags", () => {
    const args = buildAntigravityArgs({ prompt: "hi", cwd: "/tmp", effortLevel: "default", cliFlags: ["--chrome", "--sandbox"] });
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--sandbox");
  });
});

describe("antigravityUserLine", () => {
  it("is one NDJSON line carrying the prompt", () => {
    const line = antigravityUserLine('line1\nline2 "q"');
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ event: "user", message: { content: 'line1\nline2 "q"' } });
  });
});

describe("parseAntigravityStreamLine", () => {
  it("takes the conversation id from init", () => {
    expect(parseAntigravityStreamLine('{"event":"init","conversation_id":"conv-9"}'))
      .toEqual({ conversationId: "conv-9", deltas: [], terminal: false });
  });

  it("turns tool steps into tool deltas", () => {
    const active = parseAntigravityStreamLine(JSON.stringify({
      event: "step_update",
      step_update: { step_type: "tool", tool_name: "run_command", step_index: 3, state: "ACTIVE" },
    }));
    expect(active?.deltas).toEqual([{ type: "tool_use", content: "Using run_command", toolName: "run_command", toolId: "3" }]);

    const failed = parseAntigravityStreamLine(JSON.stringify({
      event: "step_update",
      step_update: { step_type: "tool", tool_name: "run_command", step_index: 3, state: "DONE", tool_info: { error: { message: "x" } } },
    }));
    expect(failed?.deltas[0]).toMatchObject({ type: "tool_result", content: "run_command failed" });
  });

  it("reads a successful result with its context size", () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify({
      event: "result",
      result: { conversation_id: "conv-9", status: "SUCCESS", response: "hello", usage: { input_tokens: 1200 } },
    }));
    expect(parsed).toMatchObject({ terminal: true, result: "hello", conversationId: "conv-9", contextTokens: 1200 });
  });

  // Captured from agy 1.5.14 when it is not signed in.
  it("reads an error result as agy 1.5.14 prints it", () => {
    const parsed = parseAntigravityStreamLine('{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}');
    expect(parsed).toEqual({ conversationId: undefined, deltas: [], terminal: true, error: "authentication failed or timed out" });
  });

  it("ignores lines that are not events it knows", () => {
    expect(parseAntigravityStreamLine("Error: authentication required.")).toBeNull();
    expect(parseAntigravityStreamLine('{"event":"something_new"}')).toBeNull();
  });
});
