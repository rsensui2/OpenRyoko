import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The interactive Claude engine needs a PTY; everything else here runs the
// REAL engines against stand-in CLI executables, so the result shapes under
// test are the ones the engines actually produce — not ones a test invented.
const ptys: Array<{ kill: () => void }> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const pty = { pid: 4000 + ptys.length, _exitCode: null, onData() {}, onExit() {}, write() {}, resize() {}, on() {}, kill() {} };
    ptys.push(pty);
    return pty;
  }),
}));
vi.mock("../../engines/sse-pty-proxy.js", () => ({
  SsePtyProxy: class {
    async start() { return 41000; }
    stop() {}
    hasInflight() { return false; }
    isBusy() { return false; }
  },
}));
vi.mock("../../shared/claude-oauth-gate.js", () => ({ awaitFreshClaudeCredentials: async () => {} }));
vi.mock("../../shared/claude-limit-reset.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-limit-reset.js")>()),
  claudeLimitReset: async () => undefined, // never the real usage API from a test
}));

import { ClaudeEngine } from "../../engines/claude.js";
import { InteractiveClaudeEngine } from "../../engines/claude-interactive.js";
import { CodexEngine } from "../../engines/codex.js";
import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";
import { runEngineWithResponseTimeout, runFallbackAttempts } from "../engine-fallback.js";
import { _resetEngineLoginKnowledge, isLoginRefusal, loginRefusalConfirmed } from "../engine-login.js";
import { SessionManager } from "../manager.js";
import { createSession, getSession, getSessionBySessionKey } from "../registry.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * Whether a failed attempt "did no work" decides two things: whether it may be
 * run again as if nothing had happened (a stale-session retry, a second try at
 * signing in), and whether a login prompt for an error means the engine is not
 * signed in at all. Neither may be decided from `cost` and `numTurns` alone:
 * Codex reports no cost, and counts a turn only when it completes — so a turn
 * that ran a command and then failed looks exactly like one that never started.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "engine-work-evidence-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } },
  sessions: {}, connectors: {}, logging: { level: "error", stdout: false } } as unknown as JinnConfig;

let sequence = 0;
/** A stand-in CLI: prints the given JSONL (and stderr), exits with `code`, and counts its runs. */
function fakeCli(lines: unknown[], code: number, stderr = ""): { bin: string; runs: () => number } {
  const id = ++sequence;
  const bin = path.join(scratch, `cli-${id}`);
  const counter = path.join(scratch, `cli-${id}.runs`);
  fs.writeFileSync(bin, ["#!/bin/sh", `echo run >> '${counter}'`, "cat <<'JSONL'", ...lines.map((line) => JSON.stringify(line)), "JSONL",
    ...(stderr ? [`echo '${stderr}' >&2`] : []), `exit ${code}`, ""].join("\n"), { mode: 0o755 });
  return { bin, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0) };
}

const attempt = (engine: Engine, bin: string): Promise<EngineResult> =>
  runEngineWithResponseTimeout(engine, { prompt: "Deploy the release.", cwd: scratch, sessionId: `evidence-${++sequence}`, bin }, config);

const UNAUTHORIZED = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";
const REFRESH_REUSED = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";

beforeEach(() => _resetEngineLoginKnowledge());

