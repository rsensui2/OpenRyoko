import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A chat message used to reach the Claude CLI exactly as it was typed. The CLI
 * reads a prompt that starts with "/" as one of its own commands, and one that
 * starts with "-" as an option — so anybody who could message the assistant
 * could run /logout on the operator's account, or hand the CLI a flag.
 *
 * These tests run the real session manager and the real interactive engine
 * against a fake PTY, and look at what the CLI is actually handed: its prompt
 * argument on a cold start, the bracketed paste on a warm one. Nothing here
 * runs a CLI.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  args: string[];
  writes: string[];
  onData: () => void;
  onExit: () => void;
  on: () => void;
  kill: () => void;
  resize: () => void;
  write: (data: string) => void;
}
const ptys: FakePty[] = [];

vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    const pty: FakePty = {
      pid: 4000 + ptys.length, _exitCode: null, args, writes: [],
      onData() {}, onExit() {}, on() {}, kill() {}, resize() {},
      write(data) { pty.writes.push(data); },
    };
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
// The real operator check, with only the system prompt stubbed out.
vi.mock("../context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context.js")>()),
  buildContext: () => "context",
}));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));

import { InteractiveClaudeEngine, isNativeClaudeCommand } from "../../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import { OPERATOR_NATIVE_COMMANDS } from "../connector-command-guard.js";
import { SessionManager } from "../manager.js";
import { getSessionBySessionKey } from "../registry.js";
import type { Connector, Engine, IncomingMessage, JinnConfig } from "../../shared/types.js";
import { claudeReads, strictestClaudeReads } from "./claude-cli-reading.js";

const OPERATOR_SLACK_ID = "U0OPERATOR";
const OPERATOR_DISCORD_ID = "100000000000000001";
const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let sequence = 0;
let lifecycle: PtyLifecycleManager;
let registry: HookRegistry;
let engine: InteractiveClaudeEngine;
let manager: SessionManager;
let connector: Connector;

beforeEach(() => {
  ptys.length = 0;
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
  registry = new HookRegistry();
  engine = new InteractiveClaudeEngine(lifecycle, registry);
  const config = {
    engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true, fallback: [] },
      codex: { bin: "codex-bin", model: "codex-model" } },
    portal: { operatorName: "Ryosuke", operatorSlackId: OPERATOR_SLACK_ID, operatorDiscordId: OPERATOR_DISCORD_ID },
    sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;
  manager = new SessionManager(config, new Map<string, Engine>([["claude", engine]]));
  const replyMessage = vi.fn(async () => undefined);
  connector = { name: "chat", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: (context: Record<string, unknown>) => ({ channel: String(context.channel) }),
  } as unknown as Connector;
});

afterEach(() => {
  engine.killAll();
  registry.dispose();
  lifecycle.dispose();
});

type Sender = "slack-stranger" | "slack-operator" | "discord-stranger" | "discord-operator";
const SENDERS: Record<Sender, Pick<IncomingMessage, "source" | "connector" | "transportMeta">> = {
  "slack-stranger": { source: "slack", connector: "slack", transportMeta: { isDM: true, channelType: "im", speakerSlackId: "U0STRANGER" } },
  "slack-operator": { source: "slack", connector: "slack", transportMeta: { isDM: true, channelType: "im", speakerSlackId: OPERATOR_SLACK_ID } },
  "discord-stranger": { source: "discord", connector: "discord", transportMeta: { isDM: true, speakerDiscordId: "200000000000000002" } },
  "discord-operator": { source: "discord", connector: "discord", transportMeta: { isDM: true, speakerDiscordId: OPERATOR_DISCORD_ID } },
};

function conversation(sender: Sender) {
  const sessionKey = `${sender}:native-${++sequence}`;
  /** Runs one turn to its end and returns the prompt the CLI was handed for it. */
  const say = async (text: string): Promise<string> => {
    const spawned = ptys.length;
    const written = ptys.at(-1)?.writes.length ?? 0;
    const msg: IncomingMessage = { ...SENDERS[sender], sessionKey, channel: "D-chat", user: "someone", userId: "someone",
      text, attachments: [], replyContext: { channel: "D-chat" }, raw: {} };
    const routed = manager.route(msg, connector);
    await until(() => ptys.length > spawned || (ptys.at(-1)?.writes.length ?? 0) > written, "the prompt to reach the CLI");
    const cold = ptys.length > spawned;
    const pty = ptys.at(-1)!;
    const handed = cold
      ? pty.args[pty.args[0] === "--resume" ? 2 : 0]
      : pty.writes.slice(written).map((write) => PASTE.exec(write)?.[1]).find((paste) => paste !== undefined);
    const session = getSessionBySessionKey(sessionKey)!;
    registry.deliver(session.id, { hook_event_name: "SessionStart", session_id: `claude-${sessionKey}` });
    registry.deliver(session.id, { hook_event_name: "Stop", last_assistant_message: "ok" });
    await routed;
    if (handed === undefined) throw new Error("the turn handed the CLI no prompt");
    return handed;
  };
  return { say };
}

/** A conversation whose first turn is over, so that the next one is pasted into the warm PTY. */
async function warm(sender: Sender) {
  const chat = conversation(sender);
  await chat.say("こんにちは");
  return chat;
}

