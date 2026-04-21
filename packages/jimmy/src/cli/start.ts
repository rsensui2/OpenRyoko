import fs from "node:fs";
import { JINN_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { startForeground, startDaemon } from "../gateway/lifecycle.js";
import { compareSemver, getPackageVersion, getInstanceVersion } from "../shared/version.js";

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
    await startForeground(config);
  }
}
