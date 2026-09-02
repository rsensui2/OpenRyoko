import fs from "node:fs";
import type {
  Connector,
  Employee,
  Engine,
  IncomingMessage,
  JinnConfig,
  SessionAttemptOutcome,
  Session,
  Target,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
  WorkflowAttemptInterruptionCause,
} from "../shared/types.js";
import {
  cancelWorkflowAttemptDispatch,
  claimWorkflowAttemptDispatch,
  createSession,
  deleteSession,
  getOrCreateWorkflowAttemptSession,
  getSession,
  getSessionBySessionKey,
  getMessages,
  insertMessage,
  interruptSessionAttempt,
  listChildSessions,
  listPendingWorkflowAttemptDispatches,
  settleWorkflowAttemptDispatch,
  updateSession,
  type UpdateSessionFields,
} from "./registry.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { continueWorkflowAttemptSession } from "./attempt-continuation.js";
import { workflowAttemptInterruptionCause } from "./workflow-interruptions.js";
import { recordTurnAccounting } from "./accounting.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "./callbacks.js";
import { buildContext, resolveOperatorIdentity } from "./context.js";
import { normalizeDelivery, normalizeTurns, deliverPublic, type DeliveryContext } from "./reply-disposition.js";
import { deliverToOriginConnector, isUndeliveredToOrigin, recordFailedOriginDelivery } from "./origin-delivery.js";
import { SessionQueue } from "./queue.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel } from "../shared/models.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, isDeadSessionError, isPoisonedTranscriptError, isTransientServerError } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit, recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { checkBudget } from "../gateway/budgets.js";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../mcp/resolver.js";

const WORKFLOW_CAPABILITIES = { threading: false, messageEdits: false, reactions: false, attachments: false };
/** Inert connector a workflow attempt turn runs under: nothing to deliver to,
 *  nothing to react on — the runner reads the transcript, not a channel. */
const WORKFLOW_CONNECTOR: Connector = {
  name: "workflow",
  async start() {},
  async stop() {},
  getCapabilities: () => WORKFLOW_CAPABILITIES,
  getHealth: () => ({ status: "running", capabilities: WORKFLOW_CAPABILITIES }),
  reconstructTarget: () => ({ channel: "workflow" }),
  async sendMessage() { return undefined; },
  async replyMessage() { return undefined; },
  async addReaction() {},
  async removeReaction() {},
  async editMessage() {},
  onMessage() {},
};

export interface RouteOptions {
  employee?: Employee;
  engine?: string;
  model?: string;
  title?: string;
}

/**
 * Control slash commands handled by {@link SessionManager.handleCommand}.
 * Connectors should treat a message that begins with one of these as a bare
 * command and NOT wrap it with conversation context — handleCommand() matches
 * them by exact string / prefix, so any preamble breaks the parsing.
 */
export const SLASH_COMMANDS = ["/new", "/status", "/model", "/doctor", "/cron"] as const;

/** True when `text` begins with a control slash command (see {@link SLASH_COMMANDS}). */
export function startsWithSlashCommand(text: string): boolean {
  const t = text.trimStart();
  return SLASH_COMMANDS.some((cmd) => t === cmd || t.startsWith(`${cmd} `));
}

/**
 * Pure part of the engine-override revert: decide whether a session whose
 * engine was temporarily switched away (Claude rate-limit fallback) is due to
 * revert, and which fields to restore. Returns null when no revert is due.
 * Exported for tests; the DB write happens in {@link maybeRevertEngineOverride}.
 */
export function computeEngineOverrideRevert(session: Session, nowMs: number = Date.now()): UpdateSessionFields | null {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return null;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return null;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return null;
  if (until.getTime() > nowMs) return null;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
    // Restore the pre-fallback model only when the override stashed one.
    // Legacy overrides (written before model stashing) leave session.model
    // untouched, matching the old behavior.
    ...("originalModel" in override
      ? { model: typeof override.originalModel === "string" ? override.originalModel : null }
      : {}),
  };
}

function maybeRevertEngineOverride(session: Session): Session {
  const updates = computeEngineOverrideRevert(session);
  if (!updates) return session;
  return updateSession(session.id, updates) ?? session;
}

function mergeTransportMeta(
  existing: Session["transportMeta"],
  incoming: IncomingMessage["transportMeta"],
): Session["transportMeta"] {
  const baseExisting = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {};
  const baseIncoming = (incoming && typeof incoming === "object" && !Array.isArray(incoming))
    ? (incoming as Record<string, unknown>)
    : {};

  const merged: Record<string, unknown> = { ...baseExisting, ...baseIncoming };

  // Preserve Jinn internal keys from being overwritten by transport adapters.
  for (const key of ["engineOverride", "engineSessions", "claudeSyncSince"]) {
    if (baseExisting[key] !== undefined) merged[key] = baseExisting[key];
  }

  return merged as any;
}

export class SessionManager {
  private config: JinnConfig;
  private engines: Map<string, Engine>;
  private connectorNames: string[];
  private queue = new SessionQueue();
  private connectorProvider: () => Map<string, Connector> = () => new Map();
  private employeeProvider: (id: string) => Employee | undefined = () => undefined;
  private workflowAttemptCompletionListeners = new Set<WorkflowAttemptCompletionListener>();
  private emittedWorkflowAttemptCompletions = new Set<string>();

  constructor(
    config: JinnConfig,
    engines: Map<string, Engine>,
    connectorNames: string[] = [],
  ) {
    this.config = config;
    this.engines = engines;
    this.connectorNames = connectorNames;
  }

  setConnectorProvider(provider: () => Map<string, Connector>): void {
    this.connectorProvider = provider;
  }

  /** Wire the employee roster in after boot (mirrors setConnectorProvider). */
  setEmployeeProvider(provider: (id: string) => Employee | undefined): void {
    this.employeeProvider = provider;
  }

  // --- Workflow attempt execution (upstream port, adapted) -------------------
  //
  // Upstream fences terminal writes with per-dispatch attempt tokens; this fork
  // relies on the queue's per-sessionKey serialization plus the persisted
  // dispatch claim, and stamps the terminal receipt in the dispatch task right
  // after runSession — never inside it — so the conversational path stays
  // untouched. A stop that raced the settle wins: the receipt is only written
  // while attemptOutcome is still null.