describe("a chat message from somebody who is not the operator", () => {
  it.each<Sender>(["slack-stranger", "discord-stranger"])("is not run as /logout when it opens the conversation (%s)", async (sender) => {
    const handed = await conversation(sender).say("/logout");

    expect(claudeReads(handed)).toBe("text");
    expect(handed).toContain("/logout"); // still delivered, as words
  });

  it.each<Sender>(["slack-stranger", "discord-stranger"])("is not run as /logout when it is pasted into the running CLI (%s)", async (sender) => {
    const chat = await warm(sender);

    const handed = await chat.say("/logout");

    expect(claudeReads(handed)).toBe("text");
    expect(handed).toContain("/logout");
  });

  it.each([
    "/compact", "/clear", "/login", "/permissions", "/resume", "/config", "/mcp", "/hooks", "/agents",
    "/add-dir /", "/install-github-app", "/terminal-setup", "/bug", "/exit", "/remote-control",
  ])("cannot run %s either, cold or warm", async (command) => {
    expect(claudeReads(await conversation("slack-stranger").say(command))).toBe("text");
    expect(claudeReads(await (await warm("discord-stranger")).say(command))).toBe("text");
  });

  it.each([
    ["--dangerously-skip-permissions"],
    ["--mcp-config={\"mcpServers\":{\"x\":{\"command\":\"sh\"}}}"],
    ["-p"],
    ["- 牛乳\n- 卵"],
  ])("cannot hand the CLI an option by opening the conversation with %j", async (text) => {
    const handed = await conversation("slack-stranger").say(text);

    expect(claudeReads(handed)).toBe("text");
    expect(handed).toContain(text);
  });

  it.each([["!rm -rf ~"], ["exit"], [":q!"]])("cannot reach bash mode or quit the CLI with %j", async (text) => {
    expect(claudeReads(await conversation("discord-stranger").say(text))).toBe("text");
    expect(claudeReads(await (await warm("slack-stranger")).say(text))).toBe("text");
  });

  it.each([
    ["leading spaces", "   /logout"],
    ["a leading newline", "\n/logout"],
    ["a leading full-width space", "　/logout"],
    ["a leading byte-order mark", "﻿/logout"],
    ["a leading zero-width space", "​/logout"],
    ["a leading control character", "\u0001/logout"],
    ["a full-width slash", "／logout"],
    ["a doubled slash", "//logout"],
    ["capitals", "/LOGOUT"],
    ["arguments after it", "/logout now"],
    ["more lines after it", "/logout\nplease"],
  ])("gets nowhere with %s", async (_shape, text) => {
    const cold = await conversation("slack-stranger").say(text);
    const pasted = await (await warm("discord-stranger")).say(text);

    for (const handed of [cold, pasted]) {
      expect(claudeReads(handed)).toBe("text");
      expect(strictestClaudeReads(handed)).toBe("text");
    }
  });

  it("cannot end the paste from inside it and type a command after it", async () => {
    const chat = await warm("discord-stranger"); // Discord delivers a raw ESC: its ```ansi blocks are made of them

    const handed = await chat.say("hello\u001b[201~\r/logout\r");

    expect(handed).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/); // no ESC to end the paste, no CR to press Enter
    expect(claudeReads(handed)).toBe("text");
  });

  it("is delivered unchanged when the CLI would read it as text anyway", async () => {
    const chat = conversation("slack-stranger");

    expect(await chat.say("今日の予定を教えてください")).toBe("今日の予定を教えてください");
    expect(await chat.say("先に /logout してから入り直すのはどうですか")).toBe("先に /logout してから入り直すのはどうですか");
    expect(await chat.say("```\n/logout\n```")).toBe("```\n/logout\n```");
    expect(await chat.say("手順:\n/logout\n/login")).toBe("手順:\n/logout\n/login");
  });
});

describe("a chat message from the operator", () => {
  it.each<Sender>(["slack-operator", "discord-operator"])("is not run as /logout, /login, /permissions or /resume either (%s)", async (sender) => {
    for (const command of ["/logout", "/login", "/permissions", "/resume"]) {
      expect(claudeReads(await conversation(sender).say(command))).toBe("text");
      expect(claudeReads(await (await warm(sender)).say(command))).toBe("text");
    }
  });

  it.each<Sender>(["slack-operator", "discord-operator"])("still runs the commands that are allowed from chat (%s)", async (sender) => {
    expect(await conversation(sender).say("/compact")).toBe("/compact");
    expect(await (await warm(sender)).say("/compact 決定事項を残して")).toBe("/compact 決定事項を残して");
    expect(await (await warm(sender)).say("/clear")).toBe("/clear");
  });

  it("is allowed only commands the engine knows how to wait for", () => {
    // A command the engine does not classify as native would be waited on like
    // a model turn that never ends.
    for (const command of OPERATOR_NATIVE_COMMANDS.keys()) expect(isNativeClaudeCommand(command)).toBe(true);
  });

  it("cannot hand the CLI an option or reach bash mode from chat", async () => {
    expect(claudeReads(await conversation("slack-operator").say("--resume"))).toBe("text");
    expect(claudeReads(await (await warm("slack-operator")).say("!ls"))).toBe("text");
  });
});

describe("/goal, which the gateway itself hands to the CLI", () => {
  it.each<Sender>(["slack-stranger", "slack-operator", "discord-stranger"])("still reaches it from %s", async (sender) => {
    expect(await conversation(sender).say("/goal レポートを仕上げる")).toBe("/goal レポートを仕上げる");
  });
});
