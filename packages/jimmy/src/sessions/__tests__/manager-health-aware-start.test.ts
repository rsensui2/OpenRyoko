import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type RouteOptions } from "../manager.js";
import { _resetUsageLimitAnnouncements, setEngineInstallProbe } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge, hasServedATurn, noteLoginWorked } from "../engine-login.js";
import { getSession, getSessionBySessionKey } from "../registry.js";
import { startEngineHealthMonitor } from "../../gateway/engine-health-monitor.js";
import { readEngineHealth, recordEngineUnavailable } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Connector, Employee, Engine, EngineResult, IncomingMessage, JinnConfig, WorkflowAttemptCompletion } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * A new session used to start on the default engine no matter what was already
 * known about it. While Claude was out of allowance every new session — every
 * cron firing included — burned one failed turn and posted "usage limit
 * reached. Switching to codex." before doing its work on the fallback.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
const limited = (resetsAt?: number): EngineResult => ({ sessionId: "claude-limited", result: "", error: "Interactive turn failed: rate_limit",
  numTurns: 1, rateLimit: { status: "rejected", rateLimitType: "interactive_detected", ...(resetsAt ? { resetsAt, window: "5h" } : {}) } });
const seedLimit = (engine: string, minutes: number, window?: string) =>
  recordEngineUnavailable(engine, `${engine} usage limit`, inMinutes(minutes), new Date(), window);

let sequence = 0;
function setup(sessions: JinnConfig["sessions"] = {}) {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "claude-thread", result: "Answered by claude." });
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-health", thread: "thread" }),
  } as unknown as Connector;
  const message = (text = "今日の予定を教えてください", source = "slack"): IncomingMessage => ({
    connector: "slack", source, sessionKey: `${source}:health-${++sequence}`, channel: "C-health", thread: "thread",
    text, user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-health", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage);
  const route = async (msg: IncomingMessage, opts?: RouteOptions) => {
    await manager.route(msg, connector, opts);
    return getSessionBySessionKey(msg.sessionKey)!;
  };
  const limitNotices = () => replyMessage.mock.calls.map(([, text]) => text).filter((text) => /usage limit reached/.test(text));
  return { config, manager, connector, message, route, claudeRun, codexRun, replyMessage, limitNotices };
}

const override = (sessionId: string) => (getSession(sessionId)!.transportMeta as { engineOverride?: Record<string, unknown> } | null)?.engineOverride;

beforeEach(() => {
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  fs.rmSync(HEALTH_PATH, { force: true });
  // A session is only ever started on an engine that has answered a turn in
  // this process. That is the situation these tests are about; the engine that
  // has not answered yet has its own tests at the end of the file.
  _resetEngineLoginKnowledge();
  noteLoginWorked("claude");
  noteLoginWorked("codex");
});
afterEach(() => {
  setEngineInstallProbe(undefined);
  vi.useRealTimers();
});

describe("a new session while the default engine is known to be out of allowance", () => {
  it("starts on the fallback engine without a failed turn, and goes back when the window reopens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const reopensAt = inMinutes(60);
    f.claudeRun.mockResolvedValueOnce(limited(reopensAt));

    // The session that finds the limit pays for it once, exactly as before.
    const first = await f.route(f.message());
    expect(first.engine).toBe("codex");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).toHaveBeenCalledTimes(1);

    // The next new session already knows: no Claude turn is spent on it.
    const second = f.message("議事録をまとめてください");
    const started = await f.route(second);
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(f.codexRun.mock.calls[1][0]).toMatchObject({ prompt: "議事録をまとめてください", model: "codex-model", bin: "codex-bin" });
    expect(started).toMatchObject({ engine: "codex", model: "codex-model", status: "idle" });
    expect(override(started.id)).toMatchObject({
      originalEngine: "claude", originalEngineSessionId: null, originalModel: null, originalEffortLevel: null,
      until: new Date(reopensAt * 1000 + 1000).toISOString(),
    });

    // Once the stated window has reopened the same conversation returns to
    // Claude, with what happened on the substitute handed over.
    vi.setSystemTime(reopensAt * 1000 + 2000);
    const back = await f.route({ ...second, text: "続きをお願いします" });
    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(f.claudeRun.mock.calls[1][0].prompt).toContain("Answered by codex.");
    expect(f.claudeRun.mock.calls[1][0].prompt).toContain("続きをお願いします");
    expect(back.engine).toBe("claude");
    expect(override(back.id)).toBeUndefined();

    // And a brand-new session starts on Claude again.
    expect((await f.route(f.message())).engine).toBe("claude");
    expect(f.codexRun).toHaveBeenCalledTimes(2);
  });

  it("reroutes a cron firing the same way", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");

    const session = await f.route(f.message("朝のブリーフィングを作成してください", "cron"));

    expect(session.engine).toBe("codex");
    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(f.codexRun).toHaveBeenCalledTimes(1);
  });

  it("moves an employee's preference too, and keeps what to restore", async () => {
    const f = setup();
    seedLimit("codex", 60);
    const employee = { name: "worker", engine: "codex", model: "gpt-worker", effortLevel: "xhigh", persona: "Work." } as unknown as Employee;

    const session = await f.route(f.message(), { employee });

    expect(session).toMatchObject({ engine: "claude", model: "claude-model" });
    expect(f.codexRun).not.toHaveBeenCalled();
    expect(override(session.id)).toMatchObject({ originalEngine: "codex", originalModel: "gpt-worker", originalEffortLevel: null });
  });

  it("holds a model-scoped window against that model only", async () => {
    const f = setup();
    seedLimit("claude", 600, "7d Fable");
    const fable = { name: "writer", engine: "claude", model: "claude-fable-5-1", persona: "Write." } as unknown as Employee;

    expect((await f.route(f.message())).engine).toBe("claude");
    expect((await f.route(f.message(), { employee: fable })).engine).toBe("codex");
  });
});

