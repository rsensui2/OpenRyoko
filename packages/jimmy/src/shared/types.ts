export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "permission" | "status" | "error" | "context";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
  /** Set when this delta belongs to a Task sub-agent (interactive PTY engine).
   *  The chat pane routes tagged deltas into a collapsible sub-agent card instead
   *  of the main transcript. Absent for main-agent deltas. */
  subAgent?: { id: string; label?: string };
}

export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

export interface InterruptibleEngine extends Engine {
  /** Kill a running engine process for a specific Jinn session. */
  kill(sessionId: string, reason?: string): void;
  /** Check if a live engine process is still running for this session. */
  isAlive(sessionId: string): boolean;
  /** Kill all live engine processes during gateway shutdown. */
  killAll(): void;
}

export function isInterruptibleEngine(engine: Engine): engine is InterruptibleEngine {
  return "kill" in engine && "isAlive" in engine && "killAll" in engine;
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  /** Extra CLI flags to pass to the engine binary (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** Path to MCP config JSON file (passed as --mcp-config to Claude Code) */
  mcpConfigPath?: string;
  onStream?: (delta: StreamDelta) => void;
  /** Unique Jinn session ID for tracking the spawned process. */
  sessionId?: string;
  /** If set, run the engine binary on a remote host via SSH instead of locally. */
  sshHost?: string;
  /** Working directory on the remote host (only used when sshHost is set). */
  remoteCwd?: string;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  /**
   * Most recent turn's INPUT context size (input + cache-read + cache-creation
   * tokens) — i.e. how full the context window currently is. Undefined when the
   * engine doesn't surface usage. Powers the context meter in the UI.
   */
  contextTokens?: number;
  error?: string;
  /**
   * Optional rate limit metadata returned by an engine.
   * `resetsAt` is a Unix timestamp in seconds.
   */
  rateLimit?: EngineRateLimitInfo;
  /**
   * For sessions that span multiple assistant turns (e.g. when `/goal` keeps
   * Claude working until a completion condition holds), each turn's final
   * text in chronological order. `result` remains the LAST turn's text for
   * backward compatibility; callers that want to surface progress should
   * iterate `turns` instead.
   */
  turns?: string[];
}

export interface EngineRateLimitInfo {
  status?: string;
  /** Unix timestamp in seconds */
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ConnectorCapabilities {
  threading: boolean;
  messageEdits: boolean;
  reactions: boolean;
  attachments: boolean;
}

export interface ConnectorHealth {
  status: "running" | "stopped" | "error" | "qr_pending";
  detail?: string;
  capabilities: ConnectorCapabilities;
}

export type ReplyContext = JsonObject;

export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getCapabilities(): ConnectorCapabilities;
  getHealth(): ConnectorHealth;
  reconstructTarget(replyContext: ReplyContext): Target;
  sendMessage(target: Target, text: string): Promise<string | void>;
  replyMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;
  setTypingStatus?(channelId: string, threadTs: string | undefined, status: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** Return the bound employee name, if any */
  getEmployee?(): string | undefined;
}

export interface IncomingMessage {
  connector: string;
  source: string;
  sessionKey: string;
  replyContext: ReplyContext;
  messageId?: string;
  channel: string;
  thread?: string;
  user: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
  transportMeta?: JsonObject;
}

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
  localPath?: string;
}

export interface Target {
  channel: string;
  thread?: string;
  messageTs?: string;
  replyContext?: ReplyContext;
}

// --- Workflow attempt contract (ported from upstream jinn) ---

