/**
 * `ryoko automation` / `ryoko workflow` — the machine-friendly face of the
 * automation hub. Everything speaks through the gateway API (same routes the
 * web UI uses), takes `--json` for agents, and explains its own failures in
 * fixable terms. Claude Code / Codex are first-class callers here.
 */
import { requestGatewayApi } from "./api.js";
import { AUTOMATION_TEMPLATES, buildTemplateBody, TemplateError } from "../workflows/templates.js";

interface CronJobRow {
  id: string;
  schedule?: string;
  enabled?: boolean;
  employee?: string;
  description?: string;
  lastRun?: { at?: string; timestamp?: string; status?: string } | null;
}

interface WorkflowSummaryRow {
  id: string;
  title: string;
  enabled: boolean;
  revision: number;
  retiredAt: string | null;
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

class CliFailure extends Error {}

function fail(message: string): never {
  throw new CliFailure(message);
}

async function rawGateway(method: string, apiPath: string, data?: unknown): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    return await requestGatewayApi({ method, path: apiPath, ...(data === undefined ? {} : { data: JSON.stringify(data) }) });
  } catch (error) {
    fail(`ゲートウェイに接続できません（${error instanceof Error ? error.message : String(error)}）。\`ryoko status\` で稼働を確認してください。`);
  }
}

/** Whether the workflow engine is on — from the capability endpoint, which
 *  answers 200 either way. A failing capability call is an ERROR, never a
 *  silent "engine off": conflating the two would make an API outage look like
 *  a configuration choice. A 404 under /api/workflows can then be reported as
 *  what it is: this specific workflow does not exist. */
async function workflowsEnabled(): Promise<boolean> {
  const result = await rawGateway("GET", "/api/automation/templates");
  if (!result.ok) {
    fail(`ゲートウェイの状態を確認できません（GET /api/automation/templates が HTTP ${result.status}）。\`ryoko status\` とゲートウェイのログを確認してください。`);
  }
  let flag: unknown;
  try {
    flag = (JSON.parse(result.body) as { workflowsEnabled?: unknown }).workflowsEnabled;
  } catch {
    fail("ゲートウェイの応答を JSON として読めませんでした（/api/automation/templates）");
  }
  if (typeof flag !== "boolean") {
    fail("ゲートウェイの応答に workflowsEnabled (boolean) がありません（/api/automation/templates）");
  }
  return flag;
}

const ENGINE_DISABLED_MESSAGE =
  "Workflow エンジンが無効です。config.yaml に `workflows:\n  enabled: true` を追記してゲートウェイを再起動してください。";

async function gateway(method: string, apiPath: string, data?: unknown): Promise<unknown> {
  const result = await rawGateway(method, apiPath, data);
  if (result.status === 404 && apiPath.startsWith("/api/workflows")) {
    if (!(await workflowsEnabled())) fail(ENGINE_DISABLED_MESSAGE);
    fail(`見つかりません: ${method} ${apiPath}（ID を確認してください。一覧: ryoko workflow list）`);
  }
  if (!result.ok) {
    let detail = result.body;
    try {
      const parsed = JSON.parse(result.body) as { message?: string; error?: string; issues?: unknown };
      detail = parsed.message ?? parsed.error ?? result.body;
      if (parsed.issues) detail += `\n${JSON.stringify(parsed.issues, null, 2)}`;
    } catch { /* leave raw */ }
    fail(`${method} ${apiPath} が失敗しました（HTTP ${result.status}）: ${detail}`);
  }
  try {
    return result.body ? JSON.parse(result.body) : null;
  } catch {
    fail(`${apiPath} の応答を JSON として読めませんでした`);
  }
}

