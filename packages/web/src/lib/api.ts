export interface EngineProbe {
  name: string
  configured: boolean
  installed: boolean
  runnable: boolean
  bin?: string
  version?: string
  error?: string
  auth?: { method: "api-key" | "oauth" | "chatgpt" | "unknown" | "none"; expiresAt?: string; expired?: boolean; note: string }
}

export interface SlackVerifyResult {
  ok: boolean
  bot: { ok: boolean; team?: string; user?: string; error?: string }
  app: { ok: boolean; error?: string }
}

export interface SlackConnectResult {
  ok: boolean
  stage?: "verify" | "reload"
  error?: string
  /** What was there before the attempt: an existing Slack block, or none. */
  previous?: "config" | "none"
  /** True only when the pre-attempt state is fully back on disk AND the live
   *  connectors settled on it (old connector running again for "config";
   *  nothing left running for "none"). */
  rolledBack?: boolean
  /** running is always false for previous:"none" — nothing to bring back. */
  restored?: { disk: boolean; running: boolean }
  rollbackError?: string
  rollbackSkipped?: string
  team?: string
  user?: string
  bot?: SlackVerifyResult["bot"]
  app?: SlackVerifyResult["app"]
}

/** PUT /api/config answers with the connector reload it triggered itself. */
export interface ConfigUpdateResult extends Record<string, unknown> {
  status?: "ok" | "partial" | string
  connectorsReload?: { started?: string[]; stopped?: string[]; errors?: string[] }
}

export interface WorkflowSummary {
  id: string
  title: string
  description: string | null
  revision: number
  enabled: boolean
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowNodeSummary {
  id: string
  type: string
  name: string
  config: Record<string, unknown>
}

export interface WorkflowDefinitionDetail extends WorkflowSummary {
  nodes: WorkflowNodeSummary[]
  edges: Array<{ id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }>
}

export interface WorkflowApprovalInfo {
  nodeId: string
  status: "pending" | "approved" | "rejected"
  requestedAt: string
}

export interface WorkflowRunDetailForApproval {
  revision: number
  status: string
  approvals: WorkflowApprovalInfo[]
  definition?: { edges: Array<{ from: { nodeId: string }; to: { nodeId: string } }> }
  nodeRuns: Array<{ nodeId: string; output?: { fields?: Record<string, unknown> } }>
}

export interface WorkflowRunSummary {
  id: string
  workflowId: string
  status: string
  trigger: { nodeId: string; kind: string }
  startedAt: string
  endedAt: string | null
  currentOrFailingNode: { nodeId: string; label: string; state: "current" | "failing" } | null
}

export interface AutomationTemplateVariable {
  key: string
  label: string
  hint: string
  required: boolean
  default?: string
  options?: string[]
}

export interface AutomationTemplateSpec {
  id: string
  name: string
  when: string
  flow: string
  variables: AutomationTemplateVariable[]
}

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
}

export interface SessionPageResponse {
  sessions: Record<string, unknown>[]
  nextCursor: string | null
}

export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'notification'
  content: string
  timestamp: number
}

export interface MessagePageResponse {
  messages: SessionMessage[]
  hasOlder: boolean
  hasNewer?: boolean
  anchorFound?: boolean
}

export interface MessageSearchResult {
  messageId: string
  sessionId: string
  snippet: string
  role: 'user' | 'assistant'
  timestamp: number
  employee: string | null
  engine: string | null
}

export interface MessageSearchResponse {
  query: string
  results: MessageSearchResult[]
  indexing: boolean
}

export interface ClaudeUsageResponse {
  available: boolean
  source: 'claude-oauth-usage'
  refreshedAt: string
  windows: Array<{
    name: string
    usedPercent: number
    windowDurationMins?: number
    resetsAt?: number
    resetsAtIso?: string
  }>
  unavailableReason?: 'disabled' | 'no-oauth-credentials' | 'provider-unavailable'
}

export interface UpdateStatusResponse {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string
  releaseUrl: string | null
  stale: boolean
  error?: 'registry-unavailable' | 'invalid-registry-response'
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
  alwaysNotify?: boolean;
  reportsTo?: string | string[];
  parentName?: string | null;
  directReports?: string[];
  depth?: number;
  chain?: string[];
}

export interface OrgWarning {
  employee: string;
  type: string;
  message: string;
  ref?: string;
}

export interface OrgHierarchy {
  root: string | null;
  sorted: string[];
  warnings: OrgWarning[];
}

export interface OrgData {
  departments: string[];
  employees: Employee[];
  hierarchy: OrgHierarchy;
}