export type SessionAttemptOutcome = "succeeded" | "failed" | "interrupted";
export type WorkflowAttemptInterruptionCause = "user-message" | "attempt-stop" | "gateway-restart";
export interface WorkflowAttemptContinuation { engine: string; engineSessionId: string; sourceSessionId: string }
export interface WorkflowAttemptCommand { owner: { workflowId: string; runId: string; nodeId: string; attempt: number }; employeeId: string; engine: string; model?: string; effort?: "low" | "medium" | "high" | "xhigh"; prompt: string; continueFrom?: WorkflowAttemptContinuation }
export interface WorkflowAttemptCompletion { sessionId: string; owner: { workflowId: string; runId: string; nodeId: string; attempt: number }; turn: number; terminalVersion: number; outcome: "succeeded" | "failed" | "interrupted"; interruptionCause?: WorkflowAttemptInterruptionCause; finalText?: string; error?: string; completedAt: string }
export type WorkflowAttemptCompletionListener = (event: WorkflowAttemptCompletion) => void | Promise<void>;
export interface WorkflowSessionExecutor {
  startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }>;
  stopAttempt(input: { sessionId: string; reason: string }): Promise<void>;
  remind(input: { sessionId: string; text: string }): Promise<void>;
  attemptState(sessionId: string): { idle: boolean; runningChildren: number } | null;
}

/** Durable attribution for a workflow-owned employee attempt session. */
export interface WorkflowSessionProvenance {
  kind: "phase";
  workflowId: string;
  /** Canonical agent-facing workflow name (definition.name, falling back to id). */
  workflowName: string;
  runId: string;
  /** Uniform workflow trigger source: manual, schedule, event-webhook, etc. */
  triggerSource: string;
  phase: {
    nodeId: string;
    name: string;
    /** One-based position in the run's frozen execution order. */
    index: number;
    round: number;
    attempt: number;
  };
}

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  replyContext: ReplyContext | null;
  messageId: string | null;
  transportMeta: JsonObject | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  /** Explicit workflow/run/phase attribution for grouping and filtered reads. */
  workflowProvenance?: WorkflowSessionProvenance | null;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  /** Durable terminal receipt for the latest execution attempt. Conversational
   * `idle` alone is never proof that work completed successfully. */
  attemptOutcome?: SessionAttemptOutcome | null;
  /** Monotonic terminal-receipt version within the current attempt generation. */
  attemptTerminalVersion?: number;
  /** Monotonic count of completed turns in a workflow attempt session. */
  attemptTurn?: number;
  /** Durable interruption classification recorded before an engine is killed. */
  attemptInterruptionCause?: WorkflowAttemptInterruptionCause | null;
  attemptInterruptionTurn?: number | null;
  effortLevel: string | null;
  totalCost: number;
  totalTurns: number;
  /** Most recent turn's input context size (context-meter). Null when unknown. */
  lastContextTokens: number | null;
  queueDepth?: number;
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: 'not_started' | 'in_progress' | 'at_risk' | 'completed';
  level: 'company' | 'department' | 'task';
  parentId: string | null;
  department: string | null;
  owner: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  /** Normal jobs always invoke the AI. Update notifications first perform a
   * deterministic npm registry check and invoke the AI only for a new release. */
  kind?: "prompt" | "update-notification";
  timezone?: string;
  engine?: string;
  model?: string;
  employee?: string;
  prompt: string;
  delivery?: CronDelivery;
}

export interface CronDelivery {
  connector: string;
  channel: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  /** Emoji icon for this employee (shown in sidebar, org chart, etc.) */
  emoji?: string;
  /** Extra CLI flags passed to the engine (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** MCP servers this employee needs. true = all global, false = none, string[] = specific servers */
  mcp?: boolean | string[];
  /** Max cost in USD for a single session. Overrides global config. */
  maxCostUsd?: number;
  /** Default effort level for sessions assigned to this employee */
  effortLevel?: string;
  /** Whether to notify the parent session when this employee's child session completes. Default: true */
  alwaysNotify?: boolean;
  /** Who this employee reports to. String = single parent. Array = primary + dotted-line (future). */
  reportsTo?: string | string[];
  /** Services this employee provides to the org */
  provides?: ServiceDeclaration[];
  /** If set, run this employee's engine on a remote host via SSH. */
  sshHost?: string;
  /** Working directory on the remote host (only used together with sshHost). */
  remoteCwd?: string;
}

/** A service that an employee can provide to other employees/departments. */
export interface ServiceDeclaration {
  name: string;
  description: string;
}

