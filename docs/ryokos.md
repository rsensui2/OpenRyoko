# 複数の Ryoko（ピア）

メインの Ryoko とは別に、名前・絵文字・人格・エンジン（モデル）・Slack アプリを自分で持つ Ryoko を増やせる。部下（社員）ではなく、メインと並ぶもう一人のアシスタントとして振る舞う。

## 記憶の持ち方

作るときに、長期記憶をどうするかを選ぶ。

| `memory` | 使う記憶 | 書き込み先 |
|---|---|---|
| `shared` | メインと同じ `~/.ryoko/MEMORY.md` と `~/.ryoko/knowledge/` | メインと同じ場所 |
| `own` | 自分専用の `~/.ryoko/ryokos/<name>/MEMORY.md` と `~/.ryoko/ryokos/<name>/knowledge/` | 自分専用の場所。メインの MEMORY.md には書かないよう指示される |

- どちらの場合も、記憶をプロンプトに入れる条件はメインと同じ（Web の画面からの会話と、`portal.trustedSpeakers` に入っている人との 1 対 1 の DM だけ）。チャンネルや信頼していない人の DM では入らない
- `own` の Ryoko は、メインの MEMORY.md を受け取らない。knowledge の一覧も自分のフォルダだけを見る
- `own` から `shared` に切り替えても、`ryokos/<name>/` の記憶は消さない。Ryoko を削除しても残る。残っている間は、同じ名前を新しい Ryoko に使わない（`hana-2` のようにずらす）ので、新しい Ryoko が前の Ryoko の記憶や Slack アプリを引き継ぐことはない
- ほかの Ryoko や社員から依頼されて動く子セッション（`parentSessionId` があるもの）には、どちらの記憶も入れない

### `own` はファイルの隔離ではない

`own` の分離は、プロンプトでの指示によるもので、ファイルシステムの隔離（サンドボックス）ではない。

- プロンプトには、メインの MEMORY.md・`knowledge/`・ほかの Ryoko の `ryokos/*` を読んだり検索したりしないこと、この指示が `AGENTS.md` の記憶の説明より優先されることを書いている
- それでもエンジン（Claude Code / Codex）は、作業ディレクトリ `~/.ryoko` の中のどのファイルも技術的には読める。作業ディレクトリを `ryokos/<name>/` に変えることはしていない（スキル・設定・セッションの再開が `~/.ryoko` を前提にしているため）
- 他人に見せたくない記憶をメインに置いている場合は、そのことを前提に使い分ける

## ファイルの置き場所

| 何 | どこ |
|---|---|
| 定義（名前・人格・エンジン・記憶の持ち方） | `~/.ryoko/org/ryokos/<name>.yaml`（`department: ryokos`、`rank: executive`、`peer: { memory: shared \| own }`） |
| 自分専用の記憶（`own` のとき） | `~/.ryoko/ryokos/<name>/MEMORY.md`、`~/.ryoko/ryokos/<name>/knowledge/` |
| Slack アプリの設定途中の記録 | `~/.ryoko/slack-apps/<name>.json`（権限 0600。メインは従来どおり `~/.ryoko/slack-app.json`） |
| Slack の接続 | `config.yaml` の `connectors.instances` に `id: slack-<name>`、`employee: <name>` のエントリ |

`<name>` は表示名から作る英小文字・数字・ハイフンの名前（例: `Hana` → `hana`）。英数字を含まない表示名では `ryoko-2`、`ryoko-3`… になる。既存の社員の名前とは重ならない。

## Slack

Ryoko ごとに別の Slack アプリを作る。手順はメインの「Slack につなぐ」（[slack-setup.md](slack-setup.md)）と同じで、各 API に `bot`（GET はクエリ `?bot=<name>`、POST は本文の `bot`）を付けるとその Ryoko の設定になる。付けないか `main` ならメインの設定。

- 会話（セッション）は bot ごとに分かれる。同じ人が同じスレッドで両方の bot に話しかけても、メインの会話とピアの会話は別のセッションになり、互いの続きにはならない（セッションのキーにコネクタ名が付く。例: `slack-hana:dm:U…`。メインの bot は従来どおり `slack:dm:U…`）
- Ryoko を削除した後や、定義が読めなくなった後にその bot に届いたメッセージは、返事をせずに捨てる（メインの Ryoko が代わりに答えることはない）
- 「許可する」のあとの戻り（OAuth callback）は `state` だけからどの Ryoko の設定かを見つける。`state` は Ryoko ごとに別に発行され、1 回限り・30 分で失効する
- 最後の手順（App-Level Token を貼る）で、その Ryoko の `connectors.instances` のエントリを書く。既存のエントリにある `respondTo` や `triage` は残す。トークンを確かめてから保存し、接続が起動しなければ `config.yaml` を元に戻す（メインと同じ）
- チャンネル一覧は `GET /api/connectors/slack/channels?instance=slack-<name>`

## API

| | |
|---|---|
| `GET /api/ryokos` | 一覧（先頭がメイン） |
| `POST /api/ryokos` | 作る。`displayName`・`persona`・`engine`（`claude` / `codex`）・`memory`（`shared` / `own`）は必須、`emoji`・`model` は任意 |
| `PATCH /api/ryokos/<name>` | 変える（送った項目だけ。`model: null` で既定に戻す） |
| `DELETE /api/ryokos/<name>` | 定義と Slack の接続を消す。記憶は残す |

メイン（`main`）はここでは変更・削除できない。メインの名前や人格は設定画面と `SOUL.md`・`IDENTITY.md` で変える。
