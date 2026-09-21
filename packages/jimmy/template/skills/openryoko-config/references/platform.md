# 設定項目とプラットフォームの仕組み

## 実行の流れ

Web／Slack／Discord等のコネクタ → 応答対象・空気読みの判定 → セッション／キュー → Claude Code・Codex・GeminiのCLI → 結果の保存・元の会話への配送、が基本経路。社員は役割・作業先・使用エンジン等の設定を持つ。cronは定期的に処理を開始し、workflowは段階・試行・成果物を管理する別の実行系。スキルはCLIが読む手順書であり、インストールだけで外部サービスの認証や利用権限は付かない。

## 対象の座標

ホーム解決は `RYOKO_HOME` → `JINN_HOME`（旧名）→ `RYOKO_INSTANCE` / `JINN_INSTANCE` の `~/.<name>` → `~/.ryoko`（旧環境は `~/.jinn`）。CLIの `-i <name>` は `RYOKO_HOME` も `~/.<name>` に設定するため、独自パスと混用しない。

以下は名前付きインスタンスの例。`<name>` は確認した実名に置き換える。独自ホームでは `-i` を外し、対象の `RYOKO_HOME` を指定する。コンテナならその中のCLIから実行する。

```sh
ryoko -i <name> --version
ryoko -i <name> api GET /api/status
ryoko -i <name> api GET /api/config
ryoko -i <name> api GET /api/onboarding/engines
ryoko -i <name> api GET /api/connectors
```

`/api/status` の `available: true` は版によって固定値。実行可能性の保証にせず、`/api/onboarding/engines` と同じ実行ユーザー／コンテナでのCLI・認証を確認する。APIが404ならその版にあるCLI／ローカル実装へ戻る。401なら対象と認証経路を確認し、認証を無効化しない。

`gateway.host` は待受アドレス。`0.0.0.0` や `::` を接続先に使わない。通常は `ryoko api` に接続・認証を任せる。ポート転送環境ではホスト側ポートとコンテナ内ポートを区別する。`gateway.json` は内部hook用の秘密を含むので丸ごと表示しない。

## 設定をどこで変えるか

以下は探索用の地図。個別キーの型・既定値・対応範囲は対象パッケージの `shared/types` と実際の利用箇所で確定する。

| 希望する動作 | 主な設定／保存先 | 判断に必要な点 |
|---|---|---|
| 通常使うAI・モデルを変える | `config.yaml` の `engines.default`、`engines.<engine>.bin/model/effortLevel` | 既存セッション・社員・cronの明示指定が残る。新規と既存を分けて確認 |
| モデル候補・対応effortを登録 | `models.<engine>.default/models/effortMechanism` | レジストリは選択肢と能力宣言。実行既定の `engines.<engine>.model` と整合させる。課金・利用権限は付かない |
| 子セッションの思考量を揃える | `engines.<engine>.childEffortOverride` | 子ではoverride → セッション → 社員 → エンジン既定。モデルの対応値で検証する |
| ClaudeをPTYで動かす | `engines.claude.interactive/maxLivePtys/interactiveTurnTimeoutMs` | 構築時設定なので再起動。SSH社員はheadless経路。課金条件はCLI・契約の実態を確認 |
| 停滞時に別AIへ引き継ぐ | `engines.<engine>.fallback/fallbackModelMap`、`sessions.*` | [実行エンジン](engine-fallback.md)の版判定が先 |
| 新着メッセージで割込む | `sessions.interruptOnNewMessage` | `true`でも実行エンジンのinterrupt対応に依存。待機キューとstopの経路も確認 |
| 一時障害の再試行・遅れて届く出力 | `sessions.transientRetryDelaysMs/backgroundDelivery` | 同じエンジンでの再試行と別エンジンへの移行は別機構 |
| Slack／Discord等を接続 | `connectors.slack/discord/telegram/whatsapp`、`connectors.instances[]` | トップレベルと名前付き接続を取り違えない。インスタンス要素は `id/type/employee/config` |
| どの会話に応答するか | `connectors.slack.respondTo`、`allowFrom`、`triage` | Slackは `im/mpim/channel: always/mention/never`、`engagedThreads`。Jevより前の入口で除外された会話をJevで救済できない |
| Discordの応答範囲・表示 | `connectors.discord.respondTo/replyStyle` | DiscordのDMキーは `dm`。Slackの `im` と混用しない。`replyStyle` の値はその版の型を確認 |
| 別gatewayへ接続・転送 | `remotes`、Discordの `proxyVia/proxyViaToken/channelRouting` | 一覧上のリモート登録と実際の配送設定は別。接続元・接続先双方の認証を保持 |
| 空気読みをJevにする | Slackの `triage.backend/jev` | [Jev](jev.md)を読む。回答用 `engines.default` をJevにしない |
| 名前・話し方・本人確認 | `portal.*`、`IDENTITY.md`、`SOUL.md` | `portalName/operatorName/operatorAliases/language`。本人確認は `operatorSlackId/operatorDiscordId` |
| 信頼する相手に記憶を共有 | `portal.trustedSpeakers`、`MEMORY.md` | オペレータIDと記憶共有の許可は別。共有チャンネルではMEMORYを注入しない。Discord IDは文字列で保持 |
| 社員・階層・作業場所・SSH | `org/<department>/*.yaml`、`department.yaml`、`board.json` | `management`を参照。engine/model、cwd、sshHost、remoteCwd、reportsTo等は社員ごと |
| 定期実行・配送 | `cron/jobs.json`、`cron.defaultDelivery/alertConnector/alertChannel` | `cron-manager`を参照。jobのengine/model/employee/deliveryが個別に効く。`kind: command` とjobのeffortは対応版のみ |
| 段階的な自動処理 | `workflows.enabled`、`workflows.delivery.remote/branch` | opt-in。定義・実行データは `workflows/`。有効化は再起動が必要。`docs/automations.md`を参照 |
| 外部ツール | `mcp.browser/search/fetch/gateway/custom`、社員のMCP設定 | `docs/mcp.md`を参照。Claudeへの注入とCodex/Gemini側の設定を同じとみなさない |
| 文脈量・過去の会話 | `context.maxChars/crossSessionWindowHours/crossSessionLimit` | system prompt構築時の設定。CLI自体のcontext windowとは別 |
| 音声認識 | `stt.enabled/model/languages` | 旧 `language` より `languages`。モデルファイル・実行環境も確認 |
| 運用通知・ログ | `notifications.connector/channel`、`logging.file/stdout/level` | cronの配送先とは別。ログ出力初期化の反映時点は実装を確認 |
| ネットワーク公開・プロキシ | `gateway.port/host/allowedHosts/trustProxyHeaders/trustedProxyAddresses` | ポート／host変更は再起動。信頼プロキシは実接続元を明示。利便性のために認証解除しない |
| スキルの追加 | `skills/<name>/SKILL.md` と付属ファイル | `.claude/skills`・`.agents/skills`へ同期。元の `skills/` を編集する |

