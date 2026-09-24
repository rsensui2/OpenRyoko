# OpenRyoko

Slackで会話し、Claude Code・Codex・Gemini CLIに仕事をつなぐ、常駐AIアシスタントです。Node.js 22以上と、利用するCLIの導入・ログインが必要です。

```bash
npm install -g openryoko
ryoko setup
ryoko start
```

ブラウザで http://127.0.0.1:7777 を開きます。設定画面でエンジンとSlackを接続してください。

モデル設定画面では、Sol・Terra・Opusなどの系列、考える深さ、使えない時の代役を選べます。系列の最新版への追従は社員・定期ジョブ・ワークフローにも設定でき、Slackの管理者用カードからも変更できます。設定を変えるまで既存の固定指定は維持します。

[導入・使い方・更新方法](https://github.com/rsensui2/OpenRyoko#readme) · [リリース](https://github.com/rsensui2/OpenRyoko/releases) · [不具合報告](https://github.com/rsensui2/OpenRyoko/issues)

MIT License。Jinnを基盤に開発しています。