describe("how often the switch is announced", () => {
  it("says it once per limit period, not on every session that starts away from the limited engine", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");

    await f.route(f.message());
    await f.route(f.message());
    await f.route(f.message("定例の集計をお願いします", "cron"));

    expect(f.codexRun).toHaveBeenCalledTimes(3);
    expect(f.limitNotices()).toHaveLength(1);
    expect(f.limitNotices()[0]).toMatch(/^⚠️ claude usage limit reached \(resets .+\)\. Starting on codex\.$/);
  });

  it("says nothing more when the session that hit the limit already announced it", async () => {
    const f = setup();
    f.claudeRun.mockResolvedValueOnce(limited(inMinutes(60)));

    await f.route(f.message());
    await f.route(f.message());
    await f.route(f.message());

    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).toHaveBeenCalledTimes(3);
    expect(f.limitNotices()).toEqual(["⚠️ claude usage limit reached. Switching to codex."]);
  });

  // A cron firing names its engine today, so it is not rerouted and still pays
  // a failed turn — but nobody is waiting on it to be told why, every time.
  it("tells a cron delivery channel about a limit period once, however many firings run into it", async () => {
    const f = setup();
    const reopensAt = inMinutes(60);
    f.claudeRun.mockResolvedValue(limited(reopensAt));

    for (let firing = 0; firing < 3; firing++) {
      await f.route(f.message("定例の集計をお願いします", "cron"), { engine: "claude", model: "claude-model" });
    }

    expect(f.claudeRun).toHaveBeenCalledTimes(3);
    expect(f.codexRun).toHaveBeenCalledTimes(3);
    expect(f.limitNotices()).toEqual(["⚠️ claude usage limit reached. Switching to codex."]);
  });

  it("still tells each conversation whose own turn failed and was switched", async () => {
    const f = setup();
    const reopensAt = inMinutes(60);
    f.claudeRun.mockResolvedValue(limited(reopensAt));

    await f.route(f.message(), { engine: "claude" });
    await f.route(f.message(), { engine: "claude" });

    expect(f.limitNotices()).toEqual([
      "⚠️ claude usage limit reached. Switching to codex.",
      "⚠️ claude usage limit reached. Switching to codex.",
    ]);
  });

  it("announces again when a new limit period begins", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    seedLimit("claude", 60, "5h");
    await f.route(f.message());

    vi.setSystemTime(Date.now() + 5 * 60 * 60_000);
    seedLimit("claude", 60, "5h");
    await f.route(f.message());

    expect(f.limitNotices()).toHaveLength(2);
  });
});

