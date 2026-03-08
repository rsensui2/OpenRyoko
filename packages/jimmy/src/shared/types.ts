export type StreamDeltaType = "text" | "tool_use" | "tool_result" | "status" | "error";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
}

export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  cwd: string;
  bin?: string;
  model?: string;
  attachments?: string[];
  onStream?: (delta: StreamDelta) => void;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
}

export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
}

export interface IncomingMessage {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: any;
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
}

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
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
}

export interface Department {
  name: string;
  displayName: string;
  description: string;
}

export interface JimmyConfig {
  gateway: { port: number; host: string; streaming?: boolean };
  engines: {
    default: "claude" | "codex";
    claude: { bin: string; model: string; effortLevel?: string };
    codex: { bin: string; model: string };
  };
  connectors: Record<string, any>;
  logging: { file: boolean; stdout: boolean; level: string };
}
