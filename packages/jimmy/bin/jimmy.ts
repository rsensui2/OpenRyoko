#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program
  .name("ryoko")
  .description("OpenRyoko — Slackで空気を読んで働くAIゲートウェイ")
  .version(pkg.version)
  .option("-i, --instance <name>", "特定のインスタンスを対象にする（デフォルト: ryoko）");

// 任意のコマンド実行前に、指定インスタンスのホームディレクトリを環境変数に反映
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.instance) {
    process.env.RYOKO_INSTANCE = opts.instance;
    process.env.RYOKO_HOME = path.join(os.homedir(), `.${opts.instance}`);
  }
});

program
  .command("setup")
  .description("OpenRyokoを初期化し依存関係をインストールする")
  .option("--force", "既存のホームディレクトリを削除して最初から作り直す")
  .action(async (opts) => {
    const { runSetup } = await import("../src/cli/setup.js");
    await runSetup(opts);
  });

program
  .command("start")
  .description("ゲートウェイデーモンを起動する")
  .option("--daemon", "バックグラウンドで実行")
  .option("-p, --port <port>", "configのポートを上書き")
  .action(async (opts) => {
    const { runStart } = await import("../src/cli/start.js");
    await runStart({ daemon: opts.daemon, port: opts.port ? parseInt(opts.port, 10) : undefined });
  });

program
  .command("stop")
  .description("ゲートウェイデーモンを停止する")
  .option("-p, --port <port>", "プロセスをkillするポート（デフォルト: config or 7777）")
  .action(async (opts: { port?: string }) => {
    const { runStop } = await import("../src/cli/stop.js");
    await runStop(opts.port ? parseInt(opts.port, 10) : undefined);
  });

program
  .command("status")
  .description("ゲートウェイの状態を表示")
  .action(async () => {
    const { runStatus } = await import("../src/cli/status.js");
    await runStatus();
  });

program
  .command("pair")
  .description("リモートブラウザ用の単回ペアリングコードを発行する")
  .option("--json", "JSON形式で出力")
  .action(async (opts: { json?: boolean }) => {
    const { runPair } = await import("../src/cli/pair.js");
    await runPair(opts);
  });

