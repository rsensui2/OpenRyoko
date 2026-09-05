import { getStatus } from "../gateway/lifecycle.js";
import { loadConfig } from "../shared/config.js";
import { gatewayUrlFromConfig } from "../shared/gateway-url.js";
import { JINN_HOME, PID_FILE } from "../shared/paths.js";
import fs from "node:fs";
import { readGatewayAuthToken } from "../gateway/auth.js";

export async function runStatus(): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.log("ゲートウェイはセットアップされていません。まず \"ryoko setup\" を実行してください。");
    return;
  }

  const status = getStatus();

  if (!status.running) {
    console.log("ゲートウェイ: 停止中");
    if (status.pid) {
      console.log(`  古いPIDファイルが残っています（PID ${status.pid}）。プロセスは生存していません。`);
    }
    return;
  }

  console.log("ゲートウェイ: 稼働中");
  console.log(`  PID: ${status.pid}`);

  // PIDファイルのmtimeから稼働時間を算出
  try {
    const stat = fs.statSync(PID_FILE);
    const uptimeMs = Date.now() - stat.mtimeMs;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    console.log(`  稼働時間: ${hours}時間 ${minutes}分 ${seconds}秒`);
  } catch {
    // ignore
  }

  // ゲートウェイからライブ統計を取得
  try {
    const config = loadConfig();
    const url = `${gatewayUrlFromConfig(config)}/api/status`;
    const token = readGatewayAuthToken(JINN_HOME);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`  ポート: ${config.gateway.port}`);
      if (data.sessions !== undefined) {
        if (typeof data.sessions === "object" && data.sessions && !Array.isArray(data.sessions)) {
          const s = data.sessions as { total?: number; active?: number; running?: number };
          const total = s.total ?? 0;
          const active = s.active ?? 0;
          const running = s.running ?? 0;
          console.log(`  アクティブセッション: ${active}（実行中: ${running}、合計: ${total}）`);
        } else {
          console.log(`  アクティブセッション: ${data.sessions}`);
        }
      }
      if (data.uptime !== undefined) {
        console.log(`  サーバー稼働時間: ${data.uptime}秒`);
      }
    } else {
      let detail = "";
      try {
        const payload = await res.json() as { error?: unknown; hint?: unknown };
        const message = typeof payload.hint === "string" ? payload.hint : payload.error;
        if (typeof message === "string") detail = `: ${message}`;
      } catch { /* non-JSON error body */ }
      console.log(`  ポート: ${config.gateway.port}（HTTP ${res.status}${detail}）`);
    }
  } catch (error) {
    try {
      const config = loadConfig();
      const reason = error instanceof Error ? `: ${error.message}` : "";
      console.log(`  ポート: ${config.gateway.port}（HTTPに応答なし${reason}）`);
    } catch {
      // no config
    }
  }
}