describe("sessions the reroute leaves alone", () => {
  it("keeps the wait strategy on the engine it would have used", async () => {
    const f = setup({ rateLimitStrategy: "wait" });
    seedLimit("claude", 60, "5h");

    const session = await f.route(f.message());

    expect(session.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).not.toHaveBeenCalled();
    expect(override(session.id)).toBeUndefined();
  });

  it("runs a workflow attempt on the engine the workflow resolved", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");
    f.manager.setEmployeeProvider(() => ({ name: "worker", displayName: "Worker", department: "platform", rank: "employee",
      engine: "claude", model: "claude-model", persona: "Work." } as Employee));
    let unsubscribe = () => {};
    const completed = new Promise<WorkflowAttemptCompletion>((resolve) => { unsubscribe = f.manager.subscribeWorkflowAttemptCompletion(resolve); });
    try {
      const { sessionId } = await f.manager.runWorkflowAttempt({
        owner: { workflowId: "health-flow", runId: `run-${++sequence}`, nodeId: "work", attempt: 1 },
        employeeId: "worker", engine: "claude", model: "claude-model", prompt: "Do the work.",
      });
      await completed;
      expect(getSession(sessionId)!.engine).toBe("claude");
      expect(f.claudeRun).toHaveBeenCalledTimes(1);
      expect(f.codexRun).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ["an engine the caller named", { engine: "claude" }],
    ["a model the caller named", { model: "claude-sonnet-5" }],
  ] as const)("runs %s, spent allowance or not", async (_label, opts) => {
    const f = setup();
    seedLimit("claude", 60, "5h");

    const session = await f.route(f.message(), opts);

    expect(session.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).not.toHaveBeenCalled();
  });

  it("does not hold the local account's limit against an employee who runs on a remote machine", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");
    const remote = { name: "remote", engine: "claude", sshHost: "worker-box", persona: "Remote." } as unknown as Employee;

    const session = await f.route(f.message(), { employee: remote });

    expect(session.engine).toBe("claude");
    expect(f.codexRun).not.toHaveBeenCalled();
  });
});

