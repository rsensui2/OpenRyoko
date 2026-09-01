/**
 * Agents View for Slack — a self-updating Canvas that mirrors OpenRyoko's
 * current sessions, inspired by Claude Code v2.1.139's `claude agents`.
 *
 * Data source: OpenRyoko's own session registry (SQLite via `listSessions()`).
 * NOT `~/.claude/daemon/roster.json` — that file is populated only by
 * `claude --bg` background sessions, and OpenRyoko currently spawns one-shot
 * `claude -p` sessions, so its sessions never appear there.
 *
 * Lifecycle: started by SlackConnector when `agentsCanvas.enabled === true`.
 * Polls the session registry every `pollIntervalMs` (default 30s), renders
 * a Markdown summary, and pushes it into a single Slack Canvas. The canvas
 * is created on first run and reused afterwards; its ID is persisted under
 * `${JINN_HOME}/.agents-canvas-state.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { Session } from "../../shared/types.js";
import { listSessions } from "../../sessions/registry.js";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

export interface AgentsCanvasConfig {
  enabled?: boolean;
  /** Slack channel to host the canvas. If unset, a standalone canvas is created. */
  channelId?: string;
  /** Display title. Defaults to "Ryoko Agents View". */
  title?: string;
  /** Polling interval in ms. Default 30s. */
  pollIntervalMs?: number;
  /** Max number of sessions shown per state group. Default 10. */
  maxPerGroup?: number;
}

interface PersistedState {
  canvasId?: string;
  channelId?: string;
}

