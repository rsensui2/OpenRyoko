/**
 * Bounded conversational context for Slack's air-reading gate.
 *
 * Reactions do not grant reply permission. Actual replies open a short-lived
 * conversation; explicitly recorded requests for input survive the idle window
 * until an accepted answer or completion. Merely observing a human message must
 * not renew permission or consume a pending question (the message can still be
 * rejected by other connector gates).
 *
 * Thread keys share human participants. Top-level keys are channel + user so
 * unrelated traffic elsewhere in a channel does not interrupt directed replies.
 * Optional private snapshots retain IDs and state across restarts, never message
 * content. Capacity pressure can evict even pending questions as a last resort.
 * Missing or corrupt context always falls back to normal triage.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "../../shared/logger.js";

export interface ConversationKeyInput {
  channel: string;
  threadTs?: string;
  ts?: string;
  userId: string;
}

export type ConversationStatus = "none" | "reacted" | "conversing" | "awaiting_input" | "completed";
export type ConversationActor = "human" | "bot" | "bot_reaction";

export interface ConversationTrackerOptions {
  now?: () => number;
  idleTimeoutMs?: number;
  maxEntries?: number;
  /** Optional private JSON snapshot; omit for process-local operation. */
  statePath?: string;
}

export interface BotReplyOptions {
  /** Set only from an explicit pending-input signal, never from engagement alone. */
  awaitingInput?: boolean;
  completed?: boolean;
  /** Slack timestamp of the outgoing message, if available. */
  messageTs?: string;
}

export interface ConversationContext {
  status: ConversationStatus;
  /** Capped at two: 2 means a multi-human conversation. */
  humanSpeakerCount: number;
  lastActor: ConversationActor | null;
  lastHumanUserId: string | null;
  lastMessageTs: string | null;
  lastMessageAt: number | null;
  lastBotMessageAt: number | null;
  /** Actual last bot reply, retained independently of later human observations. */
  lastBotMessageTs: string | null;
  awaitingUserId: string | null;
  botCreatedThread: boolean;
  /** Time since the last accepted conversational turn, not passive observation. */
  idleMs: number | null;
}

interface ConversationState {
  // Two identities are enough to disqualify one-to-one bypass, and bound memory
  // even when a long-lived thread contains thousands of different speakers.
  humanSpeakers: Set<string>;
  status: ConversationStatus;
  lastActor: ConversationActor | null;
  lastHumanUserId: string | null;
  lastMessageTs: string | null;
  lastMessageAt: number | null;
  lastBotMessageAt: number | null;
  lastBotMessageTs: string | null;
  lastConversationActivityAt: number | null;
  awaitingUserId: string | null;
  botCreatedThread: boolean;
  hasBotReply: boolean;
  hasKnownRecipient: boolean;
  /** Reciprocal root/thread link; a newer root can replace a user's alias. */
  linkedThreadTs: string | null;
  rootUserId: string | null;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_ID = /^[A-Za-z0-9_.-]{1,256}$/;
const SNAPSHOT_KEY = /^[A-Za-z0-9_-]{1,256}:(?:thread|user):[A-Za-z0-9_.-]{1,256}$/;

export class ConversationTracker {
  private readonly entries = new Map<string, ConversationState>();
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly maxEntries: number;
  private readonly statePath?: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;

  constructor(options: ConversationTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.statePath = options.statePath || undefined;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new Error("Conversation idleTimeoutMs must be finite and non-negative");
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("Conversation maxEntries must be a positive integer");
    }
    this.loadSnapshot();
  }

  static keyFor(input: ConversationKeyInput): string | null {
    if (!input.channel || !input.userId) return null;
    if (input.threadTs && input.threadTs !== input.ts) {
      return `${input.channel}:thread:${input.threadTs}`;
    }
    return `${input.channel}:user:${input.userId}`;
  }

