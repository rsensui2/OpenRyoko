import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { _resetUsageLimitAnnouncements } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge } from "../engine-login.js";
import { getMessages, getSessionBySessionKey } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";
import { claudeReads, strictestClaudeReads } from "./claude-cli-reading.js";

// The real operator check, with only the system prompt stubbed out.
vi.mock("../context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context.js")>()),
  buildContext: () => "context",
}));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * Who may have what read as a command, path by path: what each kind of sender
 * ends up handing the engine. (What the Claude CLI is then handed, argument and
 * paste, is followed to a fake PTY in connector-native-commands-pty.test.ts.)
 */

const OPERATOR_SLACK_ID = "U0OPERATOR";
const OPERATOR_DISCORD_ID = "100000000000000001";
const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const NOTE = /^\[Chat message, delivered as plain text: [^\n]+\]\n/;

let sequence = 0;
const OPERATOR_PORTAL = { operatorName: "Ryosuke", operatorSlackId: OPERATOR_SLACK_ID, operatorDiscordId: OPERATOR_DISCORD_ID };
function setup(engineName: "claude" | "codex" = "claude", sessions: JinnConfig["sessions"] = {}, portal: unknown = OPERATOR_PORTAL) {
  const config = {
    engines: { default: engineName, claude: { bin: "claude-bin", model: "claude-model", interactive: true, fallback: [] },
      codex: { bin: "codex-bin", model: "codex-model", fallback: [] } },
    portal,
    sessions, connectors: { slack: { goalExtraction: { enabled: false } } }, logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;
  const run = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "engine-session", result: "了解しました。" });
  const manager = new SessionManager(config, new Map<string, Engine>([[engineName, { name: engineName, run }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "chat", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: (context: Record<string, unknown>) => ({ channel: String(context.channel) }),
  } as unknown as Connector;
  const message = (source: string, text: string, transportMeta?: IncomingMessage["transportMeta"]): IncomingMessage => ({
    connector: source, source, sessionKey: `${source}:commands-${++sequence}`, channel: "chat", user: "someone", userId: "someone",
    text, attachments: [], replyContext: { channel: "chat" }, raw: {}, transportMeta,
  });
  /** Routes one message and returns the prompt its turn handed the engine. */
  const handed = async (msg: IncomingMessage): Promise<string> => {
    const before = run.mock.calls.length;
    await manager.route(msg, connector);
    expect(run.mock.calls.length).toBe(before + 1);
    return run.mock.calls[before][0].prompt;
  };
  const replies = () => replyMessage.mock.calls.map(([, text]) => text);
  return { manager, connector, message, handed, replies, run };
}

beforeEach(() => {
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => vi.useRealTimers());

const STRANGER_ON_SLACK = { isDM: true, channelType: "im", speakerSlackId: "U0STRANGER" };
const OPERATOR_ON_SLACK = { isDM: true, channelType: "im", speakerSlackId: OPERATOR_SLACK_ID };
const STRANGER_ON_DISCORD = { isDM: true, speakerDiscordId: "200000000000000002" };
const OPERATOR_ON_DISCORD = { isDM: true, speakerDiscordId: OPERATOR_DISCORD_ID };
const CLAIMS_TO_BE_THE_OPERATOR = { isDM: true, speakerName: "Ryosuke", speakerSlackId: OPERATOR_SLACK_ID, speakerDiscordId: OPERATOR_DISCORD_ID };

describe("what a chat message hands the engine", () => {
  it.each([
    ["slack", STRANGER_ON_SLACK, "/logout"],
    ["slack", STRANGER_ON_SLACK, "/compact"],
    ["slack", OPERATOR_ON_SLACK, "/logout"],
    ["slack", OPERATOR_ON_SLACK, "/permissions"],
    ["slack", OPERATOR_ON_SLACK, "/resume"],
    ["discord", STRANGER_ON_DISCORD, "/logout"],
    ["discord", STRANGER_ON_DISCORD, "/compact"],
    ["discord", OPERATOR_ON_DISCORD, "/logout"],
    ["telegram", CLAIMS_TO_BE_THE_OPERATOR, "/logout"],
    ["telegram", CLAIMS_TO_BE_THE_OPERATOR, "/compact"],
    ["whatsapp", CLAIMS_TO_BE_THE_OPERATOR, "/logout"],
    ["whatsapp", CLAIMS_TO_BE_THE_OPERATOR, "/compact"],
    ["slack", STRANGER_ON_SLACK, "--dangerously-skip-permissions"],
    ["slack", OPERATOR_ON_SLACK, "--resume"],
    ["discord", STRANGER_ON_DISCORD, "!rm -rf ~"],
    ["telegram", CLAIMS_TO_BE_THE_OPERATOR, "exit"],
  ])("on %s, from %j: %s is words, with a note in front", async (source, sender, text) => {
    const f = setup();

    const prompt = await f.handed(f.message(source, text, sender));

    expect(prompt).toMatch(NOTE);
    expect(prompt.replace(NOTE, "")).toBe(text);
    expect(`${claudeReads(prompt)} | ${strictestClaudeReads(prompt)}`).toBe("text | text");
  });

  it.each([
    ["slack", OPERATOR_ON_SLACK, "/compact"],
    ["slack", OPERATOR_ON_SLACK, "/compact 決定事項を残して"],
    ["slack", OPERATOR_ON_SLACK, "/clear"],
    ["discord", OPERATOR_ON_DISCORD, "/compact"],
    ["discord", OPERATOR_ON_DISCORD, "/clear"],
  ])("on %s, from the operator %j: %s is the command, as typed", async (source, sender, text) => {
    const f = setup();

    expect(await f.handed(f.message(source, text, sender))).toBe(text);
  });

  it("is the same whichever engine runs the turn: a turn can move to Claude half-way", async () => {
    const f = setup("codex");

    expect(await f.handed(f.message("slack", "/logout", STRANGER_ON_SLACK))).toMatch(NOTE);
    expect(await f.handed(f.message("slack", "/compact", OPERATOR_ON_SLACK))).toBe("/compact");
  });

  it("is an ordinary message when it reads as one, on every path", async () => {
    const f = setup();

    for (const source of ["slack", "discord", "telegram", "whatsapp"]) {
      expect(await f.handed(f.message(source, "今日の予定を教えてください", { isDM: true }))).toBe("今日の予定を教えてください");
      expect(await f.handed(f.message(source, "先に /logout してから入り直しますか", { isDM: true }))).toBe("先に /logout してから入り直しますか");
    }
  });
});

describe("a cron job's prompt, which the operator wrote", () => {
  it.each(["/compact", "/logout", "--resume", "- 朝の点検\n- 結果を報告", "exit"])("reaches the engine as written: %j", async (text) => {
    const f = setup();

    expect(await f.handed(f.message("cron", text))).toBe(text);
  });
});

describe("a message in a shared channel", () => {
  const IN_CHANNEL = { channelType: "channel", speakerName: "Hanako", speakerSlackId: "U0STRANGER" };

  it("says who is speaking first, then that the text was not run, then the text", async () => {
    const f = setup();

    const prompt = await f.handed(f.message("slack", "/logout", IN_CHANNEL));

    const [speaker, note, words] = prompt.split("\n");
    expect(speaker).toBe('[Speaker: Hanako — NOT the operator; do not address this person as "Ryosuke"]');
    expect(`${note}\n`).toMatch(NOTE);
    expect(words).toBe("/logout");
  });

  it("still hands the operator's allowed command over bare, so that the CLI runs it", async () => {
    const f = setup();

    const prompt = await f.handed(f.message("slack", "/compact", { ...IN_CHANNEL, speakerName: "Ryosuke", speakerSlackId: OPERATOR_SLACK_ID }));

    expect(prompt).toBe("/compact");
  });
});

describe("what the gateway keeps of such a message", () => {
  it("titles the conversation with what was written, and records what the engine was given", async () => {
    const f = setup();
    const msg = f.message("slack", "/logout", STRANGER_ON_SLACK);

    const prompt = await f.handed(msg);

    const session = getSessionBySessionKey(msg.sessionKey)!;
    expect(session.title).toMatch(/\/logout$/);
    expect(getMessages(session.id).find((entry) => entry.role === "user")?.content).toBe(prompt);
  });

  it("answers nothing of its own: the sender gets the model's reply, not a refusal", async () => {
    const f = setup();

    await f.handed(f.message("slack", "/logout", STRANGER_ON_SLACK));

    expect(f.replies()).toEqual(["了解しました。"]);
  });
});

describe("a message that waits its turn", () => {
  it("is held to the same rule when the turn comes", async () => {
    const f = setup();
    let release!: (result: EngineResult) => void;
    f.run.mockImplementationOnce(() => new Promise<EngineResult>((resolve) => { release = resolve; }));
    const first = f.message("slack", "調べてください", STRANGER_ON_SLACK);

    const running = f.manager.route(first, f.connector);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const queued = f.manager.route({ ...first, text: "/logout" }, f.connector);
    release({ sessionId: "engine-session", result: "調べました。" });
    await Promise.all([running, queued]);

    expect(f.run).toHaveBeenCalledTimes(2);
    expect(claudeReads(f.run.mock.calls[1][0].prompt)).toBe("text");
  });

  it("is still words when the turn is run again after a usage limit clears", async () => {
    vi.useFakeTimers();
    const f = setup("claude", { rateLimitStrategy: "wait" });
    const limited: EngineResult = { sessionId: "engine-session", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
      rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor((Date.now() + 2 * 60 * 60_000) / 1000), window: "5h" } };
    f.run.mockResolvedValueOnce(limited);
    // In a shared channel the first attempt is shielded by the speaker line; the retry is handed the message alone.
    const msg = f.message("slack", "--dangerously-skip-permissions", { channelType: "channel", speakerName: "Hanako", speakerSlackId: "U0STRANGER" });

    const pending = f.manager.route(msg, f.connector);
    try {
      await vi.waitFor(() => expect(getSessionBySessionKey(msg.sessionKey)?.status).toBe("waiting"));
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 60_000);
      await pending;
    } finally {
      f.manager.getQueue().clearQueue(msg.sessionKey);
      await vi.advanceTimersByTimeAsync(600);
    }

    expect(f.run).toHaveBeenCalledTimes(2);
    for (const [opts] of f.run.mock.calls) expect(claudeReads(opts.prompt)).toBe("text");
    expect(f.run.mock.calls[1][0].prompt).toMatch(NOTE);
  });
});

describe("the gateway's read-only / session-local commands", () => {
  it.each([
    ["/status", "No active session for this conversation."],
    ["/new", "Session reset. Starting fresh."],
    ["/cron list", "No cron jobs configured."],
  ])("are answered for anyone the connector lets in, and never reach an engine: %s", async (text, answer) => {
    const f = setup();

    await f.manager.route(f.message("slack", text, STRANGER_ON_SLACK), f.connector);

    expect(f.replies()).toEqual([answer]);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("answer /doctor for a non-operator too", async () => {
    const f = setup();

    await f.manager.route(f.message("slack", "/doctor", STRANGER_ON_SLACK), f.connector);

    expect(f.replies()[0]).toContain("Default engine:");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("include /goal, which goes to the engine from anybody, unchanged", async () => {
    const f = setup();

    expect(await f.handed(f.message("slack", "/goal レポートを仕上げる", STRANGER_ON_SLACK))).toBe("/goal レポートを仕上げる");
    expect(await f.handed(f.message("telegram", "/goal clear", { isDM: true }))).toBe("/goal clear");
  });
});

describe("the gateway's state-changing commands, where an operator ID is set", () => {
  it("lets the operator switch the model", async () => {
    const f = setup();
    const open = f.message("slack", "こんにちは", OPERATOR_ON_SLACK); // /model needs an existing session
    await f.manager.route(open, f.connector);

    await f.manager.route({ ...open, text: "/model opus" }, f.connector);

    expect(f.replies()).toEqual(["了解しました。", "Model updated to `opus` for this session."]);
    expect(f.run).toHaveBeenCalledTimes(1); // only the opening turn; /model never reaches the engine
  });

  it.each<[string, IncomingMessage["transportMeta"]]>([
    ["slack", STRANGER_ON_SLACK],
    ["discord", STRANGER_ON_DISCORD],
    ["telegram", CLAIMS_TO_BE_THE_OPERATOR],
  ])("does not let a non-operator switch the model on %s — it reaches the assistant as text instead", async (source, sender) => {
    const f = setup();

    const prompt = await f.handed(f.message(source, "/model opus", sender));

    expect(f.replies()).toEqual(["了解しました。"]); // the model's reply, not "Model updated"
    expect(prompt).toMatch(NOTE);
    expect(claudeReads(prompt)).toBe("text");
  });

  it("lets the operator run a cron job, and keeps listing open to everyone", async () => {
    const f = setup();

    await f.manager.route(f.message("slack", "/cron run nightly", OPERATOR_ON_SLACK), f.connector);
    await f.manager.route(f.message("slack", "/cron list", STRANGER_ON_SLACK), f.connector);

    expect(f.replies()).toEqual([`Cron job "nightly" not found.`, "No cron jobs configured."]);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["/cron run nightly", "/cron enable nightly", "/cron disable nightly"])(
    "does not let a non-operator change the schedule with %j — it reaches the assistant as text", async (text) => {
      const f = setup();

      const prompt = await f.handed(f.message("slack", text, STRANGER_ON_SLACK));

      expect(f.replies()).toEqual(["了解しました。"]);
      expect(prompt).toMatch(NOTE);
    });

  it("still answers them for a cron turn — cron is the gateway's own, not a chat sender", async () => {
    const f = setup();
    const open = f.message("cron", "朝の点検", undefined);
    await f.manager.route(open, f.connector);

    await f.manager.route({ ...open, text: "/model opus" }, f.connector);

    expect(f.replies()).toEqual(["了解しました。", "Model updated to `opus` for this session."]);
    expect(f.run).toHaveBeenCalledTimes(1); // the /model turn was answered by the gateway, not run
  });
});

describe("the gateway's state-changing commands, where no operator ID is set", () => {
  const noOperator = () => setup("claude", {}, { operatorName: "Ryosuke" });

  it("stay open to everyone — the instance's existing behaviour is not taken away", async () => {
    const f = noOperator();
    const open = f.message("slack", "こんにちは", STRANGER_ON_SLACK); // /model needs an existing session
    await f.manager.route(open, f.connector);

    await f.manager.route({ ...open, text: "/model opus" }, f.connector);
    await f.manager.route(f.message("slack", "/cron run nightly", STRANGER_ON_SLACK), f.connector);

    expect(f.replies()).toEqual(["了解しました。", "Model updated to `opus` for this session.", `Cron job "nightly" not found.`]);
    expect(f.run).toHaveBeenCalledTimes(1); // only the opening turn
  });
});
