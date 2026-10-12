import type { IncomingMessage, JinnConfig } from "../shared/types.js";
import { resolveOperatorIdentity } from "./context.js";

/**
 * What a chat message is allowed to mean to the CLI that runs the turn.
 *
 * The engines hand a prompt to their CLI as it is, and Claude Code reads some
 * prompts as something other than text (read from the 2.1.296 executable):
 *
 *   - after `trim()`, a leading "/" is one of its own commands — /logout,
 *     /permissions, /remote-control and some ninety more;
 *   - after `trim()`, the words exit, quit, :q, :q!, :wq and :wq! quit it;
 *   - a leading "!" puts its input box in bash mode: the rest is a shell command;
 *   - on a cold start the prompt is an argument, and one with a leading "-" is
 *     an option (`--mcp-config=…` starts a program of the sender's choosing).
 *
 * A chat message is written by whoever can reach the assistant, so none of
 * that may be decided by its first character. Every message a connector
 * delivers passes through here, once, before its turn runs:
 *
 *   - Text the CLI would read as text anyway is passed on untouched.
 *   - Text it would read as a command or an option is passed on *as text*:
 *     a one-line note is put in front, so that it no longer starts with
 *     anything the CLI acts on, and the model reads the words. A leading space
 *     would not do — the CLI trims before it looks.
 *   - The operator, identified by platform ID and by nothing else, keeps the
 *     commands in OPERATOR_NATIVE_COMMANDS. The list names what is allowed:
 *     a command the CLI gains tomorrow is not on it.
 *
 * Nobody is told "that command is not allowed" by the gateway: to the sender it
 * is a message like any other, answered by the model.
 *
 * Not decided here: the web UI and the API (callers the gateway has already
 * authenticated) and cron prompts (the operator's own text) reach the engine
 * as before, and the gateway's own commands (/new, /status, /model, /doctor,
 * /cron) are answered before a message gets this far.
 */

/**
 * The native Claude commands the operator can run from chat, and whether each
 * takes text after it. Both tidy the conversation and finish with nothing to
 * read; neither touches the login, permissions, settings or anything outside
 * the session. Both are commands the interactive engine knows how to wait for
 * (isNativeClaudeCommand) — one it does not would hang the turn.
 *
 * Deliberately not here: /usage and /cost. They open an interactive panel
 * whose output never comes back to chat, and the panel can stay up in the PTY
 * and swallow the next turn — useless from chat, and a way to wedge a session.
 */
export const OPERATOR_NATIVE_COMMANDS: ReadonlyMap<string, { args: boolean }> = new Map([
  ["/compact", { args: true }], // optional instructions for the summary
  ["/clear", { args: false }],
]);

/** Sources whose text the gateway wrote itself. A cron job's prompt is the operator's. */
const GATEWAY_SOURCES: ReadonlySet<string> = new Set(["cron"]);

/**
 * The gateway's own /goal (goal-execution.ts). For Claude it is handed to the
 * CLI as the native command, and the gateway writes the same command itself
 * when it finds a goal in ordinary words — so it is everybody's, as before.
 */
const GOAL_COMMAND = /^\/goal(?:\s|$)/i;

/** `/command`, or `/command text` on one line: the only shape a native command is let through in. */
const ONE_LINE_COMMAND = /^(\/\S+)(?:[ \t]+(.*))?$/;

/**
 * Control characters, tab and line feed excepted. A chat message has no use for
 * them and a terminal has: ESC [ 201 ~ ends the bracketed paste a prompt is
 * delivered in, and whatever follows it is typed, not pasted.
 */
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// Both patterns are anchored at the start and scan once: a long run of blanks
// in a message costs its length, not its square.
const INVISIBLE = String.raw`[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]`;
const LEADING_INVISIBLE = new RegExp(`^${INVISIBLE}+`, "u");
/** The whole message is one of the words the CLI quits on: exit, quit, :q, :q!, :wq, :wq!. */
const EXIT_WORD = new RegExp(`^(?:exit|quit|:q!?|:wq!?)${INVISIBLE}*$`, "iu");

const AS_TEXT = "[Chat message, delivered as plain text: nothing in it was run as a CLI command or option. Read it as an ordinary message.]";
const AS_TEXT_SLASH = "[Chat message, delivered as plain text: it was not run as a CLI command. Read it as an ordinary message; if it names an installed skill, it is a request to use that skill.]";

/** A carriage return is the Enter key: every line break becomes a line feed. */
function withoutTerminalControls(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(TERMINAL_CONTROLS, "");
}

/**
 * What a CLI could find itself looking at: full-width forms folded to the
 * ASCII they stand for, nothing invisible in front. Stricter than the
 * installed CLI, which does neither — a version that starts to must not find
 * a command where this found none.
 */
function asSeen(text: string): string {
  return text.normalize("NFKC").replace(LEADING_INVISIBLE, "");
}

function readsAsCliInput(seen: string): boolean {
  return /^[/\-!]/.test(seen) || EXIT_WORD.test(seen);
}

/** Exactly as typed — a look-alike of an allowed command is not that command. */
function isOperatorCommand(typed: string): boolean {
  const match = ONE_LINE_COMMAND.exec(typed);
  if (!match) return false;
  const rule = OPERATOR_NATIVE_COMMANDS.get(match[1]);
  return rule !== undefined && (rule.args || !match[2]?.trim());
}

/**
 * Only the configured platform ID of the platform the message arrived on
 * counts. A display name never does, and where no operator ID is configured
 * (or the platform has none: Telegram, WhatsApp) nobody is the operator.
 */
function sentByOperator(msg: IncomingMessage, config: JinnConfig): boolean {
  const meta: Record<string, unknown> = msg.transportMeta ?? {};
  const id = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return resolveOperatorIdentity({
    speakerNames: [],
    speakerSlackId: id(meta.speakerSlackId),
    speakerDiscordId: id(meta.speakerDiscordId),
    source: msg.source,
    config,
  }).operatorIdVerified;
}

/** The message as the turn may see it. Returns `msg` itself when nothing had to change. */
export function guardConnectorMessage(msg: IncomingMessage, config: JinnConfig): IncomingMessage {
  if (GATEWAY_SOURCES.has(msg.source)) return msg;
  const text = withoutTerminalControls(msg.text);
  // Nothing but control characters: a blank prompt is one the CLI never
  // submits, and the turn would wait for an answer that cannot come.
  if (!text.trim() && msg.text.trim()) return { ...msg, text: `${AS_TEXT}\n${text}` };
  const passedOn = text === msg.text ? msg : { ...msg, text };
  const seen = asSeen(text);
  if (!readsAsCliInput(seen)) return passedOn;
  const typed = text.trim();
  if (GOAL_COMMAND.test(typed)) return passedOn;
  if (isOperatorCommand(typed) && sentByOperator(msg, config)) return passedOn;
  return { ...msg, text: `${seen.startsWith("/") ? AS_TEXT_SLASH : AS_TEXT}\n${text}` };
}