/** A node in the resolved org tree. Wraps an Employee with computed hierarchy data. */
export interface OrgNode {
  employee: Employee;
  /** Resolved primary parent name (null = reports to root) */
  parentName: string | null;
  /** Names of direct reports */
  directReports: string[];
  /** Depth in tree (root = 0, root's reports = 1, etc.) */
  depth: number;
  /** Path from root to this node (excluding virtual root), e.g. ["pravko-lead", "pravko-writer"] */
  chain: string[];
}

/** Warning about a hierarchy issue. */
export interface OrgWarning {
  employee: string;
  type: "broken_ref" | "cycle" | "self_ref" | "cross_department" | "multiple_executives";
  message: string;
  /** The invalid reportsTo value that caused this warning */
  ref?: string;
}

/** The fully resolved org hierarchy. */
export interface OrgHierarchy {
  /** Root node name — executive employee name, or null if no executive YAML exists */
  root: string | null;
  /** All nodes keyed by employee name */
  nodes: Record<string, OrgNode>;
  /** Ordered list for flat iteration (topological/BFS order, root first) */
  sorted: string[];
  /** Any resolution warnings */
  warnings: OrgWarning[];
}

export interface Department {
  name: string;
  displayName: string;
  description: string;
}

/** Stdio-based MCP server (spawned as child process) */
export interface McpServerStdioConfig {
  /** Shell command to start the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

/** HTTP/SSE-based MCP server (remote URL) */
export interface McpServerUrlConfig {
  /** Transport type — Claude Code requires "sse" for URL-based servers */
  type?: "sse";
  /** URL of the MCP server (HTTP streamable or SSE transport) */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/** MCP server config — either stdio (command) or URL-based */
export type McpServerConfig = McpServerStdioConfig | McpServerUrlConfig;

export interface McpGlobalConfig {
  browser?: {
    enabled: boolean;
    provider?: "playwright" | "puppeteer";
  };
  search?: {
    enabled: boolean;
    provider?: "brave";
    apiKey?: string;
  };
  fetch?: {
    enabled: boolean;
  };
  gateway?: {
    enabled: boolean;
  };
  /** Custom MCP servers defined by the user */
  custom?: Record<string, (McpServerStdioConfig | McpServerUrlConfig) & { enabled?: boolean }>;
}

export interface WebConnectorConfig {}

export interface SlackTriageConfig {
  /** Enable the air-reading triage layer. Default: false (legacy behavior). */
  enabled?: boolean;
  /** CLI engine to invoke for triage. Default: "codex"; "claude" is supported. */
  engine?: "claude" | "codex";
  /** Binary to invoke for triage. Defaults to the selected engine's CLI. */
  bin?: string;
  /** Model to use for triage calls. Defaults to claude-haiku-4-5 or gpt-5-nano. */
  model?: string;
  /** Soft timeout before falling back to "silent". Default: 30000ms. */
  timeoutMs?: number;
  /** How many recent thread messages to include as context. Default: 10. */
  threadContextLimit?: number;
  /** Optional persona override for the triage prompt. Defaults to the bot's configured persona. */
  persona?: string;
  /**
   * @deprecated No longer used. Conversation engagement is now tracked
   * permanently per-thread / per-(channel, user), invalidated only when a
   * third human joins. This field is accepted for backwards compatibility
   * with existing config files but has no effect.
   */
  activeThreadTtlMs?: number;
}

export interface SlackGoalExtractionConfig {
  /** Enable natural-language /goal injection. Default: false due to latency. */
  enabled?: boolean;
  /** CLI engine used for the extraction decision. Defaults to "codex". The injected /goal itself only works with Claude sessions. */
  engine?: "claude" | "codex";
  /** Binary to invoke. Defaults to the selected engine's CLI. */
  bin?: string;
  /** Model to use for goal extraction. Defaults to claude-haiku-4-5 or gpt-5-nano. */
  model?: string;
  /** Hard timeout before skipping /goal injection. Default: 30000ms. */
  timeoutMs?: number;
}

/** Response mode for one Slack conversation scope. */
export type SlackRespondMode = "always" | "mention" | "never";

/**
 * Deterministic response gate, evaluated before the LLM triage layer.
 * Absent (or "always" in every scope) preserves the legacy respond-to-everything
 * behavior. "mention" scopes drop messages that don't @-mention the bot,
 * except inside threads the bot has already engaged (see `engagedThreads`).
 */
export interface SlackRespondToConfig {
  /** 1:1 DMs. Default: "always". */
  im?: SlackRespondMode;
  /** Group DMs (mpim). Default: "always". */
  mpim?: SlackRespondMode;
  /** Public and private channels. Default: "always". */
  channel?: SlackRespondMode;
  /**
   * In "mention" scopes, keep replying inside threads the bot has already
   * engaged (replied or reacted in) without requiring a re-mention on every
   * message. Default: true.
   */
  engagedThreads?: boolean;
}

export interface SlackConnectorConfig {
  /** Unique instance identifier (e.g. "slack-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  appToken: string;
  botToken: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  /** Deterministic per-scope response gate (DM / group DM / channel). */
  respondTo?: SlackRespondToConfig;
  /** Air-reading triage: decide per-message whether to reply/react/stay silent */
  triage?: SlackTriageConfig;
  /** Natural-language autonomous goal detection. Off by default because it adds latency. */
  goalExtraction?: SlackGoalExtractionConfig;
  /** Self-updating Slack Canvas mirroring OpenRyoko's current sessions (Agents View). */
  agentsCanvas?: {
    /** Master switch — defaults to false when the block is absent. */
    enabled?: boolean;
    /** Slack channel ID to host the canvas in. If unset, a standalone canvas is created. */
    channelId?: string;
    /** Canvas title. Default: "Ryoko Agents View". */
    title?: string;
    /** Refresh interval in ms (min 5000, default 30000). */
    pollIntervalMs?: number;
    /** Max sessions rendered per status group. Default 10. */
    maxPerGroup?: number;
  };
}

/** Response mode for one Discord conversation scope. */
export type DiscordRespondMode = "always" | "mention" | "never";

/**
 * Deterministic response gate for the Discord connector — the Discord port of
 * `SlackRespondToConfig`. "mention" scopes drop messages that neither
 * @-mention the bot nor reply to one of its messages, except inside threads
 * the bot has already engaged (see `engagedThreads`). Absent (or "always" in
 * every scope) keeps responding to every message, with one deliberate
 * exception that applies regardless of this config (Slack parity): channel
 * messages that @-mention or reply to somebody else — and not the bot — are
 * always ignored.
 */
export interface DiscordRespondToConfig {
  /** 1:1 and group DMs. Default: "always". */
  dm?: DiscordRespondMode;
  /** Guild text channels and threads. Default: "always". */
  channel?: DiscordRespondMode;
  /**
   * In "mention" scopes, keep replying inside threads the bot has already
   * engaged (replied or reacted in) without requiring a re-mention on every
   * message. Default: true.
   */
  engagedThreads?: boolean;
}

/**
 * Where the Discord connector puts its responses in flat guild channels
 * (threads and DMs are already precise destinations and ignore this).
 * "channel" (default) sends plain messages; "reply" attaches each response
 * to the triggering message with a Discord reply; "thread" opens (or
 * reuses) a thread rooted on the triggering message and responds there,
 * Slack-style — flat-channel messages then map to one session per thread.
 */
export type DiscordReplyStyle = "channel" | "reply" | "thread";

export interface DiscordConnectorConfig {
  /** Unique instance identifier (e.g. "discord-vox") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken?: string;       // Make optional — not needed in proxy mode
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
  /** Only respond to messages in this channel */
  channelId?: string;
  /** Route messages from specific channels to remote Jinn instances */
  channelRouting?: Record<string, string>;
  /** URL of the primary Jinn instance to proxy Discord I/O through (secondary/remote mode) */
  proxyVia?: string;
  /** Deterministic per-scope response gate (DM / channel). */
  respondTo?: DiscordRespondToConfig;
  /** Where responses land in flat guild channels. Default: "channel". */
  replyStyle?: DiscordReplyStyle;
}

export interface TelegramConnectorConfig {
  /** Unique instance identifier (e.g. "telegram-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken: string;
  allowFrom?: number[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface WhatsAppConnectorConfig {
  /** Unique instance identifier (e.g. "whatsapp-main") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  /** Where to store session credentials (default: JINN_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow all */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface ConnectorInstance {
  /** Unique instance ID */
  id: string;
  /** Connector type */
  type: "discord" | "discord-remote" | "slack" | "whatsapp" | "telegram";
  /** Employee to bind to this connector */
  employee?: string;
  /** Type-specific configuration */
  [key: string]: unknown;
}

export interface PortalConfig {
  portalName?: string;
  operatorName?: string;
  /** Additional names/handles that identify the operator across chat platforms
   *  (e.g. ["泉水亮介", "Ryosuke Sensui", "rsensui"]). Checked alongside
   *  operatorName by the shared operator matcher — configure when the display
   *  nickname alone can't be matched to the operator's platform profile. */
  operatorAliases?: string[];
  language?: string;
  onboarded?: boolean;
  /** Platform user IDs (Slack "U…" IDs and Discord snowflakes) whose DIRECT
   *  MESSAGES may receive MEMORY.md in the system prompt (list the
   *  operator's own IDs here too). This is a privacy gate keyed on immutable
   *  IDs only — display names are spoofable. Web sessions are always
   *  eligible; shared channels never are. */
  trustedSpeakers?: string[];
  /** The operator's own Slack user ID. When set (alone or with
   *  operatorDiscordId), operator identification is strict ID equality and
   *  display-name matching is disabled — a speaker merely named like the
   *  operator is never asserted to BE the operator. Strongly recommended
   *  wherever the workspace has untrusted members. */
  operatorSlackId?: string;
  /** The operator's own Discord user ID (snowflake — right-click profile →
   *  Copy User ID). Same strict-equality semantics as operatorSlackId; a
   *  Discord speaker can only be the operator through this ID. Quote it in
   *  YAML or not — numeric snowflakes are normalized to strings. */
  operatorDiscordId?: string | number;
}

// --- Engine quota/limit snapshots ---

export interface EngineLimitWindow {
  name: string;
  usedPercent?: number;
  windowDurationMins?: number;
  /** Unix timestamp in seconds. */
  resetsAt?: number;
  resetsAtIso?: string;
}

// --- Model + capability registry ---
// Single source of truth for which engines/models exist and what they support.
// Shipping a NEW model is a config edit (`models:` block in config.yaml), zero
// code change. When the block is absent, the registry is synthesized from
// `engines.<name>.model` so existing configs keep working.

/** How an engine conveys reasoning-effort to its CLI. */
export type EffortMechanism = "claude-flag" | "codex-config" | "none";

/** A single model and its capabilities, as exposed to the UI / validation. */
export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  /** Valid effort levels for THIS model (empty when supportsEffort is false). */
  effortLevels: string[];
  /** Context window size in tokens (for the UI context meter). Omit if unknown. */
  contextWindow?: number;
}

/** Resolved per-engine registry entry. */
export interface EngineRegistryEntry {
  name: string;
  /** Engine is registered/usable in this build. */
  available: boolean;
  /** Default model id for new sessions on this engine. */
  defaultModel: string;
  effortMechanism: EffortMechanism;
  models: ModelInfo[];
}

/** Resolved registry, keyed by engine name. */
export type ModelRegistry = Record<string, EngineRegistryEntry>;

// --- config.yaml `models:` block shapes (all fields optional/forgiving) ---

export interface ModelConfigEntry {
  id: string;
  label?: string;
  supportsEffort?: boolean;
  effortLevels?: string[];
  contextWindow?: number;
}

export interface EngineModelsConfig {
  /** Default model id; falls back to the first listed model. */
  default?: string;
  effortMechanism?: EffortMechanism;
  models: ModelConfigEntry[];
}

/** `models:` block keyed by engine name (claude | codex | gemini). */
export type ModelsConfig = Record<string, EngineModelsConfig>;

export interface JinnConfig {
  jinn?: { version?: string };
  gateway: {
    port: number;
    host: string;
    streaming?: boolean;
    authRequired?: boolean;
    authDisabled?: boolean;
    insecureAllowUnauthenticatedNetwork?: boolean;
    /** Hostnames accepted by the DNS-rebinding guard (for reverse proxies). */
    allowedHosts?: string[];
    /** Honor X-Forwarded-Proto only when requests arrive through a trusted proxy. */
    trustProxyHeaders?: boolean;
    /** Exact remote IP addresses allowed to supply trusted proxy headers. */
    trustedProxyAddresses?: string[];
  };
  engines: {
    default: "claude" | "codex" | "gemini";
    claude: {
      bin: string;
      model: string;
      effortLevel?: string;
      childEffortOverride?: string;
      /** Opt-in: run Claude as an interactive PTY (cc_entrypoint=cli → Max-subscription
       *  billing) instead of headless `claude -p`. Replaces the engine under the "claude"
       *  key when true. Default false (headless `-p`). */
      interactive?: boolean;
      /** Dangerous opt-in: approves every unambiguous Claude safety dialog,
       * including destructive commands. Disabled by default. */
      autoApproveSafetyPrompts?: boolean;
      /** Max simultaneously-live PTYs for the interactive engine (LRU-evicted). Default 8. */
      maxLivePtys?: number;
      /** Hard ceiling (ms) on a single interactive turn before it is force-settled
       *  as timed out. Guards against a hung-but-alive PTY zombying a session.
       *  Default 5400000 (90 min) — accommodates long autonomous batch runs that
       *  legitimately occupy one turn (e.g. the seminar-demo generator). */
      interactiveTurnTimeoutMs?: number;
      /** Ordered engine names to try when this engine is unavailable (upstream chain spec). */
      fallback?: ("claude" | "codex" | "gemini")[];
      /** Pinned-model → substitute-model map applied when swapping engines. */
      fallbackModelMap?: Record<string, string>;
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string; fallback?: ("claude" | "codex" | "gemini")[]; fallbackModelMap?: Record<string, string> };
    gemini?: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string; fallback?: ("claude" | "codex" | "gemini")[]; fallbackModelMap?: Record<string, string> };
  };
  /** Optional model/capability registry override. Absent → synthesized from
   *  `engines.<name>.model`. See shared/models.ts. */
  models?: ModelsConfig;
  /** Workflow engine (ported from upstream jinn). Opt-in: absent/false = no
   *  workflow service, no schedule arming, no workflow API. */
  workflows?: {
    enabled?: boolean;
    /** Canonical git remote/branch a landing-evidence check verifies against. */
    delivery?: { remote?: string; branch?: string };
  };
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
    telegram?: TelegramConnectorConfig;
    discord?: DiscordConnectorConfig;
    whatsapp?: WhatsAppConnectorConfig;
    /** Named connector instances — allows multiple connectors of the same type */
    instances?: ConnectorInstance[];
  };
  logging: { file: boolean; stdout: boolean; level: string };
  mcp?: McpGlobalConfig;
  sessions?: {
    maxDurationMinutes?: number;
    maxCostUsd?: number;
    interruptOnNewMessage?: boolean;
    /** What to do when Claude hits a usage/rate limit. Default: "fallback" */
    rateLimitStrategy?: "wait" | "fallback";
    /** Engine to use when rateLimitStrategy="fallback". Default: "codex" */
    fallbackEngine?: "codex";
    /** Backoff delays (ms) between automatic retries after a transient Anthropic
     *  server error (5xx/529) ended a turn. One retry per entry, resuming the
     *  same engine session with a continuation prompt. Default: [30s, 120s, 300s].
     *  Set to [] to disable. */
    transientRetryDelaysMs?: number[];
    /** Deliver late/background engine output (a Stop hook that fires after the
     *  turn already settled — e.g. a background sub-agent finishing) back to the
     *  session's conversation. Default: true. */
    backgroundDelivery?: boolean;
  };
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
  };
  notifications?: {
    connector?: string;  // defaults to "discord"
    channel?: string;    // Discord channel ID for admin notifications
  };
  portal?: PortalConfig;
  context?: {
    /** Max characters for the built system prompt. Defaults to 100000. */
    maxChars?: number;
  };
  stt?: {
    enabled?: boolean;
    model?: string;
    /** @deprecated Use `languages` instead. Kept for backwards compat. */
    language?: string;
    languages?: string[];
  };
  remotes?: Record<string, { url: string; label?: string }>;
}
