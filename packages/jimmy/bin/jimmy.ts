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
  .command("migrate")
  .description("未適用のテンプレート・マイグレーションを適用する")
  .option("--check", "未適用のマイグレーションをチェックのみ（適用はしない）")
  .option("--auto", "安全な変更のみをAI起動なしで自動適用")
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