`sessions.maxDurationMinutes/maxCostUsd` は現行mainでは予約キーであり制限として使われていない。支出上限や強制終了が効くと案内しない。他のキーも `rg` で参照先が型・テンプレートだけなら未対応として扱う。

## 保存と反映の確認

機密を含まない部分更新の例（希望する既定エンジンを確認してから）：

```sh
ryoko -i <name> api PUT /api/config --data '{"engines":{"default":"codex"}}'
ryoko -i <name> api GET /api/config
ryoko -i <name> api GET '/api/logs?n=30'
```

`PUT /api/config` はオブジェクトをdeep mergeするが、完全なスキーマ検証とは限らない。配列の置換、`null`、未対応のネストしたキーに注意する。秘密は設定UIまたは秘密を表示しない保管経路から設定し、コマンド引数やチャットに値を書かない。

| 変更 | 反映の扱い |
|---|---|
| エンジン既定・モデル・portal・通常のsession/context設定 | watcherが設定を再読込。次の対象ターン／新規セッションで確認。実行中CLIへ即時反映とは限らない |
| コネクタ・Jev設定 | APIまたはwatcherがコネクタを再接続。`status: partial`、`connectorsReload.errors`、`connectorsReloadError` があれば未完了。必要時 `POST /api/connectors/reload` |
| gateway.port/host、Claude PTYの構築設定、起動時の環境変数 | 再起動／コンテナ再作成が必要。`GET /api/config`やstatusが新値でも実プロセスが変わった証拠にはならない |
| workflow有効化 | 再起動。無効化はreloadで停止する実装がある |
| cron・org・skills | 各watcherで更新。cronを開始時configで保持する版では、全体のcron既定変更の反映経路も確認 |

反映失敗なら、ログから原因を絞り、今回変更したキーを戻す。外部への実投稿を設定テストとして勝手に行わず、状態確認・合成入力・隔離テストを使う。

## 根拠を探す場所

対象パッケージの `shared/paths`、`shared/types`、`shared/models`、`shared/effort`、`gateway/api`、`gateway/server`、`gateway/watcher`、`sessions/manager` が一次情報。`template/config.default.yaml` は初期値の参考。CLIのコマンドは `ryoko --help` とサブコマンドの `--help` で確認する。インスタンスにある古い `docs/` の「全変更が即時反映」という記述より、稼働実装を優先する。
