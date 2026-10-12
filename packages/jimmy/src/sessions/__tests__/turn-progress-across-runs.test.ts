import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFallbackAttempts } from "../engine-fallback.js";
import { _resetEngineLoginKnowledge, loginRefusalConfirmed } from "../engine-login.js";
import { SessionManager } from "../manager.js";
import { createSession, getSession, getSessionBySessionKey } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import { attemptMadeProgress, MAX_OBSERVED_PROGRESS_CHARS, withEarlierProgress } from "../../shared/rateLimit.js";
import type { Connector, Engine, EngineResult, EngineRunOpts, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * A turn can take more than one engine run and still be judged, and handed on,
 * as one result. Wherever a later run's result replaces an earlier one's, what
 * the earlier run was seen doing has to come along — or the next engine is told
 * nothing happened, and a run that failed at once reads as a turn that never
 * started. The tracked-task loop is covered in goal-continuation-work-evidence.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const RAN_BASH = "Observed tool events (verify their effects before continuing):\ntool_use: Bash\ntool_result: Bash";
const NOTHING_KNOWN = "No progress report is available";
let sequence = 0;

beforeEach(() => {
  invalidateModelRegistry();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});

describe("withEarlierProgress", () => {
  const failed = (extra: Partial<EngineResult> = {}): EngineResult => ({ sessionId: "s", result: "", error: "unexpected status 401 Unauthorized", ...extra });

  it("puts what the earlier run was seen doing on a later result that has nothing of its own", () => {
    const merged = withEarlierProgress({ sessionId: "s", result: "Deploying.", handoffContext: RAN_BASH }, failed());

    expect(merged).toEqual({ ...failed(), handoffContext: RAN_BASH });
    expect(attemptMadeProgress(merged)).toBe(true);
  });

  it("keeps both, the earlier first, when the later run was seen doing something too", () => {
    const merged = withEarlierProgress({ sessionId: "s", result: "", handoffContext: RAN_BASH }, failed({ handoffContext: "tool_use: Edit" }));

    expect(merged.handoffContext).toBe(`${RAN_BASH}\n\ntool_use: Edit`);
  });

  it("returns the later result itself when there is nothing to carry", () => {
    const later = failed();
    expect(withEarlierProgress(undefined, later)).toBe(later);
    expect(withEarlierProgress({ sessionId: "s", result: "Done." }, later)).toBe(later);
  });

  // `claude -p` reports an API error as the assistant's own message, so the
  // error is also what was streamed. That is not work, and must not become
  // work by being copied onto the next run.
  it("does not carry text that was only the earlier run's own error", () => {
    const earlier = failed({ error: "Not logged in · Please run /login", handoffContext: "Not logged in · Please run /login" });
    const later = failed();

    expect(withEarlierProgress(earlier, later)).toBe(later);
  });

  it("stays bounded however many runs are folded in, keeping the most recent", () => {
    const merged = withEarlierProgress({ sessionId: "s", result: "", handoffContext: "a".repeat(MAX_OBSERVED_PROGRESS_CHARS) }, failed({ handoffContext: "latest tool" }));

    expect(merged.handoffContext).toHaveLength(MAX_OBSERVED_PROGRESS_CHARS);
    expect(merged.handoffContext!.endsWith("latest tool")).toBe(true);
  });
});

describe("a fallback chain of more than one hop", () => {
  function chain(afterCodex: string[] = ["gemini"]) {
    const config = { engines: { default: "claude",
      claude: { bin: "claude-bin", model: "claude-model", fallback: ["codex"] },
      codex: { bin: "codex-bin", model: "codex-model", fallback: afterCodex },
      gemini: { bin: "gemini-bin", model: "gemini-model", fallback: [] } },
      sessions: {}, connectors: {}, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
    const session = createSession({ engine: "claude", source: "slack", sourceRef: `progress-chain-${++sequence}` });
    const runs = { claude: vi.fn<Engine["run"]>(), codex: vi.fn<Engine["run"]>(), gemini: vi.fn<Engine["run"]>() };
    runs.gemini.mockResolvedValue({ sessionId: "gemini-new", result: "Answered by gemini." });
    const engines = new Map<string, Engine>(Object.entries(runs).map(([name, run]) => [name, { name, run }]));
    const initialOpts: EngineRunOpts = { prompt: "Deploy the release.", cwd: "/test", sessionId: session.id };
    // Claude ran a command, then hit its limit.
    const initialResult: EngineResult = { sessionId: "claude-thread", result: "", error: "Usage limit reached", handoffContext: RAN_BASH };
    return { session, runs, options: { config, session, initialEngine: engines.get("claude")!, initialResult, initialOpts,
      getEngine: (name: string) => engines.get(name), run: (engine: Engine, opts: EngineRunOpts) => engine.run(opts) } };
  }

  it("tells the third engine what the first was seen doing, when the second failed without doing anything", async () => {
    const f = chain();
    f.runs.codex.mockResolvedValue({ sessionId: "", result: "", error: "Usage limit reached" });

    const outcome = await runFallbackAttempts(f.options);

    expect(outcome).toMatchObject({ attempted: true, result: { result: "Answered by gemini." } });
    expect(f.runs.codex.mock.calls[0][0].prompt).toContain("tool_use: Bash");
    const told = f.runs.gemini.mock.calls[0][0].prompt;
    expect(told).toContain("tool_use: Bash");
    expect(told).not.toContain(NOTHING_KNOWN);
  });

  // Whether the engine a session was switched to can sign in is about what
  // THAT engine did. The progress of the one it replaced must not make its
  // refusal look like work.
  it("still takes back a switch to an engine that cannot sign in, however much the engine before it did", async () => {
    const f = chain([]); // nothing after Codex
    f.runs.codex.mockResolvedValue({ sessionId: "", result: "", error: "Codex exited with code 1: Not logged in" });

    const outcome = await runFallbackAttempts(f.options);

    expect(f.runs.codex).toHaveBeenCalledTimes(2); // asked twice, then believed
    expect(loginRefusalConfirmed("codex")).toBe(true);
    expect(outcome).toMatchObject({ attempted: false, result: f.options.initialResult });
    expect(getSession(f.session.id)!.engine).toBe("claude");
  });

  it("offers the turn to the engine after one that cannot sign in, told what the first was seen doing", async () => {
    const f = chain();
    f.runs.codex.mockResolvedValue({ sessionId: "", result: "", error: "Codex exited with code 1: Not logged in" });

    const outcome = await runFallbackAttempts(f.options);

    expect(loginRefusalConfirmed("codex")).toBe(true);
    expect(outcome).toMatchObject({ attempted: true, result: { result: "Answered by gemini." } });
    expect(f.runs.gemini.mock.calls[0][0].prompt).toContain("tool_use: Bash");
  });
});

describe("a turn that is continued after a server error", () => {
  it("tells the fallback engine what the turn was seen doing before the error, when the continuation then hits a limit", async () => {
    const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
      codex: { bin: "codex-bin", model: "codex-model" } }, sessions: { transientRetryDelaysMs: [1] },
      connectors: { slack: { goalExtraction: { enabled: false } } }, logging: { level: "error", stdout: false } } as unknown as JinnConfig;
    const claudeRun = vi.fn<Engine["run"]>()
      .mockImplementationOnce(async (opts) => {
        opts.onStream?.({ type: "tool_use", toolName: "Bash", content: "./deploy.sh production" });
        opts.onStream?.({ type: "tool_result", toolName: "Bash", content: "deployed" });
        return { sessionId: "claude-thread", result: "", error: "Interactive turn failed: server_error", numTurns: 1 };
      })
      .mockImplementationOnce(async () => ({ sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
        rateLimit: { status: "rejected", rateLimitType: "interactive_detected" } }));
    const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-new", result: "Continued on codex." });
    const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]));
    const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
    const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
      addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
      reconstructTarget: () => ({ channel: "C-progress", thread: "thread" }),
    } as unknown as Connector;
    const sessionKey = `slack:progress-${++sequence}`;

    await manager.route({ connector: "slack", source: "slack", sessionKey, channel: "C-progress", thread: "thread",
      text: "Deploy the release.", user: "Test", userId: "U-test", messageId: "message", attachments: [],
      replyContext: { channel: "C-progress", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false } } as IncomingMessage, connector);

    expect(claudeRun).toHaveBeenCalledTimes(2); // the turn, then its continuation
    expect(codexRun).toHaveBeenCalledTimes(1);
    const told = codexRun.mock.calls[0][0].prompt;
    expect(told).toContain("tool_use: Bash");
    expect(told).not.toContain(NOTHING_KNOWN);
    expect(getSessionBySessionKey(sessionKey)).toMatchObject({ engine: "codex", status: "idle" });
  });
});
