# OpenRyoko

Slackで会話し、Claude Code・Codex・Gemini CLIに仕事をつなぐ、常駐AIアシスタントです。Node.js 22以上と、利用するCLIの導入・ログインが必要です。

```bash
npm install -g openryoko
ryoko setup
ryoko start
```

ブラウザで http://127.0.0.1:7777 を開きます。設定画面でエンジンとSlackを接続してください。

モデル設定画面では、Codex・Claude CLIからモデル一覧を取得し、自動追従・通知して選ぶ・固定を選べます。Slackの管理者用設定カード、社員・定期ジョブの固定設定一覧も利用できます。既存会話と明示した固定設定は維持します。

[導入・使い方・更新方法](https://github.com/rsensui2/OpenRyoko#readme) · [リリース](https://github.com/rsensui2/OpenRyoko/releases) · [不具合報告](https://github.com/rsensui2/OpenRyoko/issues)

MIT License。Jinnを基盤に開発しています。
