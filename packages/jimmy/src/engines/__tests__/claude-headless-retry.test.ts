import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EngineResult, StreamDelta } from "../../shared/types.js";
import { ClaudeEngine } from "../claude.js";

/**
 * `claude -p` is started again, up to twice, when an attempt fails on what
 * reads like a passing fault — a 529, a 503, a dropped connection. The retry
 * sends the same prompt, and without a session to resume it starts a new one,
 * so it is only safe while the failed attempt has done nothing.
 *
 * It used to be decided on the error text alone: a turn that had already used
 * tools and then met a 529 was run three times over. So was an answer that came
 * back beside a declared usage limit and merely had "503" somewhere in it.
 *
 * The real engine runs here, against a stand-in `claude` executable.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-headless-retry-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

interface Output { lines: unknown[]; code: number }
const heredoc = (output: Output) => ["cat <<'JSONL'", ...output.lines.map((line) => JSON.stringify(line)), "JSONL", `exit ${output.code}`];

let sequence = 0;
/** A stand-in `claude`: prints `first` on its first start and `later` on every one after, and counts its starts. */
function fakeClaude(first: Output, later: Output = first) {
  const id = ++sequence;
  const bin = path.join(scratch, `claude-${id}`);
  const counter = path.join(scratch, `claude-${id}.runs`);
  fs.writeFileSync(bin, ["#!/bin/sh", `echo run >> '${counter}'`, `if [ "$(wc -l < '${counter}' | tr -d ' ')" = "1" ]; then`, ...heredoc(first), "fi", ...heredoc(later), ""].join("\n"), { mode: 0o755 });
  return { bin, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0) };
}

const usedATool = [
  { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } } },
  { type: "stream_event", event: { type: "content_block_stop" } },
];
const said = (text: string) => ({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text }] } });
const result = (text: string, extra: { isError?: boolean; turns?: number; cost?: number } = {}) =>
  ({ type: "result", subtype: "success", is_error: extra.isError ?? true, result: text, session_id: "claude-session", total_cost_usd: extra.cost ?? 0, num_turns: extra.turns ?? 1 });

async function run(bin: string): Promise<{ outcome: EngineResult; streamed: StreamDelta[] }> {
  const streamed: StreamDelta[] = [];
  const outcome = await new ClaudeEngine().run({ prompt: "Deploy the release.", cwd: scratch, bin, sessionId: `headless-retry-${++sequence}`, onStream: (delta) => streamed.push(delta) });
  return { outcome, streamed };
}

describe("an attempt that had already done something is not started again", () => {
  it("after it used a tool, although it ended on a 529", async () => {
    const claude = fakeClaude({ lines: [...usedATool, said(OVERLOADED), result(OVERLOADED)], code: 1 });

    const { outcome, streamed } = await run(claude.bin);

    expect(claude.runs()).toBe(1);
    expect(outcome).toMatchObject({ result: "", error: OVERLOADED, numTurns: 1, cost: 0 }); // what the CLI reports either way
    expect(streamed.some((delta) => delta.type === "tool_use" && delta.toolName === "Bash")).toBe(true);
    expect(streamed.some((delta) => delta.type === "status")).toBe(false); // no "Retrying…"
  });

  it.each([
    ["more than one turn", { turns: 3 }],
    ["a cost", { cost: 0.04 }],
  ])("when it reports %s, although it ended on a 529", async (_label, numbers) => {
    const claude = fakeClaude({ lines: [said(OVERLOADED), result(OVERLOADED, numbers)], code: 1 });

    const { outcome } = await run(claude.bin);

    expect(claude.runs()).toBe(1);
    expect(outcome.error).toBe(OVERLOADED);
  });
});

describe("an attempt that failed before doing anything", () => {
  it("is still retried on a 529, and the attempt that works is the answer", async () => {
    const claude = fakeClaude(
      { lines: [said(OVERLOADED), result(OVERLOADED)], code: 1 },
      { lines: [said("Deployed."), result("Deployed.", { isError: false, cost: 0.02 })], code: 0 },
    );

    const { outcome, streamed } = await run(claude.bin);

    expect(claude.runs()).toBe(2);
    expect(outcome).toMatchObject({ result: "Deployed.", sessionId: "claude-session" });
    expect(outcome.error).toBeUndefined();
    expect(streamed.filter((delta) => delta.type === "status").map((delta) => delta.content)).toEqual(["Retrying (attempt 2/3)..."]);
  });
});

describe("an answer that came back beside a declared usage limit", () => {
  // The engine reports it as a usage-limit failure, with the CLI's text in the
  // error. That text is not a fault to retry on because of the digits in it.
  it.each([
    ["a reset time that happens to contain 529", "Claude AI usage limit reached|1760529600"],
    ["an answer that mentions a 503", "The health check returned 503 twice before the deploy went through."],
  ])("is not started again over %s", async (_label, text) => {
    const claude = fakeClaude({ lines: [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1760529600, rateLimitType: "five_hour" } },
      said(text), result(text, { isError: false }),
    ], code: 0 });

    const { outcome } = await run(claude.bin);

    expect(claude.runs()).toBe(1);
    expect(outcome).toMatchObject({ result: "", error: `Claude usage limit reached: ${text}`, rateLimit: { status: "rejected", resetsAt: 1760529600 } });
  });
});