describe("Codex — what a failed turn really looks like", () => {
  const ranACommandThen = (message: string) => [
    { type: "thread.started", thread_id: "codex-thread" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "./deploy.sh production" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "./deploy.sh production", aggregated_output: "deployed", exit_code: 0 } },
    { type: "turn.failed", error: { message } },
  ];

  it.each([["the API rejecting the token", UNAUTHORIZED], ["a refresh token that was already used", REFRESH_REUSED]])(
    "is not a login refusal after it ran a command, even when it ends on %s", async (_label, message) => {
      const result = await attempt(new CodexEngine(), fakeCli(ranACommandThen(message), 1).bin);

      // Exactly what Codex reports: no cost, no turn count — only the error.
      expect(result).toMatchObject({ sessionId: "codex-thread", result: "", error: message });
      expect(result.cost).toBeUndefined();
      expect(result.numTurns).toBeUndefined();
      expect(isLoginRefusal(result)).toBe(false);
    });

  it("is not a stale session to retry from scratch after it ran a command", async () => {
    const result = await attempt(new CodexEngine(), fakeCli(ranACommandThen("stream disconnected before completion"), 1).bin);

    expect(result.cost).toBeUndefined();
    expect(result.numTurns).toBeUndefined();
    expect(isDeadSessionError(result)).toBe(false);
  });

  it.each([
    ["the API rejects the token before anything ran", [{ type: "thread.started", thread_id: "codex-thread" }, { type: "turn.failed", error: { message: UNAUTHORIZED } }], ""],
    ["the CLI has no login at all", [], "Not logged in"],
  ])("is a login refusal when %s", async (_label, lines, stderr) => {
    const result = await attempt(new CodexEngine(), fakeCli(lines, 1, stderr).bin);

    expect(isLoginRefusal(result)).toBe(true);
  });

  it("is still a stale session when it failed before doing anything", async () => {
    const result = await attempt(new CodexEngine(), fakeCli([], 1, "Error: session not found").bin);

    expect(isDeadSessionError(result)).toBe(true);
  });
});

describe("a turn that already ran a command is never run a second time", () => {
  const deployedThenFailed = (message: string) => fakeCli([
    { type: "thread.started", thread_id: "codex-thread" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "./deploy.sh production" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "./deploy.sh production", aggregated_output: "deployed", exit_code: 0 } },
    { type: "turn.failed", error: { message } },
  ], 1);

  it.each([["the API rejecting the token", UNAUTHORIZED], ["a refresh token that was already used", REFRESH_REUSED]])(
    "as a second try at signing in, when the fallback engine ends on %s", async (_label, message) => {
      const codex = deployedThenFailed(message);
      const cfg = { ...config, engines: { ...config.engines, codex: { bin: codex.bin, model: "gpt" } } } as JinnConfig;
      const session = createSession({ engine: "claude", source: "slack", sourceRef: `evidence-fallback-${++sequence}` });
      const engines = new Map<string, Engine>([["claude", { name: "claude", run: vi.fn() }], ["codex", new CodexEngine()]]);

      const outcome = await runFallbackAttempts({
        config: cfg, session, initialEngine: engines.get("claude")!,
        initialResult: { sessionId: "claude-thread", result: "", error: "Usage limit reached" },
        initialOpts: { prompt: "Deploy the release.", cwd: scratch, sessionId: session.id },
        getEngine: (name) => engines.get(name),
        run: (engine, opts) => runEngineWithResponseTimeout(engine, opts, cfg),
      });

      expect(codex.runs()).toBe(1); // the deploy ran once
      // The switch stands, and Codex's failure is the turn's answer — to be
      // read by a person, not retried or waited out on another engine.
      expect(outcome).toMatchObject({ attempted: true, result: { error: message } });
      expect(getSession(session.id)!.engine).toBe("codex");
      expect(loginRefusalConfirmed("codex")).toBe(false);
    });

  it("as a stale-session retry, when the session's own engine fails after the command", async () => {
    const codex = deployedThenFailed("stream disconnected before completion");
    const cfg = { ...config, engines: { default: "codex", claude: { bin: "claude", model: "opus", fallback: [] }, codex: { bin: codex.bin, model: "gpt", fallback: [] } },
      connectors: { slack: { goalExtraction: { enabled: false } } } } as unknown as JinnConfig;
    const manager = new SessionManager(cfg, new Map<string, Engine>([["codex", new CodexEngine()]]));
    const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
    const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
      addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
      reconstructTarget: () => ({ channel: "C-evidence", thread: "thread" }),
    } as unknown as Connector;
    const sessionKey = `slack:evidence-${++sequence}`;

    await manager.route({ connector: "slack", source: "slack", sessionKey, channel: "C-evidence", thread: "thread",
      text: "Deploy the release.", user: "Test", userId: "U-test", messageId: "message", attachments: [],
      replyContext: { channel: "C-evidence", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false } } as IncomingMessage, connector);

    expect(codex.runs()).toBe(1);
    expect(getSessionBySessionKey(sessionKey)).toMatchObject({ engine: "codex", status: "error", lastError: "stream disconnected before completion" });
    expect(replyMessage).toHaveBeenLastCalledWith(expect.anything(), "stream disconnected before completion");
  });
});