  /** Observe a message without assuming that it is addressed to the bot. */
  recordHumanMessage(input: ConversationKeyInput): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    const state = this.getOrCreate(key);
    this.addSpeaker(state, input.userId);
    state.lastActor = "human";
    state.lastHumanUserId = input.userId;
    state.lastMessageTs = input.ts ?? null;
    state.lastMessageAt = this.now();
    this.touch(key, state);
  }

  /**
   * Call only after all receive gates accept this message for dispatch. This is
   * the point at which a pending answer can be consumed, not recordHumanMessage.
   * Acceptance alone does not create engagement before the bot actually replies.
   */
  recordAcceptedMessage(input: ConversationKeyInput): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    const state = this.entries.get(key);
    if (!state) return;
    this.acceptMessage(state, input.userId);
    this.touch(key, state);
    const linked = this.linkedEntry(key, state);
    if (linked) {
      this.acceptMessage(linked[1], input.userId);
      this.touch(...linked);
    }
  }

  private acceptMessage(state: ConversationState, userId: string): void {
    this.expire(state);
    if (state.hasBotReply && state.humanSpeakers.size === 1 && state.humanSpeakers.has(userId)) {
      state.hasKnownRecipient = true;
    }
    if (state.status === "awaiting_input" &&
        (state.awaitingUserId === null || state.awaitingUserId === userId)) {
      state.status = "conversing";
      state.awaitingUserId = null;
      state.lastConversationActivityAt = this.now();
    } else if (state.status === "conversing") {
      state.lastConversationActivityAt = this.now();
    }
  }

  /** Link only an attributed root reply to its actual derived Slack thread. */
  linkRootConversation(channel: string, userId: string, threadTs: string): void {
    const rootKey = `${channel}:user:${userId}`;
    const threadKey = `${channel}:thread:${threadTs}`;
    const root = this.entries.get(rootKey);
    const thread = this.entries.get(threadKey);
    if (!root?.hasBotReply || !thread?.hasBotReply) return;
    root.linkedThreadTs = threadTs;
    thread.rootUserId = userId;
    this.touch(rootKey, root);
    this.touch(threadKey, thread);
  }

  private linkedEntry(key: string, state: ConversationState): [string, ConversationState] | undefined {
    const [channel, kind, id] = key.split(":");
    if (kind === "user" && state.linkedThreadTs) {
      const otherKey = `${channel}:thread:${state.linkedThreadTs}`;
      const other = this.entries.get(otherKey);
      if (other?.rootUserId === id) return [otherKey, other];
    } else if (kind === "thread" && state.rootUserId) {
      const otherKey = `${channel}:user:${state.rootUserId}`;
      const other = this.entries.get(otherKey);
      if (other?.linkedThreadTs === id) return [otherKey, other];
    }
    return undefined;
  }

  /** A reaction acknowledges a message; it never opens or renews a conversation. */
  recordBotReaction(input: ConversationKeyInput): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    const state = this.getOrCreate(key);
    this.addSpeaker(state, input.userId);
    if (state.status === "none") state.status = "reacted";
    state.lastActor = "bot_reaction";
    state.lastMessageAt = this.now();
    this.touch(key, state);
  }

  /** Backwards-compatible name; call for an actual reply, never a reaction. */
  recordBotEngaged(input: ConversationKeyInput): void {
    this.recordBotReply(input);
  }

  recordBotReply(input: ConversationKeyInput, options: BotReplyOptions = {}): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    this.markReply(key, input.userId, options);
  }

  /** Record an actual reply to an existing thread when user attribution is unavailable. */
  recordBotThreadReply(channel: string, threadTs: string, options: BotReplyOptions = {}): void {
    if (!channel || !threadTs) return;
    this.markReply(`${channel}:thread:${threadTs}`, undefined, options);
  }

  /** Mark an actual root posted by the bot, as distinct from an existing-thread reply. */
  recordBotInitiatedThread(channel: string, threadTs: string, options: BotReplyOptions = {}): void {
    if (!channel || !threadTs) return;
    const key = `${channel}:thread:${threadTs}`;
    this.markReply(key, undefined, options, true);
  }

  recordAwaitingInput(input: ConversationKeyInput): void {
    this.recordBotReply(input, { awaitingInput: true });
  }

  recordCompleted(input: ConversationKeyInput): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    this.markState(key, "completed");
  }

  /** Apply structured runtime state to the original channel/user or thread key. */
  setConversationState(input: ConversationKeyInput, status: "awaiting_input" | "completed"): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    this.markState(key, status, input.userId);
  }

  /** Update known runtime task state without fabricating a bot message or reply. */
  setThreadState(
    channel: string,
    threadTs: string,
    status: "awaiting_input" | "completed",
    userId?: string,
  ): void {
    if (!channel || !threadTs) return;
    this.markState(`${channel}:thread:${threadTs}`, status, userId);
  }

  private markState(key: string, status: "awaiting_input" | "completed", userId?: string): void {
    const state = this.getOrCreate(key);
    this.applyState(state, status, userId);
    this.touch(key, state);
    const linked = this.linkedEntry(key, state);
    if (linked) {
      this.applyState(linked[1], status, userId);
      this.touch(...linked);
    }
  }

  private applyState(state: ConversationState, status: "awaiting_input" | "completed", userId?: string): void {
    if (userId) {
      this.addSpeaker(state, userId);
      state.hasKnownRecipient = true;
    }
    state.status = status;
    state.awaitingUserId = status === "awaiting_input" ? userId ?? null : null;
  }

  isDmEquivalent(input: ConversationKeyInput): boolean {
    const key = ConversationTracker.keyFor(input);
    if (!key) return false;
    const state = this.entries.get(key);
    if (!state) return false;
    this.expire(state);
    return this.isActive(state) &&
      (state.botCreatedThread || state.hasKnownRecipient) &&
      state.humanSpeakers.size === 1 &&
      state.humanSpeakers.has(input.userId) &&
      (state.status !== "awaiting_input" || state.awaitingUserId === null ||
        state.awaitingUserId === input.userId);
  }

  /** Reactions alone cannot expand the deterministic respondTo gate. */
  isBotEngagedThread(channel: string, threadTs: string): boolean {
    if (!channel || !threadTs) return false;
    const state = this.entries.get(`${channel}:thread:${threadTs}`);
    if (!state) return false;
    this.expire(state);
    return state.hasBotReply;
  }

  getContext(input: ConversationKeyInput): ConversationContext {
    const key = ConversationTracker.keyFor(input);
    const state = key ? this.entries.get(key) : undefined;
    if (state) this.expire(state);
    return {
      status: state?.status ?? "none",
      humanSpeakerCount: state?.humanSpeakers.size ?? 0,
      lastActor: state?.lastActor ?? null,
      lastHumanUserId: state?.lastHumanUserId ?? null,
      lastMessageTs: state?.lastMessageTs ?? null,
      lastMessageAt: state?.lastMessageAt ?? null,
      lastBotMessageAt: state?.lastBotMessageAt ?? null,
      lastBotMessageTs: state?.lastBotMessageTs ?? null,
      awaitingUserId: state?.awaitingUserId ?? null,
      botCreatedThread: state?.botCreatedThread ?? false,
      idleMs: state?.lastConversationActivityAt == null
        ? null : Math.max(0, this.now() - state.lastConversationActivityAt),
    };
  }

  size(): number {
    return this.entries.size;
  }

  invalidate(key: string): void {
    const persisted = this.entries.get(key);
    this.entries.delete(key);
    if (persisted && this.shouldPersist(persisted)) this.schedulePersist();
  }

  /** Flush the debounce on connector shutdown; persistence failures are nonfatal. */
  flush(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.statePath || !this.dirty) return;
    let temporaryPath: string | undefined;
    try {
      const eligible = [...this.entries].map(([key, state], index) => ({ key, state, index }))
        .filter(({ key, state }) => this.shouldPersist(state) && SNAPSHOT_KEY.test(key));
      // Choose the most valuable/recent entries under the byte cap, then restore
      // LRU order. A pathologically large snapshot cannot grow without bound.
      eligible.reverse().sort((a, b) => this.priority(b.state) - this.priority(a.state));
      const selected: Array<{ index: number; json: string }> = [];
      let bytes = Buffer.byteLength('{"version":1,"entries":[]}');
      for (const { key, state, index } of eligible) {
        this.expire(state);
        const raw = { ...state, humanSpeakers: [...state.humanSpeakers] };
        if (!this.parseState(raw)) continue;
        const json = JSON.stringify({ key, state: raw });
        const nextBytes = Buffer.byteLength(json) + (selected.length > 0 ? 1 : 0);
        if (bytes + nextBytes > MAX_SNAPSHOT_BYTES) continue;
        bytes += nextBytes;
        selected.push({ index, json });
      }
      selected.sort((a, b) => a.index - b.index);
      const snapshot = '{"version":1,"entries":[' + selected.map((entry) => entry.json).join(",") + ']}';
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      fs.writeFileSync(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporaryPath, this.statePath);
      this.dirty = false;
    } catch {
      logger.warn("[slack] conversation snapshot could not be saved; continuing with in-memory context");
    } finally {
      if (temporaryPath) {
        try { fs.unlinkSync(temporaryPath); } catch { /* already renamed, or unavailable */ }
      }
    }
  }

  private isActive(state: ConversationState): boolean {
    return state.status === "conversing" || state.status === "awaiting_input";
  }

  private expire(state: ConversationState): void {
    if (state.status === "conversing" && state.lastConversationActivityAt !== null &&
        this.now() - state.lastConversationActivityAt >= this.idleTimeoutMs) {
      state.status = "none";
      state.awaitingUserId = null;
    }
  }

  private getOrCreate(key: string): ConversationState {
    const existing = this.entries.get(key);
    if (existing) {
      this.expire(existing);
      return existing;
    }
    return {
      humanSpeakers: new Set(), status: "none", lastActor: null,
      lastHumanUserId: null, lastMessageTs: null, lastMessageAt: null,
      lastBotMessageAt: null, lastBotMessageTs: null, lastConversationActivityAt: null,
      awaitingUserId: null, botCreatedThread: false, hasBotReply: false, hasKnownRecipient: false,
      linkedThreadTs: null, rootUserId: null,
    };
  }

  private addSpeaker(state: ConversationState, userId: string): void {
    if (state.humanSpeakers.size < 2) state.humanSpeakers.add(userId);
  }

  private markReply(
    key: string,
    userId: string | undefined,
    options: BotReplyOptions,
    botCreatedThread = false,
  ): void {
    const state = this.getOrCreate(key);
    if (userId) this.addSpeaker(state, userId);
    state.hasKnownRecipient ||= Boolean(userId) || state.humanSpeakers.size > 0;
    state.status = options.completed ? "completed"
      : options.awaitingInput ? "awaiting_input" : "conversing";
    state.awaitingUserId = options.awaitingInput && !options.completed ? userId ?? null : null;
    state.botCreatedThread ||= botCreatedThread;
    state.hasBotReply = true;
    state.lastActor = "bot";
    state.lastMessageTs = options.messageTs ?? null;
    state.lastMessageAt = this.now();
    state.lastBotMessageAt = state.lastMessageAt;
    state.lastBotMessageTs = options.messageTs ?? null;
    state.lastConversationActivityAt = state.lastMessageAt;
    this.touch(key, state);
  }

  private touch(key: string, state: ConversationState): void {
    // Map insertion order is LRU; reads intentionally do not keep entries alive.
    this.entries.delete(key);
    this.entries.set(key, state);
    if (this.shouldPersist(state)) this.schedulePersist();
    if (this.entries.size <= this.maxEntries) return;

    // Preserve pending questions first, and active dialogue second. A hard cap
    // still applies when every entry is pending; evict the oldest pending then.
    let candidate: string | undefined;
    let bestPriority = Infinity;
    for (const [entryKey, entry] of this.entries) {
      this.expire(entry);
      const priority = this.priority(entry);
      if (priority < bestPriority) {
        candidate = entryKey;
        bestPriority = priority;
        if (priority === 0) break;
      }
    }
    if (candidate !== undefined) {
      if (bestPriority === 2) {
        logger.debug("[slack] conversation tracker at capacity; oldest pending context evicted");
      }
      const evicted = this.entries.get(candidate);
      this.entries.delete(candidate);
      if (evicted && this.shouldPersist(evicted)) this.schedulePersist();
    }
  }

  private priority(state: ConversationState): number {
    return state.status === "awaiting_input" ? 2 : state.status === "conversing" ? 1 : 0;
  }

  private shouldPersist(state: ConversationState): boolean {
    return state.hasBotReply || state.status === "reacted" || state.status === "awaiting_input" || state.status === "completed";
  }

  private schedulePersist(): void {
    if (!this.statePath) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flush(), 100);
    this.persistTimer.unref();
  }

  private loadSnapshot(): void {
    if (!this.statePath) return;
    try {
      const stat = fs.lstatSync(this.statePath);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot");
      const content = fs.readFileSync(this.statePath, "utf8");
      if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot");
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid snapshot");
      const snapshot = parsed as Record<string, unknown>;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.entries) || snapshot.entries.length > this.maxEntries) {
        throw new Error("Invalid snapshot");
      }
      const loaded = new Map<string, ConversationState>();
      for (const raw of snapshot.entries) {
        if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !SNAPSHOT_KEY.test(raw.key)) {
          throw new Error("Invalid snapshot");
        }
        const state = this.parseState(raw.state);
        if (!state || !this.shouldPersist(state) || loaded.has(raw.key)) throw new Error("Invalid snapshot");
        this.expire(state);
        loaded.set(raw.key, state);
      }
      for (const [key, state] of loaded) this.entries.set(key, state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn("[slack] conversation snapshot is unavailable or invalid; starting with empty context");
      }
    }
  }

  private parseState(value: unknown): ConversationState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const state = value as Record<string, unknown>;
    const allowed = new Set([
      "humanSpeakers", "status", "lastActor", "lastHumanUserId", "lastMessageTs", "lastMessageAt",
      "lastBotMessageAt", "lastConversationActivityAt", "awaitingUserId", "botCreatedThread",
      "hasBotReply", "hasKnownRecipient",
      "linkedThreadTs", "rootUserId",
      "lastBotMessageTs",
    ]);
    if (Object.keys(state).some((key) => !allowed.has(key))) return null;
    if (!Array.isArray(state.humanSpeakers) || state.humanSpeakers.length > 2 ||
        !state.humanSpeakers.every((id) => typeof id === "string" && SNAPSHOT_ID.test(id))) return null;
    if (!["none", "reacted", "conversing", "awaiting_input", "completed"].includes(state.status as string)) return null;
    if (state.lastActor !== null && !["human", "bot", "bot_reaction"].includes(state.lastActor as string)) return null;
    for (const key of ["lastHumanUserId", "lastMessageTs", "awaitingUserId"]) {
      if (state[key] !== null && (typeof state[key] !== "string" || !SNAPSHOT_ID.test(state[key] as string))) return null;
    }
    // Optional for snapshots written before root/thread linkage was introduced.
    for (const key of ["linkedThreadTs", "rootUserId", "lastBotMessageTs"]) {
      if (state[key] != null && (typeof state[key] !== "string" || !SNAPSHOT_ID.test(state[key] as string))) return null;
    }
    for (const key of ["lastMessageAt", "lastBotMessageAt", "lastConversationActivityAt"]) {
      if (state[key] !== null && (typeof state[key] !== "number" || !Number.isFinite(state[key]) || (state[key] as number) < 0)) return null;
    }
    if (typeof state.botCreatedThread !== "boolean" || typeof state.hasBotReply !== "boolean" ||
        typeof state.hasKnownRecipient !== "boolean") return null;
    if (state.botCreatedThread && !state.hasBotReply) return null;
    if (state.status === "conversing" && state.lastConversationActivityAt === null) return null;
    if (state.status !== "awaiting_input" && state.awaitingUserId !== null) return null;
    return {
      ...state, humanSpeakers: new Set(state.humanSpeakers as string[]),
      linkedThreadTs: state.linkedThreadTs ?? null, rootUserId: state.rootUserId ?? null,
      lastBotMessageTs: state.lastBotMessageTs ?? null,
    } as ConversationState;
  }
}