const BASE =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:7777";

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body.error) return String(body.error);
    if (body.message) return String(body.message);
  } catch {
    // Response wasn't JSON — fall through
  }
  return `API error: ${res.status}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

export const api = {
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  getUpdateStatus: (refresh = false) =>
    get<UpdateStatusResponse>(`/api/update${refresh ? "?refresh=1" : ""}`),
  getClaudeUsage: () => get<ClaudeUsageResponse>("/api/usage/claude"),
  getSessions: () => get<Record<string, unknown>[]>("/api/sessions"),
  getSessionPage: (cursor?: string, limit = 100) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    return get<SessionPageResponse>(`/api/sessions?${params}`)
  },
  getSession: (id: string, options?: { last?: number; messages?: boolean }) => {
    const params = new URLSearchParams()
    if (options?.last) params.set('last', String(options.last))
    if (options?.messages === false) params.set('messages', '0')
    const suffix = params.size ? `?${params}` : ''
    return get<Record<string, unknown>>(`/api/sessions/${id}${suffix}`)
  },
  getSessionMessages: (id: string, before?: string, limit = 100) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (before) params.set('before', before)
    return get<MessagePageResponse>(`/api/sessions/${id}/messages?${params}`)
  },
  getSessionMessageWindow: (id: string, around: string, radius = 50) => {
    const params = new URLSearchParams({ around, limit: String(radius) })
    return get<MessagePageResponse>(`/api/sessions/${id}/messages?${params}`)
  },
  searchMessages: (query: string, limit = 20) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return get<MessageSearchResponse>(`/api/search/messages?${params}`)
  },
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  updateSession: (id: string, data: { title?: string }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/duplicate`, {}),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  createStubSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions/stub", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/stop`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  // --- Workflows (automation hub) ---
  getWorkflows: (cursor?: string) =>
    get<{ items: WorkflowSummary[]; nextCursor: string | null }>(
      cursor ? `/api/workflows?cursor=${encodeURIComponent(cursor)}` : "/api/workflows"),
  getWorkflow: (id: string) => get<WorkflowDefinitionDetail>(`/api/workflows/${encodeURIComponent(id)}`),
  setWorkflowEnabled: (id: string, enabled: boolean, expectedRevision: number) =>
    post<WorkflowSummary>(`/api/workflows/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { expectedRevision }),
  startWorkflowRun: (id: string) =>
    post<{ id: string; status: string }>(`/api/workflows/${encodeURIComponent(id)}/runs`, { input: {} }),
  getWorkflowRuns: (id: string) =>
    get<{ items: WorkflowRunSummary[] }>(`/api/workflows/${encodeURIComponent(id)}/runs`),
  getWorkflowRun: (id: string, runId: string) =>
    get<WorkflowRunDetailForApproval>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}?view=full`),
  // Who decided is stamped by the gateway from the request itself (a browser
  // call carries no caller-session header → operator), so the body carries
  // only the decision.
  decideWorkflowApproval: (id: string, runId: string, nodeId: string, decision: "approve" | "reject", expectedRevision: number) =>
    post<{ status: string }>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
      { decision, expectedRevision }),
  getAutomationTemplates: () =>
    get<{ templates: AutomationTemplateSpec[]; workflowsEnabled: boolean }>("/api/automation/templates"),
  createWorkflowFromTemplate: (templateId: string, data: { name: string; title?: string; vars: Record<string, string>; enable?: boolean }) =>
    post<{ id: string; revision: number; enabled: boolean }>(`/api/automation/templates/${encodeURIComponent(templateId)}`, data),
  getCronJobs: () => get<Record<string, unknown>[]>("/api/cron"),
  createCronJob: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/cron", data),
  getCronRuns: (id: string) => get<Record<string, unknown>[]>(`/api/cron/${id}/runs`),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  triggerCronJob: (id: string) =>
    post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getOrg: () => get<OrgData>("/api/org"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  updateEmployee: (name: string, data: { alwaysNotify?: boolean }) =>
    patch<{ status: string }>(`/api/org/employees/${name}`, data),
  getDepartmentBoard: (name: string) =>
    get<Record<string, unknown>>(`/api/org/departments/${name}/board`),
  getSkills: () => get<Record<string, unknown>[]>("/api/skills"),
  getSkill: (name: string) => get<Record<string, unknown>>(`/api/skills/${name}`),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<ConfigUpdateResult>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboardingEngines: () =>
    get<{ default: string; probedAt: string; engines: EngineProbe[] }>("/api/onboarding/engines"),
  verifySlackTokens: (botToken: string, appToken: string) =>
    post<SlackVerifyResult>("/api/onboarding/slack/verify", { botToken, appToken }),
  // Verify → save → reload → rollback-on-failure as ONE server-side operation.
  connectSlack: (botToken: string, appToken: string) =>
    post<SlackConnectResult>("/api/onboarding/slack/connect", { botToken, appToken }),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
  getActivity: () =>
    get<Array<{ event: string; payload: unknown; ts: number }>>("/api/activity"),
  updateDepartmentBoard: (name: string, data: unknown) =>
    put<Record<string, unknown>>(`/api/org/departments/${name}/board`, data),
  sttStatus: () =>
    get<{ available: boolean; model: string | null; downloading: boolean; progress: number; languages: string[] }>("/api/stt/status"),
  sttDownload: () =>
    post<{ status: string; model: string }>("/api/stt/download", {}),
  sttTranscribe: async (audioBlob: Blob, language?: string): Promise<{ text: string }> => {
    const params = language ? `?language=${encodeURIComponent(language)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); // 5 min timeout
    try {
      const res = await fetch(`${BASE}/api/stt/transcribe${params}`, {
        method: "POST",
        headers: { "Content-Type": audioBlob.type || "audio/webm" },
        body: audioBlob,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Transcription timed out (5 min)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  sttUpdateConfig: (languages: string[]) =>
    put<{ status: string; languages: string[] }>("/api/stt/config", { languages }),
  getSessionQueue: (id: string) =>
    get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) =>
    del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  clearSessionQueue: (sessionId: string) =>
    del<{ status: string; cancelled: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),
  uploadFile: async (file: File): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(await extractErrorMessage(res))
    return res.json()
  },
};