/** Drain every page of a cursor-paged list endpoint. */
async function gatewayAllPages<T>(apiPath: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const url = cursor ? `${apiPath}?cursor=${encodeURIComponent(cursor)}` : apiPath;
    const page = await gateway("GET", url) as CursorPage<T>;
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function emit(json: boolean, data: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  human();
}

function cronLastRunAt(job: CronJobRow): string {
  const at = job.lastRun?.at ?? job.lastRun?.timestamp;
  return typeof at === "string" ? at : "—";
}

/** One merged table: workflows and cron jobs, the same rows the web page shows. */
export async function runAutomationList(opts: { json?: boolean }): Promise<void> {
  const [cronJobs, engineOn] = await Promise.all([
    gateway("GET", "/api/cron") as Promise<CronJobRow[]>,
    workflowsEnabled(),
  ]);
  const workflowRows = engineOn ? await gatewayAllPages<WorkflowSummaryRow>("/api/workflows") : [];

  const rows = [
    ...workflowRows.filter((item) => !item.retiredAt).map((item) => ({
      kind: "workflow" as const, id: item.id, title: item.title, enabled: item.enabled, schedule: null as string | null, lastRun: null as string | null,
    })),
    ...cronJobs.map((job) => ({
      kind: "cron" as const, id: job.id, title: job.description ?? job.id, enabled: job.enabled !== false,
      schedule: job.schedule ?? null, lastRun: cronLastRunAt(job),
    })),
  ];

  emit(Boolean(opts.json), { workflowsEnabled: engineOn, automations: rows }, () => {
    if (!engineOn) {
      console.log("(Workflow エンジンは無効。cron のみ表示 — 有効化は config.workflows.enabled: true)\n");
    }
    const pad = (value: string, width: number) => value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
    console.log(`${pad("種別", 10)} ${pad("ID", 34)} ${pad("状態", 6)} ${pad("スケジュール", 16)} 最終実行`);
    for (const row of rows) {
      console.log(`${pad(row.kind, 10)} ${pad(row.id, 34)} ${pad(row.enabled ? "ON" : "off", 6)} ${pad(row.schedule ?? "—", 16)} ${row.lastRun ?? "—"}`);
    }
    console.log(`\n${rows.length} 件。詳細: ryoko workflow show <id> / 切替: ryoko automation enable|disable <id>`);
  });
}

/** enable/disable works on either kind by the same verb. When one id exists on
 *  BOTH sides, the caller has to say which one they mean (--kind). */
export async function runAutomationToggle(
  id: string,
  enabled: boolean,
  opts: { json?: boolean; kind?: string },
): Promise<void> {
  if (opts.kind !== undefined && opts.kind !== "cron" && opts.kind !== "workflow") {
    fail(`--kind は cron か workflow です（指定値: ${opts.kind}）`);
  }
  const cronJobs = await gateway("GET", "/api/cron") as CronJobRow[];
  const cron = cronJobs.find((job) => job.id === id);
  const engineOn = await workflowsEnabled();
  const workflowRows = engineOn ? await gatewayAllPages<WorkflowSummaryRow>("/api/workflows") : [];
  const workflow = workflowRows.find((item) => item.id === id);

  let kind = opts.kind as "cron" | "workflow" | undefined;
  if (!kind) {
    if (cron && workflow) fail(`"${id}" は cron と workflow の両方にあります。--kind cron か --kind workflow で指定してください。`);
    kind = cron ? "cron" : workflow ? "workflow" : undefined;
  }
  if (kind === "cron") {
    if (!cron) fail(`cron "${id}" は見つかりません（一覧: ryoko automation list）`);
    await gateway("PUT", `/api/cron/${encodeURIComponent(id)}`, { enabled });
    emit(Boolean(opts.json), { kind: "cron", id, enabled }, () => {
      console.log(`cron ${id} を ${enabled ? "有効" : "無効"} にしました`);
    });
    return;
  }
  if (kind === "workflow") {
    if (!workflow) {
      fail(engineOn ? `workflow "${id}" は見つかりません（一覧: ryoko workflow list）` : ENGINE_DISABLED_MESSAGE);
    }
    const saved = await gateway("POST", `/api/workflows/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
      { expectedRevision: workflow.revision }) as { enabled: boolean; revision: number };
    emit(Boolean(opts.json), { kind: "workflow", id, enabled: saved.enabled, revision: saved.revision }, () => {
      console.log(`workflow ${id} を ${saved.enabled ? "有効" : "無効"} にしました`);
    });
    return;
  }
  fail(engineOn
    ? `"${id}" は cron にも workflow にもありません（一覧: ryoko automation list）`
    : `"${id}" は cron にありません。${ENGINE_DISABLED_MESSAGE}`);
}

export async function runWorkflowTemplates(opts: { json?: boolean }): Promise<void> {
  emit(Boolean(opts.json), { templates: AUTOMATION_TEMPLATES }, () => {
    for (const template of AUTOMATION_TEMPLATES) {
      console.log(`${template.id} — ${template.name}`);
      console.log(`  こういう時: ${template.when}`);
      console.log(`  流れ: ${template.flow}`);
      console.log(`  変数:`);
      for (const variable of template.variables) {
        const req = variable.required ? "必須" : `任意${variable.default ? ` (既定 ${variable.default})` : ""}`;
        console.log(`    --set ${variable.key}=…  ${variable.label}（${req}）${variable.hint ? ` — ${variable.hint}` : ""}`);
      }
      console.log("");
    }
  });
}

export interface WorkflowCreateOptions {
  template?: string;
  file?: string;
  name?: string;
  title?: string;
  set: string[];
  enable?: boolean;
  json?: boolean;
}

export async function runWorkflowCreate(opts: WorkflowCreateOptions): Promise<void> {
  if (!opts.template && !opts.file) {
    fail("--template <id> か --file <def.json> のどちらかを指定してください。テンプレ一覧: ryoko workflow templates");
  }
  if (!opts.name) fail("--name <id> は必須です（英数とハイフン。例: --name inquiry-watch）");
  const id = opts.name;

  if (opts.template) {
    // The atomic endpoint validates the FULL definition before anything is
    // written, and enables in the same request — no skeleton on failure, and
    // the returned revision is the one the caller can act on.
    const vars: Record<string, string> = {};
    for (const pair of opts.set) {
      const eq = pair.indexOf("=");
      if (eq < 1) fail(`--set の形式が不正です: "${pair}"（--set key=value）`);
      vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    try {
      buildTemplateBody(opts.template, vars); // fail fast locally with fixable messages
    } catch (error) {
      if (error instanceof TemplateError) fail(error.message);
      throw error;
    }
    const result = await gateway("POST", `/api/automation/templates/${encodeURIComponent(opts.template)}`, {
      name: id, ...(opts.title ? { title: opts.title } : {}), vars, enable: Boolean(opts.enable),
    }) as { id: string; revision: number; enabled: boolean };
    emit(Boolean(opts.json), result, () => {
      console.log(`workflow ${result.id} を作成しました（${result.enabled ? "有効" : "無効のまま。有効化: ryoko automation enable " + result.id}）`);
    });
    return;
  }

  const { readFileSync } = await import("node:fs");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(opts.file!, "utf-8"));
  } catch (error) {
    fail(`${opts.file} を読めませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
  const definition = parsed as { nodes?: unknown[]; edges?: unknown[]; description?: string };
  if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    fail(`${opts.file} に nodes / edges がありません。GET /api/workflows/<id> が返す definition と同じ形にしてください`);
  }
  // Validate the complete definition locally BEFORE creating, so a bad file
  // never leaves a skeleton definition behind on the server.
  const { workflowDefinitionSchema } = await import("../workflows/model.js");
  const { validateExecutableWorkflow } = await import("../workflows/validation.js");
  const now = new Date().toISOString();
  const candidate = workflowDefinitionSchema.safeParse({
    schemaVersion: 1, id, title: opts.title ?? id,
    ...(definition.description ? { description: definition.description } : {}),
    revision: 1, enabled: false, createdAt: now, updatedAt: now,
    nodes: definition.nodes, edges: definition.edges,
  });
  if (!candidate.success) {
    fail(`定義がスキーマに合いません:\n${JSON.stringify(candidate.error.issues, null, 2)}`);
  }
  const executable = validateExecutableWorkflow(candidate.data);
  if (!executable.ok) {
    fail(`定義が実行可能ではありません:\n${JSON.stringify(executable.issues, null, 2)}`);
  }

  // One request, one transaction on the server: no skeleton on failure.
  const result = await gateway("POST", "/api/automation/definitions", {
    name: id, ...(opts.title ? { title: opts.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    nodes: definition.nodes, edges: definition.edges, enable: Boolean(opts.enable),
  }) as { id: string; revision: number; enabled: boolean };

  emit(Boolean(opts.json), result, () => {
    console.log(`workflow ${result.id} を作成しました（${result.enabled ? "有効" : "無効のまま。有効化: ryoko automation enable " + result.id}）`);
  });
}

export async function runWorkflowShow(id: string, opts: { json?: boolean }): Promise<void> {
  const definition = await gateway("GET", `/api/workflows/${encodeURIComponent(id)}`) as {
    id: string; title: string; enabled: boolean; revision: number; description?: string | null;
    nodes: Array<{ id: string; type: string; name: string }>;
  };
  emit(Boolean(opts.json), definition, () => {
    console.log(`${definition.id} — ${definition.title}（${definition.enabled ? "有効" : "無効"} / rev ${definition.revision}）`);
    if (definition.description) console.log(definition.description);
    console.log(`ノード: ${definition.nodes.map((node) => `${node.name}[${node.type}]`).join(" → ")}`);
  });
}

export async function runWorkflowStart(id: string, opts: { json?: boolean }): Promise<void> {
  const run = await gateway("POST", `/api/workflows/${encodeURIComponent(id)}/runs`, { input: {} }) as {
    id: string; status: string;
  };
  emit(Boolean(opts.json), { runId: run.id, status: run.status }, () => {
    console.log(`run ${run.id} を開始しました（${run.status}）。履歴: ryoko workflow runs ${id}`);
  });
}

export async function runWorkflowRuns(id: string, opts: { json?: boolean }): Promise<void> {
  const result = await gateway("GET", `/api/workflows/${encodeURIComponent(id)}/runs`) as {
    items: Array<{ id: string; status: string; startedAt: string; endedAt: string | null;
      currentOrFailingNode: { label: string; state: string } | null }>;
  };
  emit(Boolean(opts.json), result, () => {
    if (result.items.length === 0) {
      console.log("実行履歴はまだありません。手動実行: ryoko workflow run " + id);
      return;
    }
    for (const run of result.items) {
      const node = run.currentOrFailingNode ? ` @ ${run.currentOrFailingNode.label}(${run.currentOrFailingNode.state})` : "";
      console.log(`${run.startedAt}  ${run.status}${node}  ${run.id}`);
    }
  });
}

interface RunDetailForApproval {
  revision: number;
  approvals: Array<{ nodeId: string; status: string }>;
  definition?: { edges: Array<{ from: { nodeId: string }; to: { nodeId: string } }> };
  nodeRuns: Array<{ nodeId: string; output?: { fields?: Record<string, unknown> } }>;
}

/** The upstream output the pending gate is deciding ON — external, unverified
 *  content by construction. Walks back past pass-through nodes (a Condition
 *  outputs only its chosen port) to the nearest node that reported fields. */
function approvalContext(run: RunDetailForApproval, nodeId: string): Record<string, unknown> | undefined {
  let current = nodeId;
  for (let hop = 0; hop < 5; hop += 1) {
    const source = run.definition?.edges.find((edge) => edge.to.nodeId === current)?.from.nodeId;
    if (!source) return undefined;
    const fields = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === source)?.output?.fields;
    if (fields && Object.keys(fields).filter((key) => key !== "port").length > 0) return fields;
    current = source;
  }
  return undefined;
}

/** Decide the human gate a run is parked on. The default templates put an
 *  operator-only approval in front of the heavy model — this is where the
 *  operator (or an agent relaying the operator's explicit decision) answers.
 *  The gateway stamps who decided from the request itself (no caller header =
 *  operator), so the body carries only decision/reason/expectedRevision. */
export async function runWorkflowApprove(
  workflowId: string,
  runId: string,
  opts: { json?: boolean; node?: string; reject?: boolean; note?: string },
): Promise<void> {
  const run = await gateway("GET",
    `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}?view=full`) as RunDetailForApproval;
  const pending = run.approvals.filter((approval) => approval.status === "pending");
  let nodeId = opts.node;
  if (!nodeId) {
    if (pending.length === 0) fail(`run ${runId} に承認待ちのゲートはありません`);
    if (pending.length > 1) fail(`承認待ちが複数あります: ${pending.map((item) => item.nodeId).join(", ")}。--node で指定してください`);
    nodeId = pending[0]!.nodeId;
  }
  const context = approvalContext(run, nodeId);
  if (!opts.json && context) {
    console.log("判定係の報告（外部由来・未検証の内容です）:");
    for (const [key, value] of Object.entries(context)) {
      console.log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  const decision = opts.reject ? "reject" : "approve";
  const decided = await gateway("POST",
    `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
    { decision, expectedRevision: run.revision, ...(opts.note ? { reason: opts.note } : {}) }) as { status: string };
  emit(Boolean(opts.json), { workflowId, runId, nodeId, decision, runStatus: decided.status, ...(context ? { context } : {}) }, () => {
    console.log(`${nodeId} を${decision === "approve" ? "承認" : "却下"}しました（run: ${decided.status}）`);
  });
}

export async function runWorkflowList(opts: { json?: boolean }): Promise<void> {
  const items = await gatewayAllPages<WorkflowSummaryRow>("/api/workflows");
  emit(Boolean(opts.json), { workflows: items }, () => {
    for (const item of items) {
      console.log(`${item.enabled ? "ON " : "off"}  ${item.id} — ${item.title}${item.retiredAt ? "（退役）" : ""}`);
    }
    if (items.length === 0) console.log("workflow はまだありません。作成: ryoko workflow create --template <id> --name <id> --set k=v");
  });
}

/** Report and exit. In --json mode the error itself is machine-readable
 *  (stderr, single JSON object) so agents never have to parse prose — for
 *  unexpected errors too, with the stack preserved alongside. */
export function reportCliFailure(error: unknown, json = false): never {
  if (error instanceof CliFailure) {
    console.error(json ? JSON.stringify({ error: error.message }) : error.message);
    process.exit(1);
  }
  if (json) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(JSON.stringify({ error: message, unexpected: true, ...(stack ? { stack } : {}) }));
    process.exit(1);
  }
  throw error;
}
