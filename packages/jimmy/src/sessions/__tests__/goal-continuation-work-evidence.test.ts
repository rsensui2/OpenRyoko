import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexEngine } from "../../engines/codex.js";
import { extractGoalCondition } from "../../connectors/slack/goal-extractor.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";
import { runEngineWithResponseTimeout } from "../engine-fallback.js";
import { _resetEngineLoginKnowledge, isLoginRefusal, loginRefusalConfirmed } from "../engine-login.js";
import { runWithSessionGoal } from "../goal-execution.js";
import { reviewGoal } from "../goal-review.js";
import { SessionManager } from "../manager.js";
import { createSession, getSessionBySessionKey, updateSession } from "../registry.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn() }));
vi.mock("../../connectors/slack/goal-extractor.js", async (original) => ({ ...await original<object>(), extractGoalCondition: vi.fn() }));

/**
 * A tracked task on Codex is several engine runs behind one result: the turn,
 * then a resume for as long as the review says the condition is not met. That
 * result kept the last run's observed progress only. A continuation that failed
 * before doing anything therefore made the whole turn look like one that never
 * started — and it was run again from the top, deploy included: as a second try
 * at signing in when Codex was the fallback engine, as a stale-session retry
 * when it was the session's own.
 *
 * The REAL Codex engine runs here, against a stand-in `codex` executable, so
 * the results are the ones the engine and the goal loop actually produce.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "goal-continuation-evidence-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const UNAUTHORIZED = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";
const REFRESH_REUSED = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
const CONDITION = "The release is deployed to production and verified";

const DEPLOYS_AND_COMPLETES = [
  { type: "thread.started", thread_id: "codex-thread" },
  { type: "item.started", item: { id: "item_1", type: "command_execution", command: "./deploy.sh production" } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "./deploy.sh production", aggregated_output: "deployed", exit_code: 0 } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "The release is deploying; I will verify it next." } },
  { type: "turn.completed", usage: { input_tokens: 1200 } },
];

let sequence = 0;
const heredoc = (lines: unknown[]) => ["cat <<'JSONL'", ...lines.map((line) => JSON.stringify(line)), "JSONL"];

/**
 * A stand-in `codex`. A fresh `exec` does what `fresh` says — by default it runs
 * the deploy and completes its turn — and `exec resume` fails the way `resume`
 * says. Every start is counted, and every deploy.
 */
function fakeCodex(resume: { lines?: unknown[]; stderr?: string }, fresh?: { lines: unknown[]; code: number }) {
  const id = ++sequence;
  const file = (suffix: string) => path.join(scratch, `codex-${id}${suffix}`);
  const count = (suffix: string) => () => (fs.existsSync(file(suffix)) ? fs.readFileSync(file(suffix), "utf8").trim().split("\n").length : 0);
  fs.writeFileSync(file(""), ["#!/bin/sh", `echo run >> '${file(".runs")}'`,
    'if [ "$2" = "resume" ]; then', ...heredoc(resume.lines ?? []), ...(resume.stderr ? [`echo '${resume.stderr}' >&2`] : []), "exit 1", "fi",
    ...(fresh ? [...heredoc(fresh.lines), `exit ${fresh.code}`] : [`echo deploy >> '${file(".deploys")}'`, ...heredoc(DEPLOYS_AND_COMPLETES), "exit 0"]),
    ""].join("\n"), { mode: 0o755 });
  return { bin: file(""), runs: count(".runs"), deploys: count(".deploys") };
}