describe("Claude (claude -p) — what a failed turn really looks like", () => {
  const result = (text: string, turns: number, cost = 0) =>
    ({ type: "result", subtype: "success", is_error: true, result: text, session_id: "claude-session", total_cost_usd: cost, num_turns: turns });
  const said = (text: string) => ({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text }] } });

  // The CLI reports an API error as the assistant's own message, so the error
  // text is also what was "streamed". That alone is not work.
  it.each([0, 1])("is a login refusal when all it produced is the login prompt itself (num_turns %i)", async (turns) => {
    const prompt = "Not logged in · Please run /login";
    const outcome = await attempt(new ClaudeEngine(), fakeCli([said(prompt), result(prompt, turns)], 1).bin);

    expect(outcome).toMatchObject({ result: "", error: prompt });
    expect(isLoginRefusal(outcome)).toBe(true);
  });

  it("is not a login refusal after it used a tool, whatever cost and turn count it reports", async () => {
    const outcome = await attempt(new ClaudeEngine(), fakeCli([
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } } },
      { type: "stream_event", event: { type: "content_block_stop" } },
      result("OAuth token revoked · Please run /login", 1),
    ], 1).bin);

    expect(outcome).toMatchObject({ error: "OAuth token revoked · Please run /login", cost: 0, numTurns: 1 });
    expect(isLoginRefusal(outcome)).toBe(false);
  });

  it("is not a login refusal after it said something of its own first", async () => {
    const outcome = await attempt(new ClaudeEngine(), fakeCli([
      said("I have updated the changelog and started the release."),
      result("Login expired · Please run /login", 1),
    ], 1).bin);

    expect(isLoginRefusal(outcome)).toBe(false);
  });
});

describe("Claude (interactive PTY) — what a failed turn really looks like", () => {
  function interactive() {
    let hook: ((payload: Record<string, unknown>) => void) | undefined;
    const hookRegistry = { register: (_id: string, listener: typeof hook) => { hook = listener; }, unregister: () => {} };
    const engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), hookRegistry as never);
    return { engine, fire: (payload: Record<string, unknown>) => hook?.(payload) };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

  it("is a login refusal when the turn fails to authenticate before doing anything", async () => {
    const { engine, fire } = interactive();
    const pending = attempt(engine, "claude");
    await settle();
    fire({ hook_event_name: "SessionStart", session_id: "claude-pty" });
    fire({ hook_event_name: "StopFailure", error: "authentication_failed" });
    const outcome = await pending;

    expect(outcome).toMatchObject({ error: "Interactive turn failed: authentication_failed", numTurns: 1 });
    expect(isLoginRefusal(outcome)).toBe(true);
    engine.killAll();
  });

  it("is not a login refusal when a tool had already run", async () => {
    const { engine, fire } = interactive();
    const pending = attempt(engine, "claude");
    await settle();
    fire({ hook_event_name: "SessionStart", session_id: "claude-pty" });
    fire({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    fire({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    fire({ hook_event_name: "StopFailure", error: "authentication_failed" });
    const outcome = await pending;

    // The PTY reports the same single synthetic turn either way.
    expect(outcome).toMatchObject({ error: "Interactive turn failed: authentication_failed", numTurns: 1 });
    expect(isLoginRefusal(outcome)).toBe(false);
    engine.killAll();
  });
});
