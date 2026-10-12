import fs from "node:fs";
import { JINN_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { startForeground, startDaemon } from "../gateway/lifecycle.js";
import { installProcessSafetyNet } from "../shared/process-safety-net.js";
import { compareSemver, getPackageVersion, getInstanceVersion } from "../shared/version.js";
import { syncBundledSkillsOnBoot } from "../skills-sync/instance.js";

const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runStart(opts: { daemon?: boolean; port?: number }): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.error(
      `エラー: ${JINN_HOME} が存在しません。まず "ryoko setup" を実行してください。`
    );
    process.exit(1);
  }

  const config = loadConfig();

  // 未適用のマイグレーションがあるかチェック
  const instanceVersion = getInstanceVersion();
  const pkgVersion = getPackageVersion();
  if (compareSemver(instanceVersion, pkgVersion) < 0) {
    console.log(
      `${YELLOW}[migrate]${RESET} インスタンスは v${instanceVersion}、CLIは v${pkgVersion} です。${DIM}ryoko migrate${RESET} で更新してください。`
    );
  }

  // このプロセス自身がゲートウェイになる（Docker / systemd の起動経路）ときは、
  // ここから先で何が起きても落ちないよう、同梱スキルの同期より前に安全網を入れる。
  // daemon を fork するだけの CLI プロセスには入れない。
  if (!opts.daemon) installProcessSafetyNet();

  // 同梱スキルを同期（foreground / daemon 共通。失敗しても起動は続ける）
  syncBundledSkillsOnBoot(config);

  // CLIの --port で config を上書き
  if (opts.port) {
    config.gateway.port = opts.port;
  }

  if (opts.daemon) {
    startDaemon(config);
    console.log("ゲートウェイをバックグラウンドで起動しました。");
  } else {
    console.log(
      `ゲートウェイを ${config.gateway.host}:${config.gateway.port} で起動中...`
    );
    try {
      await startForeground(config);
    } catch (err) {
      // 安全網は未処理の rejection でもプロセスを生かすので、起動の失敗は
      // ここで明示的に終了させる（放置すると半端な状態で残り続ける）。
      console.error("ゲートウェイの起動に失敗しました:", err);
      process.exit(1);
    }
  }
}