function setup(defaultEngine: "claude" | "codex", codexBin: string) {
  const config = { engines: { default: defaultEngine,
    claude: { bin: "claude-bin", model: "claude-model", interactive: true, ...(defaultEngine === "codex" ? { fallback: [] } : {}) },
    codex: { bin: codexBin, model: "gpt", ...(defaultEngine === "codex" ? { fallback: [] } : {}) } },
    sessions: {}, connectors: { slack: {} }, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  // Claude is not under test: it only ever reports that its allowance is spent.
  const claudeRun = vi.fn<Engine["run"]>(async () => ({ sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
    rateLimit: { status: "rejected", rateLimitType: "interactive_detected" } }));
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", new CodexEngine()]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-goal", thread: "thread" }),
  } as unknown as Connector;
  const message = { connector: "slack", source: "slack", sessionKey: `slack:goal-evidence-${++sequence}`, channel: "C-goal", thread: "thread",
    text: "Deploy the release and confirm it is live.", user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-goal", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false } } as IncomingMessage;
  return { config, manager, connector, message, replies: () => replyMessage.mock.calls.map(([, text]) => text) };
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetEngineLoginKnowledge();
  vi.mocked(extractGoalCondition).mockResolvedValue(CONDITION);
  // The first run deployed but has not verified: continue. Anything after that is done.
  vi.mocked(reviewGoal).mockResolvedValueOnce({ status: "continue", reason: "The deployment has not been verified yet." })
    .mockResolvedValue({ status: "complete", reason: "Deployed and verified." });
});

describe("a tracked task whose continuation fails before doing anything is not started over", () => {
  it.each([["the API rejecting the token", UNAUTHORIZED], ["a refresh token that was already used", REFRESH_REUSED]])(
    "as a second try at signing in, when the fallback engine's continuation ends on %s", async (_label, refusal) => {
      const codex = fakeCodex({ lines: [{ type: "turn.failed", error: { message: refusal } }] });
      const f = setup("claude", codex.bin);

      await f.manager.route(f.message, f.connector);

      expect(codex.deploys()).toBe(1);
      expect(codex.runs()).toBe(2); // the turn and its continuation — not a third run, from the top
      // The switch stands and the failure is the turn's answer, for a person to read.
      expect(getSessionBySessionKey(f.message.sessionKey)).toMatchObject({ engine: "codex", status: "error", lastError: refusal });
      expect(f.replies().at(-1)).toBe(refusal);
      expect(loginRefusalConfirmed("codex")).toBe(false);
    });

  it("as a stale-session retry, when the session's own engine cannot find the session it is resuming", async () => {
    const codex = fakeCodex({ stderr: "Error: session not found" });
    const f = setup("codex", codex.bin);

    await f.manager.route(f.message, f.connector);

    expect(codex.deploys()).toBe(1);
    expect(codex.runs()).toBe(2);
    const session = getSessionBySessionKey(f.message.sessionKey)!;
    expect(session).toMatchObject({ engine: "codex", status: "error" });
    expect(session.lastError).toContain("session not found");
  });
});

describe("the one result of a tracked task that took several runs", () => {
  const config = { engines: { default: "codex", codex: { bin: "codex", model: "gpt" } }, sessions: {}, connectors: {}, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const tracked = (bin: string): Promise<EngineResult> => {
    const session = createSession({ engine: "codex", source: "slack", sourceRef: `goal-evidence-${++sequence}`, prompt: "Deploy the release." });
    updateSession(session.id, { status: "running" });
    const engine = new CodexEngine();
    return runWithSessionGoal({ name: "codex", run: (opts) => runEngineWithResponseTimeout(engine, opts, config) },
      { sessionId: session.id, prompt: `/goal ${CONDITION}\nDeploy the release.`, cwd: scratch, bin });
  };

  it("still shows what the first run was seen doing when the continuation failed to sign in", async () => {
    const result = await tracked(fakeCodex({ lines: [{ type: "turn.failed", error: { message: UNAUTHORIZED } }] }).bin);

    // What the goal loop reports for it: the one turn that completed, no cost.
    expect(result).toMatchObject({ sessionId: "codex-thread", result: "", error: UNAUTHORIZED, numTurns: 1 });
    expect(result.cost).toBeUndefined();
    expect(result.handoffContext).toContain("command_execution");
    expect(isLoginRefusal(result)).toBe(false);
  });

  it("is not a stale session to retry from scratch when the continuation could not find its session", async () => {
    const result = await tracked(fakeCodex({ stderr: "Error: session not found" }).bin);

    expect(result).toMatchObject({ numTurns: 1 });
    expect(result.error).toContain("session not found");
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("is still a login refusal when the very first run could not sign in", async () => {
    const result = await tracked(fakeCodex({}, { lines: [{ type: "thread.started", thread_id: "codex-thread" }, { type: "turn.failed", error: { message: UNAUTHORIZED } }], code: 1 }).bin);

    expect(isLoginRefusal(result)).toBe(true);
  });
});