{
  const automationCmd = program
    .command("automation")
    .description("自動化（cron + workflow）の統合操作");
  automationCmd
    .command("list")
    .description("cron と workflow をまとめて一覧する")
    .option("--json", "JSON形式で出力（AIエージェント向け）")
    .action(async (opts: { json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runAutomationList(opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  automationCmd
    .command("enable <id>")
    .description("自動化を有効にする（cron / workflow どちらでも）")
    .option("--kind <kind>", "cron / workflow（同名IDが両方にある時に指定）")
    .option("--json", "JSON形式で出力")
    .action(async (id: string, opts: { json?: boolean; kind?: string }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runAutomationToggle(id, true, opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  automationCmd
    .command("disable <id>")
    .description("自動化を無効にする（cron / workflow どちらでも）")
    .option("--kind <kind>", "cron / workflow（同名IDが両方にある時に指定）")
    .option("--json", "JSON形式で出力")
    .action(async (id: string, opts: { json?: boolean; kind?: string }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runAutomationToggle(id, false, opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });

  const workflowCmd = program
    .command("workflow")
    .description("workflow の作成・実行・履歴（テンプレ一覧: ryoko workflow templates）");
  workflowCmd
    .command("templates")
    .description("テンプレート一覧と変数（--set で渡すキー）を表示する")
    .option("--json", "JSON形式で出力")
    .action(async (opts: { json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowTemplates(opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  workflowCmd
    .command("list")
    .description("workflow の一覧")
    .option("--json", "JSON形式で出力")
    .action(async (opts: { json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowList(opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  workflowCmd
    .command("create")
    .description("テンプレートまたは JSON 定義から workflow を作る")
    .option("--template <id>", "テンプレートID（ryoko workflow templates で一覧）")
    .option("--file <path>", "JSON 定義ファイル（nodes/edges を含む）")
    .requiredOption("--name <id>", "workflow の ID（英数とハイフン）")
    .option("--title <title>", "表示タイトル（省略時は ID）")
    .option("--set <key=value...>", "テンプレート変数", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--enable", "作成後すぐ有効化する")
    .option("--json", "JSON形式で出力")
    .action(async (opts: { template?: string; file?: string; name: string; title?: string; set: string[]; enable?: boolean; json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowCreate(opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  workflowCmd
    .command("show <id>")
    .description("workflow の定義と状態を表示する")
    .option("--json", "JSON形式で出力")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowShow(id, opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  workflowCmd
    .command("run <id>")
    .description("workflow を今すぐ実行する")
    .option("--json", "JSON形式で出力")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowStart(id, opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  workflowCmd
    .command("approve <id> <runId>")
    .description("承認待ちの run を承認する（--reject で却下）")
    .option("--node <nodeId>", "承認ノードID（承認待ちが複数ある時に指定）")
    .option("--reject", "却下する")
    .option("--note <note>", "決定のメモ")
    .option("--json", "JSON形式で出力")
    .action(async (id: string, runId: string, opts: { json?: boolean; node?: string; reject?: boolean; note?: string }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowApprove(id, runId, opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
  workflowCmd
    .command("runs <id>")
    .description("workflow の実行履歴を表示する")
    .option("--json", "JSON形式で出力")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cli = await import("../src/cli/automation.js");
      await cli.runWorkflowRuns(id, opts).catch((e) => cli.reportCliFailure(e, opts.json));
    });
}

program
  .command("api <method> <path>")
  .description("認証付きでこのインスタンスのGateway APIを呼び出す")
  .option("-d, --data <json>", "JSONリクエスト本文（POST/PUT/PATCH/DELETE用）")
  .action(async (method: string, apiPath: string, opts: { data?: string }) => {
    const { runApi } = await import("../src/cli/api.js");
    await runApi({ method, path: apiPath, data: opts.data });
  });

program
  .command("create <name>")
  .description("新しいOpenRyokoインスタンスを作成する")
  .option("-p, --port <port>", "ゲートウェイのポート（省略時は自動割当）")
  .action(async (name: string, opts: { port?: string }) => {
    const { runCreate } = await import("../src/cli/create.js");
    await runCreate(name, opts.port ? parseInt(opts.port, 10) : undefined);
  });

program
  .command("list")
  .description("すべてのOpenRyokoインスタンスを一覧表示")
  .action(async () => {
    const { runList } = await import("../src/cli/list.js");
    await runList();
  });

program
  .command("remove <name>")
  .description("OpenRyokoインスタンスをレジストリから除外する")
  .option("--force", "インスタンスのホームディレクトリも削除する")
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import("../src/cli/remove.js");
    await runRemove(name, opts);
  });

program
  .command("nuke [name]")
  .description("OpenRyokoインスタンスと全データを完全に削除する")
  .action(async (name?: string) => {
    const { runNuke } = await import("../src/cli/nuke.js");
    await runNuke(name);
  });

program
  .command("update")
  .description("OpenRyoko CLIを最新版に更新し、インスタンス移行を適用する")
  .option("--no-migrate", "CLI更新後の ryoko migrate --auto をスキップする")
  .option("--restart", "更新後にゲートウェイを再起動する（systemd → デーモンの順に検出）")
  .option("--service <name>", "再起動する systemd ユニット名（既定: openryoko / 環境変数 RYOKO_SERVICE）")
  .action(async (opts) => {
    const { runUpdate } = await import("../src/cli/update.js");
    await runUpdate(opts);
  });

program
  .command("migrate")
  .description("未適用のテンプレート・マイグレーションを適用する")
  .option("--check", "未適用のマイグレーションをチェックのみ（適用はしない）")
  .option("--auto", "安全な変更のみをAI起動なしで自動適用")
  .option("--fix", "旧gateway URLをバックアップ後に安全なloopback URLへ置換")
  .action(async (opts) => {
    const { runMigrate } = await import("../src/cli/migrate.js");
    await runMigrate(opts);
  });

// Skillsサブコマンド（ryoko skills find|add|remove|list|update|restore）
{
  const skillsCmd = program
    .command("skills")
    .description("skills.shレジストリのスキルを管理する");

  skillsCmd
    .command("find [query]")
    .description("skills.shレジストリを検索する")
    .action(async (query?: string) => {
      const { skillsFind } = await import("../src/cli/skills.js");
      skillsFind(query);
    });

  skillsCmd
    .command("add <package>")
    .description("skills.shからスキルをインストール")
    .action(async (pkg: string) => {
      const { skillsAdd } = await import("../src/cli/skills.js");
      skillsAdd(pkg);
    });

  skillsCmd
    .command("remove <name>")
    .description("このインスタンスからスキルを削除")
    .action(async (name: string) => {
      const { skillsRemove } = await import("../src/cli/skills.js");
      skillsRemove(name);
    });

  skillsCmd
    .command("list")
    .description("インストール済みスキルを一覧表示")
    .action(async () => {
      const { skillsList } = await import("../src/cli/skills.js");
      skillsList();
    });

  skillsCmd
    .command("update")
    .description("全スキルを最新版で再インストール")
    .action(async () => {
      const { skillsUpdate } = await import("../src/cli/skills.js");
      skillsUpdate();
    });

  skillsCmd
    .command("restore")
    .description("skills.jsonに記載された全スキルをインストール")
    .action(async () => {
      const { skillsRestore } = await import("../src/cli/skills.js");
      skillsRestore();
    });
}

// Configサブコマンド（ryoko config interactive [on|off]）
{
  const configCmd = program
    .command("config")
    .description("config.yaml の設定を確認・変更する");

  configCmd
    .command("interactive [value]")
    .description("Claude のインタラクティブPTY（Max定額課金）の on/off。値なしで現在値を表示")
    .action(async (value?: string) => {
      const { runConfigInteractive } = await import("../src/cli/config.js");
      await runConfigInteractive(value);
    });
}

// 切り離しジョブ（ryoko job run / list — 完了時にセッションを自動起床）
{
  const jobCmd = program
    .command("job")
    .description("切り離しバックグラウンドジョブ（完了時に元セッションを自動起床）");

  jobCmd
    .command("run")
    .description("コマンドを切り離して実行し、終了時（成功/失敗とも）にセッションへ通知する")
    .requiredOption("--name <name>", "ジョブ名（通知・ログの識別子）")
    .requiredOption("--session <id>", "終了時に起こすセッションID")
    .option("--timeout <sec>", "この秒数を超えたらジョブをkillして失敗通知する")
    .option("--log <path>", "ログファイルのパス（省略時は ~/.ryoko/jobs/logs/<id>.log）")
    .option("--gateway <url>", "gateway URL（loopbackのみ許可。省略時はconfigのポート）")
    .argument("<command...>", "実行するシェルコマンド。クォートした1つの文字列で渡すこと（例: -- 'cd /x && make'）")
    .action(async (commandParts: string[], opts: { name: string; session: string; timeout?: string; log?: string; gateway?: string }) => {
      let timeoutSec: number | undefined;
      if (opts.timeout !== undefined) {
        timeoutSec = Number(opts.timeout);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
          console.error(`--timeout must be a positive number of seconds (got "${opts.timeout}")`);
          process.exit(1);
        }
      }
      const { launchDetachedJob } = await import("../src/jobs/run.js");
      const state = launchDetachedJob({
        name: opts.name,
        sessionId: opts.session,
        command: commandParts.join(" "),
        gatewayUrl: opts.gateway,
        logFile: opts.log,
        timeoutSec,
      });
      console.log(`Detached job started: ${state.id}`);
      console.log(`  log:     ${state.logFile}`);
      console.log(`  monitor: pid ${state.monitorPid}`);
      console.log(`  wakes:   session ${state.sessionId} on exit (success or failure)`);
      console.log(`This turn can end now — the job survives it and will wake the session when done.`);
    });

  jobCmd
    .command("list")
    .description("ジョブの状態を一覧表示する")
    .action(async () => {
      const { listJobStates, isPidAlive } = await import("../src/jobs/state.js");
      const states = listJobStates();
      if (states.length === 0) {
        console.log("No jobs.");
        return;
      }
      for (const s of states) {
        const orphaned = s.status === "running" && !isPidAlive(s.monitorPid) ? " (ORPHANED — monitor dead)" : "";
        const exit = s.exitCode !== undefined && s.exitCode !== null ? ` exit=${s.exitCode}` : s.timedOut ? " timed-out" : "";
        console.log(`${s.id}  [${s.status}${orphaned}]${exit}  session=${s.sessionId}  log=${s.logFile}`);
      }
    });

  jobCmd
    .command("_monitor <id>", { hidden: true })
    .description("内部用: 切り離しモニタープロセスの本体")
    .option("--jobs-dir <dir>")
    .action(async (id: string, opts: { jobsDir?: string }) => {
      const { runJobMonitor } = await import("../src/jobs/monitor.js");
      await runJobMonitor(id, { jobsDir: opts.jobsDir });
    });
}

program
  .command("chrome-allow")
  .description("Claude Chrome拡張で全サイトを事前承認する")
  .option("--no-restart", "Chromeを自動再起動しない")
  .option("--comet-browser", "Google ChromeではなくCometブラウザを対象にする")
  .action(async (opts) => {
    const { runChromeAllow } = await import("../src/cli/chrome-allow.js");
    await runChromeAllow(opts);
  });

program.parse();
