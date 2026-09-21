import { requestGatewayApi } from "./api.js";
import type { MaintenanceAudit } from "../updates/maintenance-audit.js";

export async function runMaintenanceInspect(opts: { json?: boolean }): Promise<void> {
  const response = await requestGatewayApi({ method: "GET", path: "/api/maintenance" });
  if (!response.ok) throw new Error(`運用点検に失敗しました (HTTP ${response.status})`);
  if (opts.json) { console.log(response.body); return; }
  const audit = JSON.parse(response.body) as MaintenanceAudit;
  console.log(`OpenRyoko ${audit.version}: AIなしの運用点検`);
  console.log(`有効なprompt Cron: ${audit.inventory.enabledPromptJobs} / command: ${audit.inventory.commandJobs}`);
  for (const finding of audit.findings) console.log(`- ${finding.title} (${finding.count}件): ${finding.detail}`);
  if (!audit.findings.length) console.log("改善候補はありません。");
}

export async function runMaintenanceReview(jobId: string, opts: { apply?: boolean; json?: boolean }): Promise<void> {
  const response = await requestGatewayApi({ method: "POST", path: "/api/maintenance/run",
    data: JSON.stringify({ jobId, mode: opts.apply ? "apply" : "review" }) });
  if (!response.ok) throw new Error(`運用点検の開始に失敗しました (HTTP ${response.status})`);
  console.log(opts.json ? response.body : "運用点検を開始しました。結果は指定した更新通知ジョブの送信先へ届きます。");
}