  subscribeWorkflowAttemptCompletion(listener: WorkflowAttemptCompletionListener): () => void {
    this.workflowAttemptCompletionListeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.workflowAttemptCompletionListeners.delete(listener);
    };
  }

  async runWorkflowAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    const employee = this.employeeProvider(command.employeeId);
    if (!employee) throw new Error(`Workflow employee "${command.employeeId}" is not available.`);
    const key = `workflow:${command.owner.workflowId}:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
    const session = continueWorkflowAttemptSession(
      getOrCreateWorkflowAttemptSession({
        engine: command.engine,
        source: "workflow",
        sourceRef: key,
        connector: "workflow",
        sessionKey: key,
        employee: command.employeeId,
        model: command.model,
        effortLevel: command.effort,
        prompt: command.prompt,
        workflowProvenance: {
          kind: "phase",
          workflowId: command.owner.workflowId,
          workflowName: command.owner.workflowId,
          runId: command.owner.runId,
          triggerSource: "workflow",
          phase: { nodeId: command.owner.nodeId, name: command.owner.nodeId, index: 1, round: 1, attempt: command.owner.attempt },
        },
      }),
      command.continueFrom,
    );
    const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, command.prompt);
    if (claim) this.enqueueWorkflowAttempt(session, command.prompt, employee, claim);
    return { sessionId: session.id };
  }

  private enqueueWorkflowAttempt(session: Session, prompt: string, employee: Employee, claim: string): void {
    const msg: IncomingMessage = {
      connector: "workflow", source: "workflow", sessionKey: session.sessionKey, replyContext: {},
      channel: session.id, user: "workflow", userId: "workflow", text: prompt, attachments: [], raw: null,
    };
    // Emitted on the enqueue promise, never inside the task: a listener that
    // answers the completion by dispatching again (the stop-nudge does) must
    // find the queue row already settled, not still running this prompt.
    setImmediate(() => {
      let settled: Session | undefined;
      void this.queue.enqueue(session.sessionKey, async () => {
        // The previous terminal receipt was already cleared inside the durable
        // claim transaction (claimWorkflowAttemptDispatch), so this turn — or a
        // stop that races it — owns the receipt from here on.
        try {
          await this.runSession(session, msg, [], WORKFLOW_CONNECTOR, { channel: session.id }, employee);
          settled = this.settleWorkflowAttemptTurn(session.id);
        } catch (error) {
          // A turn whose plumbing threw is a FAILED attempt, never a success:
          // deciding success from `status === "idle"` here would let an
          // insertMessage/context failure masquerade as a completed turn.
          logger.error(`Workflow session ${session.id} dispatch failed: ${String(error)}`);
          settled = settleWorkflowAttemptDispatch(session.id, "failed", { error: String(error) });
        }
      }, claim).then(() => {
        if (settled) this.emitWorkflowAttemptCompletion(settled);
      });
    });
  }

  /** Terminal receipt for the turn runSession just ran, written atomically with
   *  the queue-row close (see registry.settleWorkflowAttemptDispatch). A stop
   *  that already stamped `interrupted` keeps its receipt. A turn that ended in
   *  `waiting`/`running` (rate-limit park, still-active transport) settles
   *  nothing — recovery or the next turn owns it. */
  private settleWorkflowAttemptTurn(sessionId: string): Session | undefined {
    const current = getSession(sessionId);
    if (!current || current.workflowProvenance?.kind !== "phase") return current ?? undefined;
    const outcome: SessionAttemptOutcome | null = current.status === "error" ? "failed"
      : current.status === "interrupted" ? "interrupted"
      : current.status === "idle" ? "succeeded" : null;
    return settleWorkflowAttemptDispatch(sessionId, outcome);
  }

  async remindWorkflowAttempt(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session || session.workflowProvenance?.kind !== "phase" || !session.employee) {
      throw new Error(`Workflow attempt session "${sessionId}" is not available.`);
    }
    const employee = this.employeeProvider(session.employee);
    if (!employee) throw new Error(`Workflow employee "${session.employee}" is not available.`);
    const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, text);
    if (!claim) throw new Error(`Workflow attempt session "${sessionId}" is not idle.`);
    this.enqueueWorkflowAttempt(session, text, employee, claim);
  }

  workflowAttemptState(sessionId: string): { idle: boolean; runningChildren: number } | null {
    const session = getSession(sessionId);
    if (!session || session.workflowProvenance?.kind !== "phase") return null;
    const idle = session.status === "idle"
      && !this.queue.isRunning(session.sessionKey)
      && this.queue.getPendingCount(session.sessionKey) === 0;
    const runningChildren = listChildSessions(sessionId).filter((child) => {
      const transport = this.queue.getTransportState(child.sessionKey, child.status);
      return child.status === "running" || transport === "running" || transport === "queued";
    }).length;
    return { idle, runningChildren };
  }

  async stopWorkflowAttempt(input: { sessionId: string; reason: string }): Promise<void> {
    const session = getSession(input.sessionId);
    if (!session || session.workflowProvenance?.kind !== "phase") return;
    const stopped = interruptSessionAttempt(session.id, input.reason, new Date().toISOString());
    // Cancel the pending dispatch even when the interrupt receipt found nothing
    // to stamp — a session whose last turn already succeeded can still hold a
    // pending reminder row, and a stop must not leave it to run later.
    cancelWorkflowAttemptDispatch(session.id);
    this.queue.clearQueue(session.sessionKey);
    if (!stopped) return;
    const engine = this.engines.get(stopped.engine);
    if (engine && isInterruptibleEngine(engine)) engine.kill(stopped.id, input.reason);
    this.emitWorkflowAttemptCompletion(stopped, "attempt-stop");
  }

  /** Replay internal dispatches a restart left pending (call once at boot,
   *  after the employee provider is wired). */
  redispatchPendingWorkflowAttempts(): void {
    for (const item of listPendingWorkflowAttemptDispatches()) {
      const session = getSession(item.sessionId);
      const employee = session?.employee ? this.employeeProvider(session.employee) : undefined;
      if (!session || !employee) continue;
      this.enqueueWorkflowAttempt(session, item.prompt, employee, item.id);
    }
  }

  private emitWorkflowAttemptCompletion(session?: Session, interruptionCause?: WorkflowAttemptInterruptionCause): void {
    const provenance = session?.workflowProvenance;
    if (!session?.attemptOutcome || provenance?.kind !== "phase" || !provenance.phase) return;
    const terminalVersion = session.attemptTerminalVersion ?? 0;
    const turn = session.attemptTurn ?? 0;
    const key = `${session.id}:${turn}`;
    if (terminalVersion < 1 || turn < 1 || this.emittedWorkflowAttemptCompletions.has(key)) return;
    const finalText = [...getMessages(session.id)].reverse().find((message) => message.role === "assistant")?.content;
    const event: WorkflowAttemptCompletion = {
      sessionId: session.id,
      owner: {
        workflowId: provenance.workflowId, runId: provenance.runId,
        nodeId: provenance.phase.nodeId, attempt: provenance.phase.attempt,
      },
      turn,
      terminalVersion: 1,
      outcome: session.attemptOutcome,
      completedAt: session.lastActivity,
      ...(session.attemptOutcome === "interrupted" ? {
        interruptionCause: interruptionCause ?? workflowAttemptInterruptionCause(session.lastError, session, turn),
      } : {}),
      ...(finalText ? { finalText } : {}),
      ...(session.lastError ? { error: session.lastError } : {}),
    };
    this.emittedWorkflowAttemptCompletions.add(key);
    for (const listener of this.workflowAttemptCompletionListeners) {
      void Promise.resolve(listener(event)).catch((error) =>
        logger.error(`Workflow attempt completion listener failed: ${String(error)}`));
    }
  }

  /**
   * Replace the list of connector names that gets injected into engine
   * context (system prompt). Call this after a hot-reload of connectors so
   * sessions started post-reload see the current set, not the boot-time set.
   */
  setConnectorNames(names: string[]): void {
    this.connectorNames = [...names];
  }

  /**
   * Replace the active config object. Call this after ~/.ryoko/config.yaml
   * is reloaded so new sessions see fresh values for engines.default,
   * portal.portalName, engine bin paths, etc. — without it, every session
   * created after a Settings save would silently use boot-time values until
   * the daemon is restarted.
   */
  setConfig(config: JinnConfig): void {
    this.config = config;
  }

  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  getQueue(): SessionQueue {
    return this.queue;
  }

  async route(msg: IncomingMessage, connector: Connector, opts: RouteOptions = {}): Promise<{ sessionId: string } | void> {
    if (await this.handleCommand(msg, connector)) return;

    let session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      session = createSession({
        engine: opts.engine ?? opts.employee?.engine ?? this.config.engines.default,
        source: msg.source,
        sourceRef: msg.sessionKey,
        connector: msg.connector,
        sessionKey: msg.sessionKey,
        replyContext: msg.replyContext,
        messageId: msg.messageId,
        transportMeta: msg.transportMeta,
        employee: opts.employee?.name ?? undefined,
        model: opts.model ?? opts.employee?.model ?? undefined,
        title: opts.title,
        prompt: msg.text,
        portalName: this.config.portal?.portalName,
      });
      logger.info(
        `Created new session ${session.id} for ${msg.sessionKey}` +
        (opts.employee ? ` (employee: ${opts.employee.name})` : ""),
      );
    } else {
      const mergedMeta = mergeTransportMeta(session.transportMeta, msg.transportMeta);
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergedMeta,
        ...(opts.model ? { model: opts.model } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

    if (session.status === "waiting") {
      const expectedResetAt = getClaudeExpectedResetAt();
      const resumeText = expectedResetAt
        ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;
      await connector.replyMessage(
        target,
        `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. I queued this message and will respond automatically.`,
      ).catch(() => {});
    }

    if (session.status === "running" && this.queue.isRunning(msg.sessionKey) && connector.getCapabilities().reactions) {
      await connector.addReaction(target, "clock1").catch(() => {});
    }

    const sessionId = session.id;

    // Queue cancellation is generational (see SessionQueue.clearQueue): this new
    // inbound message enqueues at the current generation and runs even if the session
    // was previously /stop- or watchdog-reset, so no explicit un-cancel is needed here.
    await this.queue.enqueue(msg.sessionKey, () =>
      this.runSession(session!, msg, attachmentPaths, connector, target, opts.employee),
    );

    return { sessionId };
  }

  /**
   * Build the audience/routing context used to sanitize engine output before it
   * is posted. `addressed` is true for any non-cron (human-originated) session:
   * "read-the-air" silence is handled upstream in triage, so a session that ran
   * at all owes a response. `channelExternal` defaults to true for non-DM when
   * the connector doesn't report it (safe — strips operator notes from any
   * public channel). See reply-disposition.ts / the 2026-06-18 design doc.
   */
  private buildDeliveryContext(
    session: Session,
    msg: IncomingMessage,
    capabilities: { reactions: boolean },
  ): DeliveryContext {
    const meta = (msg.transportMeta ?? {}) as Record<string, unknown>;
    const isDM = meta.channelType === "im";
    const channelExternal = isDM
      ? false
      : meta.channelExternal === undefined
        ? true
        : meta.channelExternal === true;
    return {
      addressed: session.source !== "cron",
      channelExternal,
      isDM,
      canReact: capabilities.reactions,
    };
  }

  /**
   * Handle a hook that arrived with no turn in flight (see
   * HookRegistry.setOrphanHandler). A Stop orphan carries the final message of
   * autonomous post-turn work — a background sub-agent or task that finished
   * AFTER the turn settled (or after a turn timeout/StopFailure). Without this,
   * that output was buffered 30s and dropped: the work completed but the reply
   * never reached the user. Deliver it to the session's conversation and notify
   * the parent session, mirroring the tail of runSession's delivery path.
   * Fire-and-forget; must never throw (hook endpoint calls into this).
   */
  async handleOrphanHook(sessionId: string, hook: { hook_event_name: string; last_assistant_message?: unknown; error?: unknown }): Promise<void> {
    try {
      if (this.config.sessions?.backgroundDelivery === false) return;
      const session = getSession(sessionId);
      if (!session) return;

      if (hook.hook_event_name === "StopFailure") {
        // Background continuation failed — record it for operators, but don't
        // post to the channel (nothing was promised; avoid error spam during
        // upstream incidents).
        const err = typeof hook.error === "string" ? hook.error : "unknown";
        logger.warn(`Orphan StopFailure for session ${sessionId}: ${err}`);
        updateSession(sessionId, { lastActivity: new Date().toISOString(), lastError: `Background turn failed: ${err}` });
        return;
      }
      if (hook.hook_event_name !== "Stop") return;

      const text = typeof hook.last_assistant_message === "string" ? hook.last_assistant_message.trim() : "";
      if (!text) return;

      // A turn may have started between the orphan arriving and this handler
      // running — its resolver owns delivery now; don't double-post.
      const engine = this.engines.get(session.engine) as (Engine & { isTurnRunning?: (id: string) => boolean }) | undefined;
      if (engine?.isTurnRunning?.(session.id)) return;

      // Dedupe: identical to the message we already delivered → nothing new.
      const history = getMessages(session.id);
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      if (lastAssistant?.content === text) return;

      insertMessage(session.id, "assistant", text);
      const updated = updateSession(session.id, {
        lastActivity: new Date().toISOString(),
        ...(session.status !== "running" ? { status: "idle" as const, lastError: null } : {}),
      }) ?? session;

      logger.info(`Delivering background completion for session ${sessionId} (${text.length} chars)`);

      const delivery = await deliverToOriginConnector(updated, text, this.connectorProvider());
      if (isUndeliveredToOrigin(delivery, updated)) {
        recordFailedOriginDelivery(updated);
      }

      // Child (sub-)session: this late completion IS the "完了通知" the parent
      // was waiting for.
      notifyParentSession(updated, { result: text });
    } catch (err) {
      logger.warn(`handleOrphanHook failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runSession(
    session: Session,
    msg: IncomingMessage,
    attachments: string[],
    connector: Connector,
    target: Target,
    employee?: Employee,
  ): Promise<void> {
    const engine = this.engines.get(session.engine);
    if (!engine) {
      logger.error(`Engine "${session.engine}" not found for session ${session.id}`);
      await connector.replyMessage(target, `Error: engine "${session.engine}" not available.`);
      return;
    }
    if (session.engine !== "claude" && /^\/goal(?:\s|$)/i.test(msg.text.trim())) {
      await connector.replyMessage(
        target,
        `/goal is only supported by the Claude engine. Current engine: ${session.engine}. Switch this session to Claude to use goal-mode execution.`,
      );
      return;
    }

    insertMessage(session.id, "user", msg.text);

    const capabilities = connector.getCapabilities();
    const decorateMessages = session.source !== "cron";

    if (decorateMessages && capabilities.reactions) {
      await connector.addReaction(target, "eyes").catch(() => {});
    }

    // Set native typing indicator (Slack assistant.threads.setStatus)
    const threadTs = target.thread || target.messageTs;
    if (decorateMessages && connector.setTypingStatus) {
      await connector.setTypingStatus(target.channel, threadTs, "入力中...").catch(() => {});
    }

    updateSession(session.id, {
      status: "running",
      replyContext: msg.replyContext,
      messageId: msg.messageId ?? null,
      transportMeta: mergeTransportMeta(session.transportMeta, msg.transportMeta),
      lastActivity: new Date().toISOString(),
    });

    // Resolve MCP config before try block so it's accessible in catch for cleanup
    let mcpConfigPath: string | undefined;

    let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
    try {
      const { scanOrg } = await import("../gateway/org.js");
      const { resolveOrgHierarchy } = await import("../gateway/org-hierarchy.js");
      hierarchy = resolveOrgHierarchy(scanOrg());
    } catch { /* fallback to filesystem scan in context builder */ }

    try {
      const meta = msg.transportMeta ?? {};
      const systemPrompt = buildContext({
        source: session.source,
        channel: msg.channel,
        thread: msg.thread,
        user: msg.user,
        employee,
        connectors: this.connectorNames,
        config: this.config,
        sessionId: session.id,
        channelName: (meta.channelName as string) || undefined,
        speakerName: (meta.speakerName as string) || undefined,
        speakerRealName: (meta.speakerRealName as string) || undefined,
        speakerDisplayName: (meta.speakerDisplayName as string) || undefined,
        speakerHandle: (meta.speakerHandle as string) || undefined,
        speakerSlackId: (meta.speakerSlackId as string) || undefined,
        speakerDiscordId: (meta.speakerDiscordId as string) || undefined,
        isDM: meta.isDM === true,
        speakerIsBot: (meta.speakerIsBot as boolean | null) ?? undefined,
        speakerTz: (meta.speakerTz as string) || undefined,
        // Interactive PTY survives across turns; everything else (headless
        // claude -p, codex, gemini, SSH fallback) is a one-shot process whose
        // background tasks die at turn end (#38).
        processLifetime:
          session.engine === "claude" &&
          this.config.engines.claude?.interactive === true &&
          !employee?.sshHost
            ? "persistent"
            : "one-shot",
        hierarchy,
      });

      const engineConfig = session.engine === "codex"
        ? this.config.engines.codex
        : session.engine === "gemini"
          ? this.config.engines.gemini ?? this.config.engines.claude
          : this.config.engines.claude;
      if (session.engine === "claude") {
        const mcpConfig = resolveMcpServers(this.config.mcp, employee, {
          connector: connector.name,
          channel: target.channel,
          thread: target.thread || target.messageTs,
        });
        if (Object.keys(mcpConfig.mcpServers).length > 0) {
          mcpConfigPath = writeMcpConfigFile(mcpConfig, session.id);
        }
      }

      const effortLevel = resolveEffort(
        engineConfig,
        session,
        employee,
        effortLevelsForModel(this.config, session.engine, session.model ?? engineConfig.model),
      );

      // If we previously switched to GPT while Claude was rate-limited, inject a sync transcript
      // so Claude can resume with full context when it comes back online.
      const syncSinceIso = (session.transportMeta as any)?.claudeSyncSince;
      let promptToRun = msg.text;
      const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
      const syncRequested = session.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
      if (syncRequested) {
        const sinceMessages = getMessages(session.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        promptToRun =
          `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      }

      // Per-message speaker attribution for group conversations. The system
      // prompt names the speaker only at engine-spawn time — in a multi-user
      // thread (or a warm-PTY follow-up from a DIFFERENT person) the model has
      // no per-turn signal of who is talking and defaults to the conversation's
      // habitual addressee, which is how non-operators got addressed as the
      // operator. Skipped for DMs (1:1 is unambiguous), cron (no speaker), and
      // slash-command prompts (a prefix would break native-command detection).
      {
        const speakerMeta = (msg.transportMeta ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
        const prefixName = str(speakerMeta.speakerName);
        if (
          decorateMessages &&
          prefixName &&
          speakerMeta.channelType !== "im" &&
          speakerMeta.isDM !== true &&
          !promptToRun.trimStart().startsWith("/")
        ) {
          // Same identity decision as the system prompt: strict platform-ID
          // equality when an operator ID is configured, name matching only
          // as the no-ID fallback. Using bare name matching here while the
          // system prompt used IDs would tag the ID-verified operator as
          // "NOT the operator" on every turn.
          const { speakerIsOperator: isOp } = resolveOperatorIdentity({
            speakerNames: [prefixName, str(speakerMeta.speakerRealName), str(speakerMeta.speakerDisplayName), str(speakerMeta.speakerHandle)],
            speakerSlackId: str(speakerMeta.speakerSlackId),
            speakerDiscordId: str(speakerMeta.speakerDiscordId),
            operatorName: this.config.portal?.operatorName,
            config: this.config,
          });
          const safeName = prefixName.replace(/[\[\]\r\n]/g, "").slice(0, 60);
          const operator = this.config.portal?.operatorName?.trim();
          const tag = operator
            ? isOp
              ? " (the operator)"
              : ` — NOT the operator; do not address this person as "${operator}"`
            : "";
          promptToRun = `[Speaker: ${safeName}${tag}]\n${promptToRun}`;
        }
      }

      // Budget enforcement — check BEFORE engine.run()
      if (session.employee) {
        const budgetConfig = (this.config as any).budgets?.employees as Record<string, number> | undefined;
        if (budgetConfig && session.employee in budgetConfig) {
          const budgetStatus = checkBudget(session.employee, budgetConfig);
          if (budgetStatus === 'paused') {
            logger.warn(`Session ${session.id} blocked: employee "${session.employee}" has exceeded their budget`);
            const pausedMsg = `Budget limit exceeded for employee "${session.employee}". Session blocked.`;
            updateSession(session.id, {
              status: 'error',
              lastActivity: new Date().toISOString(),
              lastError: pausedMsg,
            });
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, '').catch(() => {});
            }
            await connector.replyMessage(target, `⛔ ${pausedMsg}`).catch(() => {});
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, 'eyes').catch(() => {});
            }
            return;
          }
        }
      }

      // Heuristic preflight warning: Claude usage limits don't expose a precise "remaining" budget.
      // If we've hit the limit recently and this looks like a heavy turn, warn before we spend time.
      if (decorateMessages && session.engine === "claude" && isLikelyNearClaudeUsageLimit()) {
        const modelName = (session.model ?? engineConfig.model ?? "").toLowerCase();
        const heavyEffort = ["high", "xhigh", "max"].includes((effortLevel || "").toLowerCase());
        const heavyModel = modelName.includes("opus");
        const looksBig = attachments.length > 0 || msg.text.length > 6000;
        if ((heavyEffort || heavyModel) && looksBig) {
          const expectedResetAt = getClaudeExpectedResetAt();
          const resumeText = expectedResetAt
            ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
            : null;
          await connector.replyMessage(
            target,
            `⚠️ Heads up: Claude usage limits were hit recently, and this looks like a bigger task. If you're near the limit, it may pause${resumeText ? ` until ~${resumeText}` : ""}.`,
          ).catch(() => {});
        }
      }

      let result = await engine.run({
        prompt: promptToRun,
        resumeSessionId: session.engineSessionId ?? undefined,
        systemPrompt,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: session.model ?? engineConfig.model,
        effortLevel,
        cliFlags: employee?.cliFlags,
        sshHost: employee?.sshHost,
        remoteCwd: employee?.remoteCwd,
        mcpConfigPath,
        attachments: attachments.length > 0 ? attachments : undefined,
        sessionId: session.id,
      });

      let wasInterrupted = result.error?.startsWith("Interrupted");

      // Poisoned transcript: the persisted engine history is corrupted (e.g.
      // collapsed extended-thinking blocks) so every --resume of this engine
      // session replays it and fails with the same 400. Clear the engine session
      // id so the NEXT message starts on a clean session, but deliberately do NOT
      // auto-replay the current prompt: the failed run may already have executed
      // tools with side effects, and a fresh rerun would duplicate them (a
      // resumed `claude -p` reports cumulative cost/turns, so "no work was done"
      // cannot be reliably detected here). Ask the user to resend instead.
      const isPoisoned = !wasInterrupted && isPoisonedTranscriptError(result);
      if (isPoisoned) {
        logger.warn(`Poisoned transcript for ${session.id} — clearing engine session id; not auto-retrying to avoid duplicate side effects`);
        const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        delete meta["engineSessions"];
        delete meta["engineOverride"];
        updateSession(session.id, { engineSessionId: null, transportMeta: meta as any });
        session = { ...session, engineSessionId: null, transportMeta: meta as any };
        // Blank the returned sessionId so the post-run persistence below does not
        // re-attach the poisoned engine session id, drop any partial result text
        // and intermediate turns (otherwise the reply path would surface those
        // stale fragments instead of the reset notice), and replace the raw 400
        // with an actionable message for the user.
        result = {
          ...result,
          sessionId: "",
          result: "",
          turns: [],
          error:
            "⚠️ 直前の会話履歴が壊れていたため（thinking ブロックの破損）、このセッションをリセットしました。お手数ですが同じ内容をもう一度送ってください。次回からは正常に応答できます。",
        };
      }

      // Dead session detection: if the engine session ID is stale (expired/invalid),
      // clear cached engine sessions from transportMeta so the next attempt starts fresh.
      // Also sets a flag so we skip the rate-limit retry loop below (a dead session
      // error can contain text like "429" that would otherwise match RATE_LIMIT_ERROR_RE).
      // (Poisoned transcripts are handled above and excluded here — unlike a stale
      // resume id, they must not trigger an automatic prompt replay.)
      let isDead = !wasInterrupted && !isPoisoned && isDeadSessionError(result);
      if (isDead) {
        logger.warn(`Dead session detected for ${session.id} — clearing stale engine IDs`);
        const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        delete meta["engineSessions"];
        delete meta["engineOverride"];
        updateSession(session.id, {
          engineSessionId: null,
          transportMeta: meta as any,
        });
        // Update local reference so subsequent code doesn't re-read stale IDs
        session = { ...session, engineSessionId: null, transportMeta: meta as any };

        // Auto-retry once with a fresh engine session. Without this, a user
        // message that happens to land on a stale resume ID is silently lost
        // (the raw engine error propagates back instead of a real answer).
        logger.info(`Retrying session ${session.id} with fresh engine session after dead-session`);
        result = await engine.run({
          prompt: promptToRun,
          resumeSessionId: undefined,
          systemPrompt,
          cwd: JINN_HOME,
          bin: engineConfig.bin,
          model: session.model ?? engineConfig.model,
          effortLevel,
          cliFlags: employee?.cliFlags,
          sshHost: employee?.sshHost,
          remoteCwd: employee?.remoteCwd,
          mcpConfigPath,
          attachments: attachments.length > 0 ? attachments : undefined,
          sessionId: session.id,
        });

        // Re-evaluate the flags against the retry result. If the retry also
        // comes back dead, something deeper is wrong — log and fall through to
        // normal error handling (which will post the error to the user).
        wasInterrupted = result.error?.startsWith("Interrupted");
        isDead = !wasInterrupted && isDeadSessionError(result);
        if (isDead) {
          logger.error(`Retry with fresh session for ${session.id} also reported dead-session; giving up`);
        }
      }

      // Transient Anthropic server error (5xx/529): the CLI already retried
      // in-process for minutes and gave up. The engine session's history is
      // intact, so wait out the incident with backoff and re-drive the SAME
      // session with a continuation prompt instead of surfacing a hard error.
      // Runs BEFORE rate-limit detection so a retry that ends rate-limited
      // still flows into the normal wait/fallback machinery below.
      if (!wasInterrupted && !isDead && !isPoisoned && isTransientServerError(result)) {
        const delays = this.config.sessions?.transientRetryDelaysMs ?? [30_000, 120_000, 300_000];
        if (delays.length > 0) {
          await connector.replyMessage(
            target,
            "⚠️ Anthropic API is temporarily unavailable (server error). I'll retry automatically — no action needed.",
          ).catch(() => {});
        }
        for (const [i, delayMs] of delays.entries()) {
          logger.warn(
            `Session ${session.id} hit a transient server error — retry ${i + 1}/${delays.length} in ${Math.round(delayMs / 1000)}s`,
          );
          // Chunked wait with a heartbeat: the status reconciler treats a
          // "running" session with a stale lastActivity and no live engine turn
          // as stuck — which is exactly what this backoff window looks like.
          // Refreshing lastActivity every 20s keeps it out of the sweep.
          for (let waited = 0; waited < delayMs; waited += 20_000) {
            updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
            await new Promise((r) => setTimeout(r, Math.min(20_000, delayMs - waited)));
          }
          const resumeId = result.sessionId?.trim() || session.engineSessionId || undefined;
          result = await engine.run({
            prompt:
              "The previous response was interrupted by a temporary Anthropic API server error. " +
              "The conversation history up to that point is intact. Continue and complete the original request now. " +
              "If the work was already finished, reply with the final result.",
            resumeSessionId: resumeId,
            systemPrompt,
            cwd: JINN_HOME,
            bin: engineConfig.bin,
            model: session.model ?? engineConfig.model,
            effortLevel,
            cliFlags: employee?.cliFlags,
            sshHost: employee?.sshHost,
            remoteCwd: employee?.remoteCwd,
            mcpConfigPath,
            sessionId: session.id,
          });
          wasInterrupted = result.error?.startsWith("Interrupted");
          if (wasInterrupted || !isTransientServerError(result)) break;
        }
        if (!wasInterrupted && isTransientServerError(result)) {
          logger.error(`Session ${session.id} still failing with server errors after ${delays.length} retries — giving up`);
        }
      }

      // Detect rate limit / usage limit errors and auto-retry.
      // Skip entirely for dead/poisoned sessions — they are not rate limits.
      const rateLimit = (!wasInterrupted && !isDead && !isPoisoned) ? detectRateLimit(result) : { limited: false as const };
      if (rateLimit.limited) {
        recordClaudeRateLimit(rateLimit.resetsAt);

        const strategy = this.config.sessions?.rateLimitStrategy ?? "fallback";

        // Optional fallback: switch to GPT (Codex) while Claude resets
        if (session.engine === "claude" && strategy === "fallback") {
          const fallbackName = this.config.sessions?.fallbackEngine ?? "codex";
          const fallbackEngine = this.engines.get(fallbackName);
          if (fallbackEngine) {
            const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
            const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
            const syncSince = new Date().toISOString();
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;

            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} switching to GPT.`,
            );

            await connector.replyMessage(
              target,
              `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`,
            ).catch(() => {});

            const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
            const engineSessionsRaw = nextMeta.engineSessions;
            const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
              ? { ...(engineSessionsRaw as Record<string, unknown>) }
              : {};
            if (session.engineSessionId) {
              engineSessions.claude = session.engineSessionId;
            }
            nextMeta.engineSessions = engineSessions;
            nextMeta.engineOverride = {
              originalEngine: "claude",
              originalEngineSessionId: session.engineSessionId,
              // Stash the Claude-side model so the revert can restore it —
              // model ids are engine-specific and must not survive onto Codex.
              originalModel: session.model ?? null,
              until: until.toISOString(),
              syncSince,
            };

            updateSession(session.id, {
              engine: fallbackName,
              // Keep Claude engine_session_id intact for later restore; Codex will return its own thread id.
              // Clear the model: a Claude model id (e.g. "sonnet" / "claude-opus-5")
              // on a Codex session makes every subsequent turn exit with a 400.
              model: null,
              transportMeta: nextMeta as any,
              status: "running",
              lastActivity: new Date().toISOString(),
              lastError: resumeAt
                ? `Claude usage limit — using GPT until ${resumeAt.toISOString()}`
                : "Claude usage limit — using GPT temporarily",
            });

            const fallbackConfig = this.config.engines.codex;
            // Never carry the Claude session's model id onto Codex — ids are
            // engine-specific ("sonnet" / "claude-opus-5" → codex exec exits 1).
            const fallbackModel = fallbackConfig.model;
            const fallbackEffort = resolveEffort(
              fallbackConfig,
              session,
              employee,
              effortLevelsForModel(this.config, "codex", fallbackModel),
            );
            const codexResume = typeof engineSessions.codex === "string" ? (engineSessions.codex as string) : undefined;
            const history = getMessages(session.id)
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
            const historyText = history.slice(-12).join("\n\n");
            const fallbackPrompt = codexResume
              ? msg.text
              : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;
            const fallbackResult = await fallbackEngine.run({
              prompt: fallbackPrompt,
              resumeSessionId: codexResume,
              systemPrompt,
              cwd: JINN_HOME,
              bin: fallbackConfig.bin,
              model: fallbackModel,
              effortLevel: fallbackEffort,
              cliFlags: employee?.cliFlags,
              sshHost: employee?.sshHost,
              remoteCwd: employee?.remoteCwd,
              attachments: attachments.length > 0 ? attachments : undefined,
              sessionId: session.id,
            });

            const fallbackText = fallbackResult.result?.trim()
              ? fallbackResult.result
              : fallbackResult.error || "(No response from engine)";

            insertMessage(session.id, "assistant", fallbackText);
            if (fallbackResult.cost || fallbackResult.numTurns) {
              recordTurnAccounting(session.id, fallbackResult);
            }

            // Persist Codex thread id so future fallbacks can resume it
            const nextEngineSessions = { ...engineSessions };
            if (fallbackResult.sessionId) {
              nextEngineSessions.codex = fallbackResult.sessionId;
            }
            const metaAfter = { ...(getSessionBySessionKey(msg.sessionKey)?.transportMeta || nextMeta) } as Record<string, unknown>;
            metaAfter.engineSessions = nextEngineSessions;
            updateSession(session.id, { transportMeta: metaAfter as any });

            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
            }
            // Clear "eyes" before delivery so a react-only ":eyes:" reply survives.
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, "eyes").catch(() => {});
            }
            {
              const { publicAction } = normalizeDelivery(fallbackText, this.buildDeliveryContext(session, msg, capabilities));
              await deliverPublic(connector, target, publicAction).catch(() => {});
            }

            const updated = updateSession(session.id, {
              engineSessionId: fallbackResult.sessionId,
              status: fallbackResult.error ? "error" : "idle",
              replyContext: msg.replyContext,
              messageId: msg.messageId ?? null,
              transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
              lastActivity: new Date().toISOString(),
              lastError: fallbackResult.error ?? null,
              ...(typeof fallbackResult.contextTokens === "number" ? { lastContextTokens: fallbackResult.contextTokens } : {}),
            });
            if (updated) {
              notifyParentSession(updated, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }
            return;
          }
        }

        const waitEmoji = "hourglass_flowing_sand";

        const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
        const deadlineMs = computeRateLimitDeadlineMs(
          rateLimit.resetsAt,
          rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
        );

        const resumeText = resumeAt
          ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;

        logger.info(
          `Session ${session.id} hit Claude usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
        );

        // Send hardcoded Discord notification — does not depend on LLM
        notifyDiscordChannel(
          `⚠️ Claude usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
        );

        // Clear "thinking" UI and show waiting state
        if (decorateMessages && connector.setTypingStatus) {
          await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
        }
        if (decorateMessages && capabilities.reactions) {
          await connector.removeReaction(target, "eyes").catch(() => {});
          await connector.addReaction(target, waitEmoji).catch(() => {});
        }

        const waitingSession = updateSession(session.id, {
          ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: resumeAt
            ? `Claude usage limit — resumes ${resumeAt.toISOString()}`
            : "Claude usage limit — waiting for reset",
        }) ?? session;

        notifyRateLimited(
          waitingSession,
          resumeAt
            ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : undefined,
        );

        await connector.replyMessage(
          target,
          `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`,
        ).catch(() => {});

        // Keep lastActivity fresh while waiting (UI / status endpoints)
        const heartbeat = setInterval(() => {
          updateSession(session.id, { status: "waiting", lastActivity: new Date().toISOString() });
        }, 60_000);

        try {
          let attempt = 0;
          let nextDelayMs = delayMs;

          while (Date.now() < deadlineMs) {
            await new Promise(r => setTimeout(r, nextDelayMs));
            attempt++;

            // Check if session was stopped while waiting
            const currentSession = getSessionBySessionKey(msg.sessionKey);
            if (!currentSession || currentSession.status === "error") {
              logger.info(`Session ${session.id} stopped while waiting for usage reset`);
              return;
            }

            // Show active processing again
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "入力中...").catch(() => {});
            }
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, waitEmoji).catch(() => {});
              await connector.addReaction(target, "eyes").catch(() => {});
            }

            logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);
            const retryResult = await engine.run({
              prompt: msg.text,
              resumeSessionId: currentSession.engineSessionId ?? undefined,
              systemPrompt,
              cwd: JINN_HOME,
              bin: engineConfig.bin,
              model: currentSession.model ?? engineConfig.model,
              effortLevel,
              cliFlags: employee?.cliFlags,
              sshHost: employee?.sshHost,
              remoteCwd: employee?.remoteCwd,
              mcpConfigPath,
              attachments: attachments.length > 0 ? attachments : undefined,
              sessionId: session.id,
            });

            const retryInterrupted = retryResult.error?.startsWith("Interrupted");
            const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };
            if (retryRateLimit.limited) {
              recordClaudeRateLimit(retryRateLimit.resetsAt);
              logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

              const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
              nextDelayMs = next.delayMs;

              // Return to waiting UI state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }

              updateSession(session.id, {
                ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
                status: "waiting",
                lastActivity: new Date().toISOString(),
                lastError: next.resumeAt
                  ? `Claude usage limit — resumes ${next.resumeAt.toISOString()}`
                  : "Claude usage limit — waiting for reset",
              });

              continue;
            }

            // Success or different error — handle normally
            const retryText = retryResult.result?.trim()
              ? retryResult.result
              : retryResult.error || "(No response from engine)";

            insertMessage(session.id, "assistant", retryText);
            if (retryResult.cost || retryResult.numTurns) {
              recordTurnAccounting(session.id, retryResult);
            }

            // Clear typing indicator & reactions
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
            }
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, "eyes").catch(() => {});
              await connector.removeReaction(target, waitEmoji).catch(() => {});
            }

            {
              const { publicAction } = normalizeDelivery(retryText, this.buildDeliveryContext(session, msg, capabilities));
              await deliverPublic(connector, target, publicAction).catch(() => {});
            }
            const retryUpdated = updateSession(session.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: retryResult.error ? "error" : "idle",
              replyContext: msg.replyContext,
              messageId: msg.messageId ?? null,
              transportMeta: msg.transportMeta ?? null,
              lastActivity: new Date().toISOString(),
              lastError: retryResult.error ?? null,
              ...(typeof retryResult.contextTokens === "number" ? { lastContextTokens: retryResult.contextTokens } : {}),
            });
            if (retryUpdated) {
              notifyRateLimitResumed(retryUpdated);
              notifyDiscordChannel(
                `✅ Claude usage limit cleared. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} resumed.`,
              );
              notifyParentSession(retryUpdated, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }
            logger.info(`Session ${session.id} resumed after usage reset`);
            return;
          }

          // Exhausted waiting window
          notifyDiscordChannel(
            `❌ Claude usage limit did not clear in time. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} has been stopped.`,
          );
          await connector.replyMessage(target, "Usage limit didn't reset in time. Please try again later.").catch(() => {});
          updateSession(session.id, {
            status: "error",
            lastActivity: new Date().toISOString(),
            lastError: "Claude usage limit did not clear in time",
          });

          // Clear reactions on failure
          if (decorateMessages && capabilities.reactions) {
            await connector.removeReaction(target, "eyes").catch(() => {});
            await connector.removeReaction(target, waitEmoji).catch(() => {});
          }
          return;
        } finally {
          clearInterval(heartbeat);
        }
      }

      const responseText = result.result?.trim()
        ? result.result
        : result.error || "(No response from engine)";

      insertMessage(session.id, "assistant", responseText);
      recordTurnAccounting(session.id, result);
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }
      // Clear the processing "eyes" BEFORE delivering, so a react-only reply of
      // ":eyes:" isn't removed by this cleanup right after it's added.
      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
      }
      if (!wasInterrupted) {
        // Sanitize engine output before posting: strip operator-facing notes
        // (reply-disposition trailer) so they never reach an external channel,
        // and enforce "addressed ⇒ never silent". See the 2026-06-18 design doc.
        const deliveryCtx = this.buildDeliveryContext(session, msg, capabilities);
        // Multi-turn sessions (driven by /goal) carry every intermediate turn in
        // `result.turns`. Batch-normalize so internal notes are stripped per turn
        // without ack multiplication; a single ack is added only if no turn was
        // public. The last entry equals `result.result`.
        const turns = result.turns ?? [];
        if (turns.length > 1) {
          const { actions } = normalizeTurns(turns, deliveryCtx);
          for (const action of actions) {
            await deliverPublic(connector, target, action);
          }
        } else {
          const { publicAction } = normalizeDelivery(responseText, deliveryCtx);
          await deliverPublic(connector, target, publicAction);
        }
      }
      const updatedSession = updateSession(session.id, {
        ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
        status: wasInterrupted ? "idle" : (result.error ? "error" : "idle"),
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: (() => {
          const merged = mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta) as Record<string, unknown>;
          if (syncRequested && !rateLimit.limited && !wasInterrupted) {
            delete merged["claudeSyncSince"];
          }
          return merged as any;
        })(),
        lastActivity: new Date().toISOString(),
        lastError: wasInterrupted ? null : (result.error ?? null),
        ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
      });
      if (updatedSession) {
        notifyParentSession(updatedSession, { result: result.result, error: wasInterrupted ? null : (result.error ?? null), cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: employee?.alwaysNotify });
      }

      logger.info(
        `Session ${session.id} completed in ${result.durationMs ?? 0}ms` +
        (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Session ${session.id} error: ${errMsg}`);

      const erroredSession = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      if (erroredSession) {
        notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
      }

      // Clear typing indicator on error
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }

      await connector.replyMessage(target, `Error: ${errMsg}`).catch(() => {});

      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
        await connector.removeReaction(target, "hourglass_flowing_sand").catch(() => {});
      }
    } finally {
      // Clean up temp attachment files downloaded from Slack
      for (const filePath of attachments) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // Ignore cleanup errors — best effort
        }
      }

      if (mcpConfigPath) cleanupMcpConfigFile(session.id);
    }
  }

  async handleCommand(msg: IncomingMessage, connector: Connector): Promise<boolean> {
    const text = msg.text.trim();
    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    if (text === "/new" || text.startsWith("/new ")) {
      this.resetSession(msg.sessionKey);
      await connector.replyMessage(target, "Session reset. Starting fresh.");
      logger.info(`Session reset for ${msg.sessionKey}`);
      return true;
    }

    if (text === "/status" || text.startsWith("/status ")) {
      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      const queueDepth = this.queue.getPendingCount(session.sessionKey);
      const transportState = this.queue.getTransportState(session.sessionKey, session.status);
      const info = [
        `Session: ${session.id}`,
        `Engine: ${session.engine}`,
        `Connector: ${session.connector || session.source}`,
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex" | "gemini"]?.model || "default"}`,
        `State: ${transportState}`,
        `Queue depth: ${queueDepth}`,
        `Created: ${session.createdAt}`,
        `Last activity: ${session.lastActivity}`,
        session.lastError ? `Last error: ${session.lastError}` : null,
      ].filter(Boolean).join("\n");

      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/model")) {
      const nextModel = text.slice("/model".length).trim();
      if (!nextModel) {
        await connector.replyMessage(target, "Usage: /model <model-name>");
        return true;
      }

      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      updateSession(session.id, {
        model: nextModel,
        lastActivity: new Date().toISOString(),
      });
      await connector.replyMessage(target, `Model updated to \`${nextModel}\` for this session.`);
      return true;
    }

    if (text === "/doctor" || text.startsWith("/doctor ")) {
      const connectors = Array.from(this.connectorProvider().values());
      const connectorLines = connectors.length > 0
        ? connectors.map((candidate) => {
            const health = candidate.getHealth();
            return `- ${candidate.name}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`;
          })
        : ["- none"];
      const info = [
        `Default engine: ${this.config.engines.default}`,
        `Claude: ${this.config.engines.claude.model}`,
        `Codex: ${this.config.engines.codex.model}`,
        ...(this.config.engines.gemini ? [`Gemini: ${this.config.engines.gemini.model}`] : []),
        "Connectors:",
        ...connectorLines,
      ].join("\n");
      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/cron")) {
      return this.handleCronCommand(text, connector, target);
    }

    return false;
  }

  resetSession(sessionKey: string): void {
    const session = getSessionBySessionKey(sessionKey);
    if (session) {
      deleteSession(session.id);
      logger.info(`Deleted session ${session.id}`);
    }
  }

  private async handleCronCommand(text: string, connector: Connector, target: Target): Promise<boolean> {
    const [_, subcommand = "", ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (!subcommand || subcommand === "list") {
      const jobs = loadJobs();
      if (jobs.length === 0) {
        await connector.replyMessage(target, "No cron jobs configured.");
        return true;
      }

      const lines = jobs.map((job) =>
        `- ${job.name} (${job.id}) — ${job.enabled ? "enabled" : "disabled"} — ${job.schedule}`,
      );
      await connector.replyMessage(target, ["Cron jobs:", ...lines].join("\n"));
      return true;
    }

    if (subcommand === "run") {
      if (!arg) {
        await connector.replyMessage(target, "Usage: /cron run <job-id-or-name>");
        return true;
      }
      const job = await triggerCronJob(arg);
      await connector.replyMessage(
        target,
        job ? `Triggered cron job "${job.name}".` : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      if (!arg) {
        await connector.replyMessage(target, `Usage: /cron ${subcommand} <job-id-or-name>`);
        return true;
      }
      const job = setCronJobEnabled(arg, subcommand === "enable");
      await connector.replyMessage(
        target,
        job
          ? `Cron job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.`
          : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    await connector.replyMessage(target, "Usage: /cron [list|run|enable|disable] <job-id-or-name>");
    return true;
  }
}
