import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Connector, CronJob, JinnConfig, Target } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import { getSession, getSessionBySessionKey } from "../sessions/registry.js";
import { JINN_HOME } from "../shared/paths.js";
import { redactText } from "../shared/redact.js";
import { CronConnector } from "../connectors/cron/index.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { buildMaintenancePrompt, inspectMaintenance, validMaintenanceMode, type MaintenanceMode } from "./maintenance-audit.js";

interface Receipt {
  version: string;
  fingerprints: string[];
  mode: MaintenanceMode;
  status: "running" | "ready" | "notified";
  outcome?: "completed" | "failed" | "interrupted";
  report?: string;
  sessionId?: string;
  sessionKey?: string;
  updatedAt: string;
}
const running = new Set<string>();
const receiptDir = path.join(JINN_HOME, "updates", "maintenance");
function receiptPath(jobId: string): string {
  return path.join(receiptDir, createHash("sha256").update(jobId).digest("hex") + ".json");
}
function readReceipt(jobId: string): Receipt | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(receiptPath(jobId), "utf8"));
    if (!data || !["running", "ready", "notified"].includes(data.status) || !Array.isArray(data.fingerprints)
      || !data.fingerprints.every((item: unknown) => typeof item === "string") || !validMaintenanceMode(data.mode)
      || typeof data.version !== "string" || (data.status !== "running" && typeof data.report !== "string")) throw new Error();
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Do not silently forget a possibly executed write and run it again.
    throw new Error("点検履歴を読み取れません。updates/maintenanceを確認してから再実行してください。");
  }
}
function writeReceipt(jobId: string, receipt: Receipt): void {
  fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = receiptPath(jobId);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
}

/** Buffer agent output until the session has a successful terminal state.
 * A delivery retry reuses this receipt, never re-runs configuration edits. */
class MaintenanceConnector extends CronConnector {
  report = "";
  constructor() { super(new Map()); }
  override async sendMessage(_target: Target, text: string): Promise<void> {
    this.report = (this.report + "\n\n" + redactText(text)).slice(-12000);
  }
  override async replyMessage(target: Target, text: string): Promise<void> { await this.sendMessage(target, text); }
}

export interface MaintenanceRunResult {
  status: "skipped" | "notified";
  reason?: string;
  outcome?: Receipt["outcome"];
  sessionId?: string;
}

