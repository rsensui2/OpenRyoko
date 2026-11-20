# Slack を画面からつなぐ

設定画面の「Slack につなぐ」（`/connect/slack`）は、次の 4 つの手順で Slack アプリの作成から接続までを行います。

1. Slack での名前とアイコンを決める
2. Slack の「設定トークン」（App Configuration Token の Refresh Token、`xoxe-…`）を貼る。gateway がそのトークンで Slack アプリを作り（`apps.manifest.create`）、アイコンを設定する（`apps.icon.set`）
3. Slack で「許可する」を押す。Slack から戻ると、gateway が Bot Token を受け取る（`oauth.v2.access`）
4. App-Level Token（`xapp-…`、スコープ `connections:write`）を作って貼る。Slack にはこのトークンを作る API がないため、ここだけは手で作る

設定の途中（App-Level Token を貼る前）でやり直したときは、新しいアプリは作らず同じアプリを更新する。接続まで済んだあとにもう一度設定すると、新しいアプリを作る（接続が済んだ時点でクライアントシークレットを消すため。Slack にはこれを取り直す API がない）。

## トークンの扱い

- 設定トークンは使うたびに Slack が新しいものに替える（`tooling.tokens.rotate`）。gateway はアプリを作り終えた時点で、設定トークンを `~/.ryoko/slack-app.json`（権限 0600）から消す。アプリ作成に失敗したときだけ、貼り直さずにやり直せるよう最新のものを残す。そのため、設定をやり直すときは新しい設定トークンを貼る
- 接続が済んだら（手でトークンを入力した場合も）、client secret・Bot Token の控えもこのファイルから消す。残るのはアプリ ID・名前・ワークスペース ID と名前だけ
- 設定トークンは、本人が共同編集者になっているすべての Slack アプリを編集できる強い権限を持つ。接続が済んだら、Slack のアプリ管理画面（Your App Configuration Tokens）で削除してかまわない

## 「許可する」のあと自動で戻る仕組み

Slack は「許可する」のあとの戻り先に https の URL しか受け付けない（`localhost` も不可）。gateway を https で開いている場合は、gateway 自身の `/api/onboarding/slack/oauth/callback` を戻り先にする。

http で開いている場合（`http://127.0.0.1:7777` など）は、静的な中継ページ `https://rsensui2.github.io/OpenRyoko/slack/callback/`（ソースは [`site/slack/callback/`](../site/slack/callback/)）を戻り先にする。

- gateway は戻り先のアドレス（画面を開いているブラウザから見た gateway の origin）を OAuth の `state` に入れる。Slack は `state` をそのまま返す
- 中継ページは `state` からアドレスを読み、`code`・`state`・`error` だけをそのアドレスの callback に転送する。サーバーはなく、何も保存・送信しない。Referrer は送らない
- 自動で転送するのは、`localhost` と、ループバック・プライベート・Tailscale（100.64.0.0/10）の IP アドレスに限る。ホスト名（`*.ts.net` や `*.local` を含む）は誰でも用意できるので、転送先を表示して確認のクリックを求める
- `error`（「キャンセル」など）も、gateway が発行した `state` と一致したときだけ受け付け、表示する文言は固定にしている。URL の文字列をそのまま画面に出すことはない
- 中継ページの URL（`code`・`state`・gateway のアドレス）は、ブラウザの履歴や GitHub Pages のアクセスログに残りうる。`code` は単独では使えず、`state` も 1 回で無効になる
- `code` は client secret がないと Bot Token に交換できず、client secret は gateway の外に出ない。`state` は 1 回限り・30 分で失効し、gateway が発行したものと一致しなければ受け付けない

中継ページを使いたくない場合は、gateway を https で開く（例: Tailscale の `tailscale serve`）か、環境変数 `OPENRYOKO_SLACK_OAUTH_RELAY` に自分で置いた中継ページの https URL を指定する。どちらもできない場合は、画面の「Bot Token を貼る」から手順 3 を手作業で行える。

## チャンネルごとの振る舞い

「Slack での振る舞い」（`/connect/slack/behavior`）で、DM・チャンネル・グループ DM ごとの返事の仕方と、チャンネルごとの例外を決める。設定は `connectors.slack.respondTo` に保存される。

```yaml
connectors:
  slack:
    respondTo:
      im: always
      mpim: mention
      channel: mention
      engagedThreads: true
      channels:
        C0123456789: always   # このチャンネルではすべてに返事（空気読みも通さない）
        C0987654321: never    # このチャンネルでは話さない
```

`channels` の例外は 1 対 1 の DM には効かない。`always` にしたチャンネルでは空気読みを通さないので、そのチャンネルの全員が bot に作業を頼める。`allowFrom`（許可する利用者）は、例外があっても先に効く。