describe("when no fallback engine can take the session", () => {
  it.each([
    ["the chain is empty", (f: ReturnType<typeof setup>) => { f.config.engines.claude.fallback = []; }],
    ["the fallback engine is known to be out as well", () => { seedLimit("codex", 60); }],
    ["the fallback engine is not installed", () => { setEngineInstallProbe((bin) => bin !== "codex-bin"); }],
  ] as const)("starts where it always did when %s", async (_label, arrange) => {
    const f = setup();
    seedLimit("claude", 60, "5h");
    arrange(f);

    const session = await f.route(f.message());

    expect(session.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.codexRun).not.toHaveBeenCalled();
    expect(override(session.id)).toBeUndefined();
  });

  it("starts where it always did, rather than dropping the message, when the chain is malformed", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");
    (f.config.engines.claude as unknown as { fallback: unknown }).fallback = 5; // not a list: hand-edited config

    const session = await f.route(f.message());

    expect(session).toMatchObject({ engine: "claude", status: "idle" });
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
  });

  it("reports the limit and waits, as before, when both engines are known to be out", async () => {
    vi.useFakeTimers();
    const f = setup();
    seedLimit("claude", 60, "5h");
    seedLimit("codex", 60);
    f.claudeRun.mockResolvedValue(limited(inMinutes(60)));
    const msg = f.message();

    const pending = f.manager.route(msg, f.connector);
    await vi.waitFor(() => expect(getSessionBySessionKey(msg.sessionKey)?.status).toBe("waiting"));

    expect(f.codexRun).not.toHaveBeenCalled();
    expect(f.limitNotices()).toEqual([expect.stringMatching(/^⏳ claude usage limit reached\. Resets .+ — I'll continue automatically\.$/)]);
    f.manager.getQueue().clearQueue(msg.sessionKey);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
  });
});

describe("a rerouted session whose fallback engine runs into a limit of its own", () => {
  it("waits on the fallback, then still goes back to its own engine when the window reopens", async () => {
    vi.useFakeTimers();
    const f = setup();
    const reopensAt = inMinutes(60);
    recordEngineUnavailable("claude", "claude usage limit", reopensAt, new Date(), "5h");
    f.codexRun.mockResolvedValueOnce({ sessionId: "codex-thread", result: "", error: "Usage limit reached" });
    const msg = f.message();

    // Claude is known to be out, so there is nowhere to switch: the turn waits.
    const pending = f.manager.route(msg, f.connector);
    await vi.waitFor(() => expect(getSessionBySessionKey(msg.sessionKey)?.status).toBe("waiting"));
    expect(f.claudeRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    await pending;

    const resumed = getSessionBySessionKey(msg.sessionKey)!;
    expect(resumed).toMatchObject({ engine: "codex", status: "idle" });
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(override(resumed.id)).toMatchObject({ originalEngine: "claude" });

    vi.setSystemTime(reopensAt * 1000 + 2000);
    await f.manager.route({ ...msg, text: "続きをお願いします" }, f.connector);
    expect(getSessionBySessionKey(msg.sessionKey)!.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
  });
});

describe("a rerouted session whose fallback engine stumbles", () => {
  it.each([
    ["a stale engine session", { sessionId: "", result: "", error: "codex exited with code 1" }],
    ["a transcript that can no longer be resumed", { sessionId: "codex-thread", result: "", cost: 0.4, numTurns: 3,
      error: "messages.1.content.13: thinking or redacted_thinking blocks in the latest assistant message cannot be modified." }],
  ])("keeps its way back to its own engine after %s is cleared", async (_label, failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const reopensAt = inMinutes(60);
    recordEngineUnavailable("claude", "claude usage limit", reopensAt, new Date(), "5h");
    f.codexRun.mockResolvedValueOnce(failure);
    const msg = f.message();

    const started = await f.route(msg);
    expect(started.engine).toBe("codex");
    expect(override(started.id)).toMatchObject({ originalEngine: "claude" });

    vi.setSystemTime(reopensAt * 1000 + 2000);
    const back = await f.route({ ...msg, text: "続きをお願いします" });
    expect(back.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
  });
});

describe("how a wrong record stops steering sessions", () => {
  it("lets go when the stated window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    seedLimit("claude", 60, "5h");
    expect((await f.route(f.message())).engine).toBe("codex");

    vi.setSystemTime(Date.now() + 61 * 60_000);

    expect((await f.route(f.message())).engine).toBe("claude");
    expect(readEngineHealth().claude?.state).not.toBe("exhausted");
  });

  it("lets go when the re-check finds the allowance available again", async () => {
    vi.useFakeTimers();
    const f = setup();
    seedLimit("claude", 3 * 24 * 60, "7d");
    const monitor = startEngineHealthMonitor({ probes: { claude: async () => ({ kind: "available" }) } });
    try {
      expect((await f.route(f.message())).engine).toBe("codex");

      // Days before the stated reset, and hours before any real turn would
      // have been allowed to try: the provider's own reading ends it.
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      expect(readEngineHealth().claude).toBeUndefined();
      expect((await f.route(f.message())).engine).toBe("claude");
      expect(f.codexRun).toHaveBeenCalledTimes(1);
    } finally {
      monitor.stop();
    }
  });

  it("takes back the sessions it had already moved, on their next turn, once the record is let go", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");
    const moved = f.message("議事録をまとめてください");
    expect((await f.route(moved)).engine).toBe("codex");

    // The record turns out to be stale: Claude answers someone who named it.
    await f.route(f.message(), { engine: "claude" });
    expect(readEngineHealth().claude).toBeUndefined();

    // The stated reset is still most of an hour away, but nothing says Claude
    // is out any more — so the moved conversation is not left where it was put.
    const back = await f.route({ ...moved, text: "続きをお願いします" });
    expect(back.engine).toBe("claude");
    expect(override(back.id)).toBeUndefined();
    expect(f.claudeRun.mock.calls.at(-1)![0].prompt).toContain("Answered by codex.");
  });

  // A weekly window: the limit that switched this conversation resets in six days.
  const weeklyLimit = (): EngineResult => {
    const resetsAt = inMinutes(6 * 24 * 60);
    return { ...limited(resetsAt), rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt, window: "7d" } };
  };

  it("takes back a conversation that was switched by its own failed turn too, once the record is let go", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    f.claudeRun.mockResolvedValueOnce(weeklyLimit());
    const switched = f.message();
    expect((await f.route(switched)).engine).toBe("codex");

    // An hour later Claude answers someone else — extra usage was bought, or
    // the window was reset early. New sessions are back on Claude from here.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await f.route(f.message(), { engine: "claude" });
    expect(readEngineHealth().claude).toBeUndefined();

    // And so is the conversation that was switched: it is not left on Codex
    // for the six days the limit had said it would last.
    const back = await f.route({ ...switched, text: "続きをお願いします" });
    expect(back.engine).toBe("claude");
    expect(override(back.id)).toBeUndefined();
  });

  it("holds a conversation switched on a limit days away for twelve hours at most before trying its own engine again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const started = Date.now();
    f.claudeRun.mockResolvedValueOnce(weeklyLimit());
    const switched = f.message();

    const held = await f.route(switched);
    expect(Date.parse(String(override(held.id)!.until))).toBe(started + 12 * 60 * 60_000 + 1000);

    vi.setSystemTime(started + 11 * 60 * 60_000);
    expect((await f.route({ ...switched, text: "まだですか" })).engine).toBe("codex");

    vi.setSystemTime(started + 13 * 60 * 60_000);
    expect((await f.route({ ...switched, text: "続きをお願いします" })).engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(2);
  });

  it("lets go as soon as the engine serves a turn", async () => {
    const f = setup();
    seedLimit("claude", 60, "5h");

    // Someone names Claude outright, and it answers: the record was stale.
    await f.route(f.message(), { engine: "claude" });
    expect(readEngineHealth().claude).toBeUndefined();

    const next = await f.route(f.message());
    expect(next.engine).toBe("claude");
    expect(f.codexRun).not.toHaveBeenCalled();
  });
});

describe("a fallback engine that has not answered a turn in this process yet", () => {
  // Starting a session on an engine is not something that can be taken back
  // within the turn, the way a switch after a failed turn can. So a session is
  // never the first thing to find out whether the fallback engine works.
  it("is not where a new session is started; the session that then switches to it is what proves it", async () => {
    const f = setup();
    _resetEngineLoginKnowledge();
    seedLimit("claude", 60, "5h");
    f.claudeRun.mockResolvedValue(limited(inMinutes(60)));

    const first = await f.route(f.message());

    // Started on its own engine, found the limit, switched — and Codex answered.
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(first.engine).toBe("codex");
    expect(hasServedATurn("codex")).toBe(true);

    // From here on new sessions go straight to it.
    const next = await f.route(f.message());
    expect(next.engine).toBe("codex");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
  });
});