export async function runUpdateMaintenance(
  job: CronJob, manager: SessionManager, config: JinnConfig, connectors: Map<string, Connector>,
  options: { mode?: MaintenanceMode; force?: boolean } = {},
): Promise<MaintenanceRunResult> {
  const mode = options.mode ?? job.maintenance?.mode ?? "review";
  if (!validMaintenanceMode(mode)) throw new Error("Invalid maintenance mode");
  if (mode === "off") return { status: "skipped", reason: "disabled" };
  const delivery = job.delivery ?? config.cron?.defaultDelivery;
  const target = delivery && connectors.get(delivery.connector);
  if (!delivery?.channel || !target) return { status: "skipped", reason: "delivery-unavailable" };
  // Serialize maintenance across notification jobs in the same instance. An AI
  // rewrite must not race another job's inspection/application.
  if (running.size) return { status: "skipped", reason: "already-running" };
  running.add(job.id);
  try {
    let receipt = readReceipt(job.id);
    const previousSession = receipt?.sessionId ? getSession(receipt.sessionId)
      : receipt?.sessionKey ? getSessionBySessionKey(receipt.sessionKey) : undefined;
    if (previousSession && ["running", "waiting"].includes(previousSession.status)) {
      return { status: "skipped", reason: "session-still-active", sessionId: previousSession.id };
    }
    const deliver = async (record: Receipt): Promise<MaintenanceRunResult> => {
      await target.sendMessage({ channel: delivery.channel }, record.report!);
      writeReceipt(job.id, { ...record, status: "notified", updatedAt: new Date().toISOString() });
      return { status: "notified", outcome: record.outcome, sessionId: record.sessionId };
    };
    // Finish pending delivery before inspecting another version or mode.
    if (receipt?.status === "ready") return deliver(receipt);
    if (receipt?.status === "running") {
      receipt = { ...receipt, status: "ready", outcome: "interrupted",
        report: "OpenRyokoの運用点検が途中で中断しました。設定変更の有無を確認してから、設定画面の「点検を実行」で再点検してください。自動で修正をやり直してはいません。",
        updatedAt: new Date().toISOString() };
      writeReceipt(job.id, receipt);
      return deliver(receipt);
    }
    if (!options.force && mode === "apply" && receipt && receipt.outcome !== "completed") {
      return { status: "skipped", reason: "previous-attempt-needs-review" };
    }
    const audit = inspectMaintenance(config);
    if (!options.force && receipt?.mode === mode && receipt.fingerprints.includes(audit.fingerprint)) {
      return { status: "skipped", reason: "already-reviewed" };
    }
    if (audit.findings.length === 0) {
      if (!options.force) return { status: "skipped", reason: "no-findings" };
      receipt = { version: audit.version, mode, fingerprints: [audit.fingerprint],
        status: "ready", outcome: "completed", updatedAt: new Date().toISOString(),
        report: `OpenRyoko ${audit.version} の運用点検が完了しました。コードによる点検では改善候補はありませんでした。AIは起動せず、設定も変更していません。` };
      writeReceipt(job.id, receipt);
      return deliver(receipt);
    }
    const sessionKey = `maintenance:${job.id}:${randomUUID()}`;
    receipt = { version: audit.version, mode, sessionKey, fingerprints: [audit.fingerprint], status: "running", updatedAt: new Date().toISOString() };
    writeReceipt(job.id, receipt); // persisted BEFORE any agent can change files
    const buffer = new MaintenanceConnector();
    const employee = job.employee ? findEmployee(job.employee, scanOrg()) : undefined;
    try {
      const routed = await manager.route({
        connector: "cron", source: "cron", sessionKey,
        replyContext: { channel: job.id, cronJobId: job.id },
        channel: job.id, user: "system", userId: "system", attachments: [],
        text: buildMaintenancePrompt(audit, mode), raw: { trigger: "update-maintenance" },
        transportMeta: { maintenanceJobId: job.id, maintenanceMode: mode },
      }, buffer, {
        employee, engine: job.engine || employee?.engine || config.engines.default,
        model: job.model || employee?.model, title: `OpenRyoko運用点検 (${mode})`,
      });
      const session = routed && getSession(routed.sessionId);
      if (routed) receipt.sessionId = routed.sessionId;
      if (!session || session.status !== "idle" || session.lastError || !buffer.report.trim()) {
        throw new Error("点検セッションの正常完了を確認できませんでした。");
      }
      // Remember both states: edits performed by this run must not immediately
      // trigger the same maintenance again on the next scheduled check.
      const after = inspectMaintenance(config);
      receipt = { ...receipt, status: "ready", outcome: "completed", sessionId: session.id,
        fingerprints: [...new Set([audit.fingerprint, after.fingerprint])],
        report: `OpenRyoko ${audit.version} 運用点検（${mode === "apply" ? "自動修正あり" : "点検・改善案"}）\n${buffer.report.trim()}`,
        updatedAt: new Date().toISOString() };
    } catch {
      receipt = { ...receipt, status: "ready", outcome: "failed",
        report: `OpenRyoko ${audit.version} の運用点検を完了できませんでした。点検セッションを確認してください。変更が途中まで行われた可能性があるため、自動再実行はせず、設定画面の「点検を実行」から再点検できます。`,
        updatedAt: new Date().toISOString() };
    }
    writeReceipt(job.id, receipt);
    return deliver(receipt);
  } finally { running.delete(job.id); }
}