const STATE_FILE = path.join(JINN_HOME, ".agents-canvas-state.json");
const DEFAULT_TITLE = "Ryoko Agents View";
const DEFAULT_POLL_MS = 30_000;
const MIN_POLL_MS = 5_000;
const DEFAULT_MAX_PER_GROUP = 10;
/**
 * Self-disable the canvas loop after this many consecutive tick failures.
 * At the default 30s interval this is ~5 minutes of solid failures — long
 * enough to ride out transient Slack hiccups, short enough that a genuinely
 * broken canvas (missing scope, deleted channel, etc.) stops spamming the
 * logs and Slack API instead of failing every 30s forever.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

type SessionStateGroup = "running" | "waiting" | "interrupted" | "error" | "idle";

interface GroupedSessions {
  running: Session[];
  waiting: Session[];
  interrupted: Session[];
  error: Session[];
  idle: Session[];
}

/** Map a Session.status to its presentation group. */
function groupOf(s: Session): SessionStateGroup {
  switch (s.status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

function groupSessions(sessions: Session[]): GroupedSessions {
  const out: GroupedSessions = {
    running: [],
    waiting: [],
    interrupted: [],
    error: [],
    idle: [],
  };
  for (const s of sessions) {
    out[groupOf(s)].push(s);
  }
  return out;
}

/** Round a millisecond duration into "Xm" / "Xh" / "Xd" — never longer than 5 chars. */
function formatAge(fromIso: string, nowMs: number): string {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return "?";
  const diffMs = Math.max(0, nowMs - t);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Make a user-controlled string safe to embed in the Canvas Markdown body.
 * Strips control characters and newlines (which would break list items) and
 * defangs Slack mention / link syntax + Markdown emphasis characters that
 * could otherwise turn a session title into an @channel ping or a heading.
 */
// Built via new RegExp so the source text is plain ASCII — embedding raw
// control bytes in a regex literal trips some editor / tool pipelines.
const CANVAS_CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

function escapeForCanvas(input: string): string {
  const stripped = input.replace(CANVAS_CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  return (
    stripped
      // Slack user / channel / group / link mentions: <@U…>, <#C…>, <#C…|name>, <!subteam^…>, <!here>, <!channel>, <!everyone>, <http…>, <mailto:…>.
      // Strip the entire <…> shell so the residue cannot be parsed by
      // Slack's renderer as a mention. We replace with a neutral placeholder
      // for entity-like forms and keep visible link text for the rest.
      .replace(/<!(channel|here|everyone)>/gi, "($1)")
      .replace(/<!subteam\^[^>]*?\|([^>]*)>/g, "$1")
      .replace(/<!subteam\^[^>]*>/g, "(group)")
      .replace(/<@[UW][^>|]*\|([^>]*)>/g, "$1")
      .replace(/<@[UW][^>]*>/g, "(user)")
      .replace(/<#[CDG][^>|]*\|([^>]*)>/g, "#$1")
      .replace(/<#[CDG][^>]*>/g, "(channel)")
      // Generic <url|label> link — keep the human label
      .replace(/<([^<>]*?)\|([^<>]*?)>/g, "$2")
      // Anything else inside <…> — strip the brackets to prevent residual parsing
      .replace(/<([^<>]*)>/g, "$1")
      // Bare @channel / @here / @everyone (no angle brackets) — zero-width space split
      .replace(/(^|[^A-Za-z0-9_])@(channel|here|everyone)\b/gi, "$1@\u200b$2")
      // Markdown emphasis / code / heading / blockquote / table / strikethrough characters — escape so they render literally
      .replace(/([*_`~>#|\\\[\]])/g, "\\$1")
  );
}

function safeTitle(s: Session): string {
  const raw = (s.title || s.sessionKey || s.id || "untitled");
  const escaped = escapeForCanvas(raw);
  return escaped.length > 80 ? escaped.slice(0, 77) + "…" : escaped;
}

function locationOf(s: Session): string {
  const parts: string[] = [];
  if (s.connector) parts.push(escapeForCanvas(s.connector));
  if (s.source && s.source !== s.connector) parts.push(escapeForCanvas(s.source));
  if (s.employee) parts.push("@" + escapeForCanvas(s.employee));
  return parts.join(" · ");
}

function renderSessionLine(s: Session, nowMs: number): string {
  const title = safeTitle(s);
  const age = formatAge(s.lastActivity, nowMs);
  const loc = locationOf(s);
  const meta = loc ? ` _(${loc})_` : "";
  return `- **${title}**${meta} — ${age}`;
}

const GROUP_HEADERS: Array<{ key: keyof GroupedSessions; emoji: string; label: string }> = [
  { key: "running", emoji: "🟢", label: "Running" },
  { key: "waiting", emoji: "🟡", label: "Waiting on you" },
  { key: "error", emoji: "🔴", label: "Errored" },
  { key: "interrupted", emoji: "⏸️", label: "Interrupted (resumable)" },
  { key: "idle", emoji: "✅", label: "Recently idle" },
];

/**
 * Pure renderer. Exported so it can be unit-tested without spawning a Slack
 * client. `nowMs` is injectable for deterministic snapshots.
 */
export function renderCanvasMarkdown(
  sessions: Session[],
  opts: { title?: string; nowMs?: number; maxPerGroup?: number } = {},
): string {
  const title = opts.title || DEFAULT_TITLE;
  const nowMs = opts.nowMs ?? Date.now();
  const maxPerGroup = Math.max(1, opts.maxPerGroup ?? DEFAULT_MAX_PER_GROUP);
  const grouped = groupSessions(sessions);

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  const total = sessions.length;
  const updated = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  lines.push(`_${total} session${total === 1 ? "" : "s"} · updated ${updated}_`);
  lines.push("");

  let wroteAny = false;
  for (const { key, emoji, label } of GROUP_HEADERS) {
    const bucket = grouped[key];
    if (bucket.length === 0) continue;
    wroteAny = true;
    lines.push(`## ${emoji} ${label} (${bucket.length})`);
    const shown = bucket.slice(0, maxPerGroup);
    for (const s of shown) {
      lines.push(renderSessionLine(s, nowMs));
    }
    if (bucket.length > shown.length) {
      lines.push(`- _…and ${bucket.length - shown.length} more_`);
    }
    lines.push("");
  }

  if (!wroteAny) {
    lines.push("_No active sessions._");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function loadState(): PersistedState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PersistedState;
  } catch { /* missing or unreadable → fresh state */ }
  return {};
}

function saveState(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logger.warn(`[agents-canvas] failed to persist state: ${err}`);
  }
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Manages the lifecycle of the Agents View canvas: periodically polls the
 * session registry, renders Markdown, and pushes it to Slack.
 */
export class AgentsCanvasUpdater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private stopped = false;
  /** Consecutive tick() failures — resets to 0 on any successful tick. */
  private consecutiveFailures = 0;
  private canvasId: string | null = null;
  private lastMarkdown: string | null = null;
  private readonly client: SlackClientLike;
  private readonly config: Required<Omit<AgentsCanvasConfig, "channelId" | "enabled">> & {
    channelId?: string;
    enabled: boolean;
  };

  constructor(app: App, config: AgentsCanvasConfig) {
    this.client = app.client as unknown as SlackClientLike;
    this.config = {
      enabled: config.enabled !== false,
      channelId: config.channelId,
      title: config.title || DEFAULT_TITLE,
      pollIntervalMs: Math.max(MIN_POLL_MS, config.pollIntervalMs ?? DEFAULT_POLL_MS),
      maxPerGroup: config.maxPerGroup ?? DEFAULT_MAX_PER_GROUP,
    };

    const persisted = loadState();
    if (persisted.canvasId && persisted.channelId === this.config.channelId) {
      this.canvasId = persisted.canvasId;
    }
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info("[agents-canvas] disabled by config");
      return;
    }
    if (this.timer) return; // already running — make start() idempotent
    this.stopped = false;
    this.consecutiveFailures = 0;
    logger.info(
      `[agents-canvas] starting (interval=${this.config.pollIntervalMs}ms, channel=${this.config.channelId || "standalone"})`,
    );
    // Kick off an immediate update so the canvas reflects current state at boot.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inflight || this.stopped) return;
    this.inflight = true;
    try {
      const sessions = listSessions();
      const markdown = renderCanvasMarkdown(sessions, {
        title: this.config.title,
        maxPerGroup: this.config.maxPerGroup,
      });
      // Skip no-op updates to spare Slack API calls + avoid edit churn.
      if (markdown === this.lastMarkdown) {
        this.consecutiveFailures = 0;
        return;
      }
      // stop() may have fired while we were rendering — bail before any I/O.
      if (this.stopped) return;
      const published = await this.publish(markdown);
      if (published) {
        this.lastMarkdown = markdown;
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      logger.warn(
        `[agents-canvas] tick failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err}`,
      );
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          `[agents-canvas] disabling after ${this.consecutiveFailures} consecutive failures — ` +
            `last error: ${err}. Fix the cause and restart the gateway to re-enable.`,
        );
        this.stop();
      }
    } finally {
      this.inflight = false;
    }
  }

  private async publish(markdown: string): Promise<boolean> {
    if (!this.canvasId) {
      await this.createCanvas(markdown);
      return true;
    }
    try {
      await this.editCanvas(this.canvasId, markdown);
      return true;
    } catch (err) {
      if (isCanvasNotFoundError(err)) {
        logger.warn(`[agents-canvas] edit target is gone, will try recreating: ${err}`);
        // The persisted canvas may have been deleted by the user; drop the ID
        // and let the next tick re-create it.
        this.canvasId = null;
        saveState({ canvasId: undefined, channelId: this.config.channelId });
      } else {
        logger.warn(`[agents-canvas] edit failed, keeping existing canvas id to avoid duplicate canvases: ${err}`);
      }
      return false;
    }
  }

  private async createCanvas(markdown: string): Promise<void> {
    const documentContent = { type: "markdown", markdown };
    if (this.config.channelId) {
      try {
        const res = await this.client.apiCall("conversations.canvases.create", {
          channel_id: this.config.channelId,
          document_content: documentContent,
          title: this.config.title,
        });
        const canvasId = extractCanvasId(res);
        if (!canvasId) {
          throw new Error(`conversations.canvases.create returned no canvas_id: ${JSON.stringify(res).slice(0, 200)}`);
        }
        this.canvasId = canvasId;
      } catch (err) {
        // Recover from two Slack failure modes:
        //   - `channel_canvas_already_exists`: this channel already has a canvas.
        //   - `free_team_canvas_tab_already_exists`: free plan has used its one
        //     allowed canvas (anywhere in the workspace).
        // For both, find the existing canvas and edit it instead of looping.
        if (isChannelCanvasAlreadyExistsError(err) || isFreeTeamCanvasAlreadyExistsError(err)) {
          const existingId =
            (await this.fetchExistingChannelCanvasId(this.config.channelId))
            ?? (await this.findExistingStandaloneCanvasId());
          if (existingId) {
            logger.info(`[agents-canvas] adopting existing canvas ${existingId}`);
            this.canvasId = existingId;
            saveState({ canvasId: existingId, channelId: this.config.channelId });
            await this.editCanvas(existingId, markdown);
            return;
          }
          logger.error(
            "[agents-canvas] canvas already exists per Slack but none could be located — disabling updates to stop the retry loop.",
          );
          this.stop();
          return;
        }
        throw err;
      }
    } else {
      try {
        const res = await this.client.apiCall("canvases.create", {
          title: this.config.title,
          document_content: documentContent,
        });
        const canvasId = extractCanvasId(res);
        if (!canvasId) {
          throw new Error(`canvases.create returned no canvas_id: ${JSON.stringify(res).slice(0, 200)}`);
        }
        this.canvasId = canvasId;
      } catch (err) {
        // Free Slack workspaces are limited to a single standalone canvas. If
        // one already exists (e.g. left over from a previous run), adopt it
        // instead of looping forever on the create call.
        if (isFreeTeamCanvasAlreadyExistsError(err)) {
          const existingId = await this.findExistingStandaloneCanvasId();
          if (existingId) {
            logger.info(`[agents-canvas] adopting existing standalone canvas ${existingId}`);
            this.canvasId = existingId;
            saveState({ canvasId: existingId, channelId: this.config.channelId });
            await this.editCanvas(existingId, markdown);
            return;
          }
          logger.error(
            "[agents-canvas] free workspace standalone canvas limit reached and no existing canvas matched by title — disabling updates. Set agentsCanvas.channelId to host the canvas in a channel instead.",
          );
          this.stop();
          return;
        }
        throw err;
      }
    }
    saveState({ canvasId: this.canvasId, channelId: this.config.channelId });
    logger.info(`[agents-canvas] created canvas ${this.canvasId}`);
  }

  private async findExistingStandaloneCanvasId(): Promise<string | null> {
    try {
      const res = await this.client.apiCall("files.list", {
        types: "canvases",
        count: 100,
      });
      const files = res.files as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(files)) return null;
      const match = files.find((f) => typeof f.title === "string" && f.title === this.config.title)
        ?? files.find((f) => typeof f.name === "string" && f.name === this.config.title);
      const id = match?.id;
      return typeof id === "string" && id ? id : null;
    } catch (err) {
      logger.warn(`[agents-canvas] failed to look up existing standalone canvas: ${err}`);
      return null;
    }
  }

  private async fetchExistingChannelCanvasId(channelId: string): Promise<string | null> {
    try {
      const info = await this.client.apiCall("conversations.info", { channel: channelId });
      const channel = info.channel as Record<string, unknown> | undefined;
      const properties = channel?.properties as Record<string, unknown> | undefined;
      const canvas = properties?.canvas as Record<string, unknown> | undefined;
      const id = canvas?.file_id ?? canvas?.id;
      return typeof id === "string" && id ? id : null;
    } catch (err) {
      logger.warn(`[agents-canvas] failed to fetch existing channel canvas: ${err}`);
      return null;
    }
  }

  private async editCanvas(canvasId: string, markdown: string): Promise<void> {
    await this.client.apiCall("canvases.edit", {
      canvas_id: canvasId,
      changes: [
        {
          operation: "replace",
          document_content: { type: "markdown", markdown },
        },
      ],
    });
  }
}

function extractCanvasId(res: Record<string, unknown>): string | null {
  const direct = res.canvas_id;
  if (typeof direct === "string" && direct) return direct;
  const canvas = res.canvas as Record<string, unknown> | undefined;
  if (canvas && typeof canvas.id === "string") return canvas.id;
  return null;
}

function isChannelCanvasAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error === "channel_canvas_already_exists") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /channel_canvas_already_exists/.test(msg);
}

function isCanvasNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const data = (err as { data?: { error?: string } }).data;
  const code = data?.error;
  if (code && /(?:not_found|notfound|missing|deleted)/i.test(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /(?:canvas|file).*(?:not_found|not found|missing|deleted)|(?:not_found|not found|missing|deleted).*(?:canvas|file)/i.test(msg);
}

function isFreeTeamCanvasAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error === "free_team_canvas_tab_already_exists") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /free_team_canvas_tab_already_exists/.test(msg);
}
