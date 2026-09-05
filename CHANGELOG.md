# Changelog

> **バージョン体系について**: 2026.4.26 から日付ベース (`YYYY.M.D`) のCalVerに移行しました。npm semver の制約上、月・日の leading zero は付けません (例: 4月26日 → `2026.4.26`)。

## [2026.9.7] - 2026-09-05

### 追加・改善

- **Claude Fable 5.1 を選択可能に**: Anthropic（Claude）のモデル候補とモデル情報に正式ID `claude-fable-5-1` を追加。推論強度 `low / medium / high / xhigh / max`、100万トークンのコンテキスト表示に対応しました。既存の既定モデルや独自の `models:` 設定は維持します。
- **Fableの推論強度を実行ごとに反映**: `max` はClaude Codeへ `--effort` で渡します。設定画面で別モデルへ切り替えた際は、非対応の `max` が残らないよう既定値へ戻します。
- **料金推計と利用条件**: Fableの標準API料金（入力 $10 / 出力 $50、100万トークンあたり）を推計表示に反映。モデル選択時に必要なClaude Code最低版（2.1.255）を案内します。サブスクリプションの利用枠とは異なります。

### モデル情報

- [Anthropic公式仕様](https://platform.claude.com/docs/en/models/fable-5-1/overview): コンテキスト100万、最大出力128,000トークン。
- [Claude CodeのFable対応](https://code.claude.com/docs/en/model-config#work-with-fable): Claude Code 2.1.255以降と接続アカウントのアクセス権が必要です。

### 検証

- Backend: 161ファイル・1,896テスト成功。Web: 13ファイル・91テスト成功。
- 実機のClaude Code 2.1.261と既存認証で、Fable 5.1の `low` / `max` 応答を確認。
- Fableの新規・再開実行へ正式モデルIDと `max` が渡ること、モデル情報・選択画面・コンテキスト表示を検証。

## [2026.9.6] - 2026-09-05

### 追加

- **GPT-6 Astra を選択可能に**: OpenAI（Codex）のモデル候補に `gpt-6-astra` を追加。推論強度 `low / medium / high / xhigh / max` と 1,050,000 トークンのコンテキストをモデル情報に反映。既存の既定モデルや独自の `models:` 設定は維持します。
- **セッション横断の直近アクション**（PR #37）: 別セッションで行った直近の返信を会話の参考情報に追加。個人DMを含む横断参照は本人確認済みのDM・Webに限定し、共有Slackでは同じチャンネルの情報だけを使用します。公開抑止された内部応答・社員エージェント・cronは除外し、検索用インデックスで全履歴走査を防ぎます。既定は過去6時間・15件で、`context.crossSessionWindowHours` / `context.crossSessionLimit` のいずれかを0にすると無効化できます。

### 修正・改善

- **Slackの空気読み**（PR #22）: テキスト返信は慎重に保ち、自然な挨拶や成果の共有には絵文字で反応しやすく調整。進行の承認や継続依頼は引き続き返信・作業へ進みます。
- **話者情報の欠落への対応**（PR #32）: 表示名がない場合も利用可能な名前・ハンドルから発言者情報を補完。Slack・Discordの本人確認は現行のID照合を維持します。

- **ワークフローの推論強度を実行時に維持**: 親セッションを持たないワークフローでも、指定した `max` 等の推論強度がエンジン既定値に戻らないよう修正しました。

### モデル情報

- [OpenAI公式モデル情報](https://developers.openai.com/api/docs/models/gpt-6-astra): 最大出力 128,000 トークン。API標準料金は100万トークンあたり入力 $10 / キャッシュ入力 $1 / 出力 $50（長文入力には別倍率）。Codexのサブスクリプション利用枠とは異なります。
- Astraは段階提供です。OpenRyokoへの候補追加とは別に、利用するOpenAIアカウントでのアクセス権が必要です。[提供状況・移行ガイド](https://developers.openai.com/api/docs/guides/latest-model)

### 検証

- Backend: 161ファイル・1,891テスト成功。Web: 13ファイル・88テスト成功。両パッケージの型チェック、本番ビルド、tarball同梱検査成功。
- Codex CLI 0.153.4の使い捨てコンテナで、既存認証によるAstraの `low` / `max` 応答を確認。
- 既存PR #22・#32・#37は競合解消と独立レビュー後、GitHub Actionsの全チェックを通過してマージ。

## [2026.9.3] - 2026-09-01

> 従業員に委譲した親セッションが「二度と起きない」問題の修正。8/18 の gateway 認証強化以降、子セッションの完了通知が自分の gateway に未認証で POST され、401 で無音のまま捨てられていた。

### 修正

- **子セッション完了通知・レート制限通知が 401 で全滅していた**（PR #67, @mrkm86）: `sessions/callbacks.ts` の 2 経路（`POST /api/sessions/:id/message` = 子→親の完了通知、`POST /api/connectors/:name/send` = usage limit 等の通知・呼び出し 8 箇所）が Authorization ヘッダを付けておらず、`fetch()` は 4xx で reject しないため `.catch()` も `res.ok` も無く、ログにも残らなかった。2026.8.20（`jobs/notify.ts` の同種修正）の取りこぼし。`_postToGateway()` に統合し、`readGatewayAuthToken()` でトークンを付与、`res.ok` を確認して拒否は warn に出す。抑止経路（`alwaysNotify: false` / 親不在 / 親が error）もログを残す。レスポンス body は `cancel()` で解放
  - 影響条件: `gateway.host` が network（`0.0.0.0` 等）または `authRequired: true` で Bearer 必須になっている環境。既定の `127.0.0.1` は無傷
- **委譲プロトコル（COO の system prompt）を「onComplete 通知が主経路、ただし保証ではない」に改訂**: 旧文面の「通知は必ず来る／NEVER poll」という無条件の約束をやめ、通知が省略される 3 条件（`parentSessionId` 無し / `alwaysNotify: false` / 親が `error`）と「POST 失敗は gateway.log にしか出ない」を明記。即返答してターンを終える運用は維持し（ターン内ポーリング禁止）、保険として `GET /api/sessions/<child-id>?last=5` と `ryoko job run … -- 'sleep <sec>'` の watchdog を案内。`parentSessionId` は必須
- テストヘルパー `makeSession()` が `overrides` を spread していなかった不備を修正（既存テストが別の理由で通っていた）

### Verification

- 実機（host 0.0.0.0）で修正前の 401 を再現（no-token → 401 / with-token → 404）
- Backend: **152 test files / 1,751 tests pass**、tsc clean
- PR: [#67](https://github.com/rsensui2/OpenRyoko/pull/67)

## [2026.9.2] - 2026-08-31

> macOS で `npm install -g openryoko` した直後に、最初のチャットで gateway が落ちる問題の修正。

### 修正

- **node-pty の `spawn-helper` に実行権限を付与する postinstall**（PR #62）: node-pty@1.1.0 の npm tarball は `prebuilds/darwin-*/spawn-helper` を 0644 で同梱しており、npm でも pnpm でも +x が付かない。macOS では最初の PTY 起動（チャットがエンジンを起動した瞬間）に `posix_spawnp` が失敗して gateway が落ちていた。公開パッケージ側の `postinstall`（`scripts/fix-prebuild-permissions.mjs`）が npm 配置（nested / hoisted / global）と pnpm workspace 配置の両方で `spawn-helper` を 0755 にする。失敗は全て非致命、Windows は即終了。開発用にルート `package.json` にも同種の postinstall（upstream jinn #104 の移植）
- Linux（本番コンテナ）は darwin プレビルドを使わないため挙動に変化なし

### Verification

- 本物の `npm install`（node-pty@1.1.0 依存 + 同 postinstall）で 0644 → 0755、`--ignore-scripts` の対照は 0644 のまま。pnpm workspace で root / packages/jimmy 両方の postinstall が正常終了
- Backend: **151 test files / 1,726 tests pass**（npm / hoisted / pnpm symlink / 未リンクの .pnpm ストア / 冪等 / node-pty 不在 の 6 ケースを新設）、tsc clean
- Codex（gpt-5.6）2巡レビュー（不可 → 公開パッケージ側 postinstall を追加 → 可）
- PR: [#62](https://github.com/rsensui2/OpenRyoko/pull/62)

## [2026.9.1] - 2026-08-31

> 初回セットアップが「動くところまで」になった。名前を入れたら、エンジンの起動確認 → Slack をその場で検証して接続 → 最初の自動化を選ぶ、で Ryoko が仕事を始められる。

### このリリースでできるようになったこと

- **オンボーディング再設計**（/onboarding）: 名前 → エンジン確認 → Slack 接続 → 最初の自動化 → 完了。完了後は「自動化」ページの作成パネルが開いた状態で始まる（`/cron?create=<templateId>`）
- **エンジンの起動確認を自動化**: Claude / Codex が **このマシンで起動できるか**（インストール・認証切れ）をプローブして表示。「設定してあるはずなのに動かない」を最初のステップで潰す
- **Slack 接続を 1 操作に**: トークンを Slack に問い合わせて検証してから保存し、コネクタを再起動。失敗したら以前の設定に戻し、**戻せたかどうかも正直に表示**（ディスク／稼働の別）
- **config 書込の安全化**: 設定 API と Slack 接続の書込を直列化し、rollback 前に外部変更を検出（`withConfigLock` + CAS）。設定ファイル watcher の自己書込抑止をカウンタ化

### 同梱した修正（別スレッド）

- Slack `respondTo.channel` が `mention` / `never` のとき、チャンネルの絵文字リアクションも処理しない（複数 Bot 同居で二重反応していた。グループDM は channel スコープ側に倒す）— PR #63

### Verification

- Backend: **150 test files / 1,720 tests pass**（engines / slack-verify / slack-connect の API テストを新設。rollback 失敗・out-of-band 変更・同時 connect の直列化を含む）、tsc clean（jimmy/web）、web build 成功
- Codex（gpt-5.6）5巡レビュー（マージ不可×4 → 全指摘消化 → マージ可）。PR #63 も Codex マージ可（提案のテストを追加）
- PR: [#64](https://github.com/rsensui2/OpenRyoko/pull/64)（本体）、[#63](https://github.com/rsensui2/OpenRyoko/pull/63)（取り込み）

## [2026.8.31] - 2026-08-31

> Workflow に「顔」がついた。cron と Workflow をひとつの「自動化」ページで扱い、テンプレートの穴埋めだけで作れる。AI エージェントは CLI から同じことができる。

### このリリースでできるようになったこと

- **「自動化」ページ**（旧「スケジュール」/cron）: cron と Workflow を1つのリストで表示・ON/OFF。行を開くと流れ図と実行履歴、「今すぐ実行」。集計・フィルタも両方を合算
- **テンプレートから Workflow を作成**: 「見張り型」（定期チェック→必要な時だけ重いモデル）・「定時実行型」・「イベント駆動型」の3型。名前・間隔・プロンプト等の穴埋めだけで、ノードエディタ不要
- **見張り型は既定で人間の承認ゲート付き**: 外部データ（メール等）の要約が何を言おうと、operator が承認するまで重いモデルは動かない。承認は Web の run 行のボタンか \`ryoko workflow approve\`。判定材料は「外部由来・未検証」ラベル付きで表示
- **AI エージェント向け CLI**: \`ryoko automation list|enable|disable\`（cron/workflow を同じ動詞で）、\`ryoko workflow templates|list|create|show|run|runs|approve\`。全コマンド \`--json\`。同梱 docs（\`docs/automations.md\`）にエージェントの操作ガイド
- **atomic な作成 API**: \`POST /api/automation/templates/:id\` / \`POST /api/automation/definitions\` — 完全検証を先に行い、作成〜有効化を1トランザクションで（失敗時に骨定義が残らない。通知と trigger 再アームは commit 後に1回）

### 内部改善・整理

- Workflow 一覧のカーソルページング対応（Web/CLI）、設定ページの「Cron」節を「自動化の通知」に役割限定
- 滞留 PR の整理: #26（中断ターンを赤エラーにしない）と #57（crypto.randomUUID polyfill、#16 のリベース）を取り込み

### Verification

- Backend: **147 test files / 1,692 tests pass**（承認 routing・schedule→Merge 経路・atomic ロールバック・承認 API の HTTP 契約テストを含む）、tsc clean（jimmy/web）、web build 成功
- Codex（gpt-5.6-sol）5巡レビュー（マージ不可×4 → 全指摘消化 → マージ可）
- PR: [#59](https://github.com/rsensui2/OpenRyoko/pull/59)（本体）、[#57](https://github.com/rsensui2/OpenRyoko/pull/57)・[#26](https://github.com/rsensui2/OpenRyoko/pull/26)（取り込み）

## [2026.8.29] - 2026-08-28

> 上流 Jinn の Workflow 基盤を移植した（オプトイン・既定OFF）。タスクの性質に応じて「決定的判定 / 軽量モデル / Opus級」を選べるルーティング基盤の第1弾（backend core）。

### このリリースでできるようになったこと

- **Workflow エンジン（`config.workflows.enabled: true` でオプトイン）**: 上流 `hristo2612/jinn` の Workflow 基盤を backend core として移植。trigger 3種（manual / schedule / event）、ノード7種（Employee / Workflow Call / Condition / Merge / Approval / Wait / End）、`/api/workflows` API 一式
- **ノード単位のモデルルーティング**: Employee ノードごとに engine / model / effort / fallback を指定でき、構造化出力 → Condition（決定的判定・LLM 不使用）で「安いモデルで判定し、必要なときだけ高性能モデルへ渡す」を表現できる
- **外部イベント連携**: `POST /api/workflows/events/<name>`（fireId 冪等・64KiB 上限）。外部監視は OS スケジューラのスクリプトから event trigger を叩く上流方針を踏襲
- **利用量の帰属**: run 単位で attempt / session / engine / model と `spendUsd` を追跡
- **無効時は副作用ゼロ**: フラグ未設定なら Workflow DB 作成・trigger arming・API ルート露出のいずれも行われない。既存の Cron・Slack respond-policy・MEMORY 注入には非干渉

### 移植の設計判断

- Todo（work-items）サブシステムは移植せず、型互換の不活性 shim で分離。todo-status trigger / todo-comment wait を含む定義は保存時に 422 `unsupported-capability` で拒否
- dispatch claim は CAS + 永続 claim + settle と queue close の同一トランザクション化で排他を担保。graceful shutdown は次回 boot と同一の sweep で `gateway-restart` receipt を刻む（再起動が run を失敗させない）
- WorkflowService の構築は listen + gateway.json 書込後に延期（interactive PTY turn の Stop hook 競合を回避）
- vitest にテストホーム隔離（globalSetup + per-worker 分離 + fail-closed ガード）を導入 — テストが実 `~/.ryoko` に触れることを構造的に防止

### Verification

- Backend: **144 test files / 1,650 tests pass**（Workflow 新規 811 件を含む）、tsc clean
- Codex（gpt-5.6-sol）による4巡レビュー（マージ不可×3 → 修正 → マージ可）で HIGH 2件含む全指摘を消化
- PR: [#55](https://github.com/rsensui2/OpenRyoko/pull/55)、評価文書: `docs/plans/2026-08-28-workflow-port-evaluation.md`

## [2026.8.28] - 2026-08-28

> MEMORY.md（長期記憶）の注入がプライバシーゲート付きのコア機能になった。

### このリリースでできるようになったこと

- **長期記憶が実際に効くようになった**: これまで MEMORY.md はコードでは注入されず、テンプレート CLAUDE.md の `@MEMORY.md` import（Claude エンジンのみ・話者を問わず）だけが頼りだった。gateway が **private web セッションと、`portal.trustedSpeakers` に載る相手との DM に限り** MEMORY.md を system prompt に注入する
- **共有チャンネルでは誰が話していても注入されない**: スレッドのセッションは参加者をまたいで再利用されるため、一度注入した記憶が履歴に残るのを構造的に防ぐ。cron・employee セッションにも注入されない
- **`portal.operatorSlackId`**: 設定するとオペレータ本人確認が Slack ID の厳密一致になり、表示名の一致では本人扱いされない（表示名は誰でも変更できるため、信頼できないメンバーがいるワークスペースでは必ず設定を推奨）。未設定時の名前一致は「name match only — NOT identity proof」と明示される
- **既存インスタンス向けマイグレーション**: `ryoko migrate` が既存 CLAUDE.md の `@MEMORY.md` import（新ゲートの迂回路）を除去し、記憶セクションの記述を新仕様に更新する

### Security

- セッションの source を web に固定していた実行経路を修正（Slack/cron 起源のセッションが web 扱いで注入対象になる迂回を遮断）
- 注入キャップを UTF-8 バイト基準に（日本語テキストで文書化済み上限 24,000B を大幅超過できた）

### Verification

- Backend: **103 test files / 833 tests pass**（+11: 共有チャンネル拒否・なりすまし・source 偽装・バイトキャップ等）
- Codex（gpt-5.6-sol）による4巡の敵対的レビューで CRITICAL 2件含む全指摘を消化、最終 VERDICT: OK
- PR: [#54](https://github.com/rsensui2/OpenRyoko/pull/54)

## [2026.8.27] - 2026-08-27

> 新規セットアップ体験の総点検リリース。config テンプレート・skills.json・メモリ指示・同梱 docs・Web オンボーディングの不整合をまとめて修正し、Codex + 独立レビュアーによる多段レビューで発覚したセキュリティ問題も解消。

### このリリースでできるようになったこと

- **ドキュメント通りのデフォルトが実際に適用される**: `ryoko setup` が同梱テンプレート `config.default.yaml` を正しく使うようになった（従来はファイル名不一致で常に最小構成へ無言フォールバックし、`mcp.fetch` 等が無効だった）。名前に `"` や `\` や `$` を含めても config が壊れない
- **`ryoko skills list / add / update` が素の環境で動く**: skills.json の正典を `{"installed": {...}}` オブジェクト形式に統一（テンプレート・find-and-install スキルと一致）。旧配列形式も読める。未知フィールドは保持
- **メモリ指示の一本化**: セッション注入プロンプトを MEMORY.md + knowledge/ の2層方式に統一（upstream 由来の user-profile 3ファイル方式と旧 `~/.jinn` パス表記を全廃）。オンボーディング判定は BOOTSTRAP.md 基準になり、旧版から移行したユーザーがオンボーディングに閉じ込められない
- **Web オンボーディングが日本語テンプレートに効く**: 名前変更が CLAUDE.md / AGENTS.md / IDENTITY.md に正しく反映。言語だけの変更で名前が Ryoko に巻き戻らない。config.yaml の書き換えは portal ブロック限定になり、テンプレートの案内コメントが消えない
- **カスタムインスタンス対応**: 注入プロンプト・BOOTSTRAP.md・同梱スキルの操作パスを実インスタンスホーム（`JINN_HOME` / cwd 相対）に統一。`RYOKO_INSTANCE` 環境でも正しい場所を操作する

### Security

- agent が自由に書く skills.json の `source` が `shell: true` の spawn に到達するコマンドインジェクション経路を遮断（POSIX はシェルなし直接 spawn、source は `owner/repo[@skill]` 形式のみ許可、`../repo` 等のローカルパス形式も拒否）
- Windows 互換のため shell 経由になる経路も、CLI 引数の形式検証と検索語の無害化（Unicode 対応・日本語検索語は保持）で全 argv を検証済みに

### Verification

- Backend: **102 test files / 822 tests pass**（前版から +26。セキュリティ・回帰ケースを追加）
- Codex（gpt-5.6-sol）と独立コードレビュアーによる4巡のレビューで CRITICAL〜MEDIUM 指摘を全消化、最終 VERDICT: OK
- PR: [#51](https://github.com/rsensui2/OpenRyoko/pull/51) / [#52](https://github.com/rsensui2/OpenRyoko/pull/52)

## [2026.8.21] - 2026-08-20

> Gateway認証を有効にした環境で、`ryoko job run` の完了通知が401になり、元のセッションが起床しない問題を修正。

### Reliability / Fixes

- 完了通知の全リトライに、このOpenRyoko instanceのBearer tokenを自動付与。
- 各リトライ直前にtokenを再読込し、Gateway再起動中にtokenが作成・更新された場合も復旧。
- Gateway認証を無効化した既存環境との互換性、および通知のdedupe挙動を維持。

### Verification

- Backend: **97 test files / 782 tests pass**
- backend TypeScript typecheck、production build、`git diff --check`
- token付与、token未作成時の互換性、401後のtoken再読込、実job monitor経路を回帰テスト化

## [2026.8.20] - 2026-08-18

> `gateway.host: 0.0.0.0` / `::` の環境で、AIやCLIへ渡されたURLがGateway自身に
> `421 host_not_allowed` で拒否され、CronやSlack投稿が無言で止まる問題を恒久修正。

### このリリースでできるようになったこと

- **ネットワーク待受でも内部処理が止まらない**: 待受アドレス（bind）と接続先URL（connect）を明確に分離。`0.0.0.0` / `::` で待ち受けても、システムプロンプト、`ryoko status`、`ryoko pair`、AIの子プロセスには接続可能なloopback URLを渡す。
- **認証情報やURLを手書きせずGateway APIを呼べる**: `ryoko api GET /api/status`、`ryoko api POST /api/sessions --data '{...}'` を追加。正しい接続先とBearer tokenを自動選択し、外部URLへのtoken送信を拒否。401 / 421を含むHTTPエラーも終了コードと本文で確認できる。
- **既存のスキルやCronをアップデート時に修復できる**: `ryoko update` が `~/.ryoko` 内の `http://0.0.0.0:<port>` / `http://[::]:<port>` を検出し、バックアップ後にloopbackへ自動置換。`ryoko migrate --check` で確認、`ryoko migrate --fix` で手動修復もできる。
- **Bearer付け忘れ候補に気づける**: マイグレーション監査が、保護APIを直接curlしているのに認証処理が見当たらないファイルを警告し、`ryoko api`への移行を案内する。

### 安全性と信頼性

- Hostガードは緩和しない。`Host: 0.0.0.0` / `Host: [::]` は、ブラウザらしいヘッダーの有無に関係なく拒否する。
- `gateway.allowedHosts` にワイルドカードbindを追加しても安全なHost名として扱わず、警告して無視する。DNS rebinding / “0.0.0.0 day” への防御を維持。
- 421レスポンスとwarnログに、拒否理由と使うべきloopback URLを表示。ログはHostごとに一度、最大50種類までに制限してログ洪水を防ぐ。
- 自動置換はテキストファイルだけを対象にし、symlink、ログ、DB、モデル、ソースcheckout、巨大ファイルを除外。変更前ファイルをユーザー専用backup directoryへ保存し、元のpermissionを維持してatomic置換する。
- AIへ渡す標準の委任・コネクタ・同期例を、認証なしcurlから`ryoko api`へ変更。

### 互換性に関する注意

- `http://0.0.0.0:<port>` は待受指定であり、クライアントの接続先としては使えない。`~/.ryoko` 外にある独自スクリプトは `ryoko api` または `$RYOKO_GATEWAY_URL` + Bearer認証へ変更する。
- 応急処置で `gateway.allowedHosts: [0.0.0.0]` を追加していた場合、この値は本リリースから無視されるため削除できる。

### Verification

- Backend: **97 test files / 780 tests pass**
- Web: **12 test files / 85 tests pass**
- backend / WebのTypeScript typecheck、production build、`git diff --check`
- strict Hostガード、URL変換、token付与、外部URL拒否、バックアップ付き移行監査を回帰テスト化
- ワイルドカードbindの実Gatewayでloopback成功、wildcard Host拒否、401 / 421診断、`ryoko api`を実測
- production依存監査とnpm公開物のsecret・秘密鍵・個人絶対パス走査

## [2026.8.19] - 2026-08-18

> 2026.8.18 と同日の追加リリース。OpenRyoko自身の更新をダッシュボードとチャットで見逃さないための通知機能を追加。

### このリリースでできるようになったこと

- **ダッシュボードで新しいバージョンに気づける**: npmに最新版が公開されると、現在版と最新版、更新コマンド、公式リリースノートへのリンクをダッシュボードに表示。通知はバージョン単位で閉じられるため、同じ案内が繰り返し邪魔にならない。
- **AIからいつものチャットへ更新を知らせてもらえる**: 更新通知専用Cronを設定すると、Slackなど指定したコネクタ／チャンネルへAIが分かりやすい通知文を送信。スケジュール、タイムゾーン、通知先を設定画面から変更でき、「今すぐ確認」も可能。
- **更新がない日はAIを消費しない**: 定期確認自体は固定されたnpm公式エンドポイントへ直接問い合わせ、AIを起動するのは新しい未通知バージョンが見つかった時だけ。同じバージョンはジョブごとに一度だけ通知する。

### 安全性と信頼性

- npm応答は3区切りの数値バージョンだけを受理し、リリース本文など外部の文面をAIプロンプトへ混ぜない。確認先・リリースリンクもOpenRyoko公式の固定URLに限定。
- AIターンが終了しただけでは通知済みにせず、確認済みの最新バージョンを含むメッセージが実際のチャットコネクタで受理された場合だけ記録。無言終了やエラーメッセージは次回再試行する。
- 更新確認は6時間キャッシュ、5秒タイムアウト、同一ジョブの多重実行防止付き。通知状態はユーザー専用権限でatomic保存。
- 更新通知Cronの無効なスケジュール、通知先未設定、重複ジョブIDをAPI側で拒否。

### Verification

- Backend: **93 test files / 764 tests pass**
- Web: **12 test files / 85 tests pass**
- backend / WebのTypeScript typecheck、production build、`git diff --check`
- 実npmレジストリへの更新確認、openclaw-sandboxへのデプロイ、実Cron手動実行（最新版時はAIを起動せず`up-to-date`で終了）
- Claude CLIによる2巡の独立レビューと指摘事項の回帰テスト化

## [2026.8.18] - 2026-08-18

> 2026.8.17 の公開後監査で見つかった依存脆弱性と、ネットワーク公開時の認証境界を修正したセキュリティリリース。

### このリリースで安全になったこと

- **WhatsApp / Telegramの既知Critical依存を解消**: Baileysを修正版へ更新し、Telegramを依存ゼロの公式v2 APIへ移行。送受信・返信・編集・typingの既存動作は維持。
- **依存監査をゼロ件まで改善**: production依存の `pnpm audit` で critical / high / moderate / low がすべて0件。
- **外部公開時に稼働情報を見せない**: `/api/status`も端末認証の対象にし、モデル、コネクタ、セッション数、空き容量の未認証取得を防止。
- **監視は情報を出さず継続可能**: 認証不要の `/api/health` は `{ "ok": true }` だけを返し、Dockerや外形監視の生存確認に利用可能。
- **端末認証がサーバー側でも30日で失効**: Cookieだけでなく保存済み端末セッションにも有効期限を持たせ、盗まれたCookieが無期限に使われないよう修正。
- **ペアリング総当たりとディスクI/O攻撃を抑止**: 送信元ごとに5分間10回までに制限し、存在しないコードでは認証ファイルを書き換えない。
- **ワイルドカードbindでも任意Hostを信用しない**: `0.0.0.0` / `::` は実際のローカルNIC、loopback、`gateway.allowedHosts`に限定。DNS rebinding耐性を維持。
- **プロキシヘッダーを二重の明示設定時だけ信頼**: `gateway.trustProxyHeaders: true`に加え、接続元が`gateway.trustedProxyAddresses`に一致する場合だけ転送ヘッダーを利用。
- **静的ファイル配信の境界を厳密化**: 名前が似た隣接ディレクトリへ抜けられないよう、実ディレクトリ境界で検証。
- **npm公開物を最小化**: 実行に不要なテストコードとテスト用fixtureをproduction buildから除外。

### 外部公開している場合の設定

- 平文HTTPでインターネットへ直接公開せず、Tailscale/VPNまたはHTTPSリバースプロキシを利用する。
- リバースプロキシの公開名を `gateway.allowedHosts` に追加する。
- `gateway.trustProxyHeaders: true`を設定し、信頼するプロキシの接続元IPを`gateway.trustedProxyAddresses`に追加する。
- LANの実IPで直接利用する場合は自動許可されるため、追加設定は不要。

### 互換性に関する注意

- `/api/status`を直接監視していた場合は、Bearer認証を付けるか、情報を返さない`/api/health`へ切り替える。
- 30日より前に作成された既存の端末セッションは失効するため、必要に応じて再ペアリングする。

### Verification

- Backend: **89 test files / 747 tests pass**
- Web: **11 test files / 82 tests pass**
- backend / WebのTypeScript typecheck、production build、`git diff --check`
- production依存監査: 0 vulnerabilities
- npm公開物のsecret・秘密鍵・個人絶対パス走査
- Claude CLIによる独立セキュリティレビュー

## [2026.8.17] - 2026-08-17

> Jinn v0.10〜v0.30 の改善を OpenRyoko の既存設計へ選別統合し、モデル設定をベンダー／モデル選択とカスタム入力の両方に対応したリリース。

### このリリースでできるようになったこと

- **用途に合わせてAIを選べる**: 通常の会話、Slackの空気読み、Goal判定ごとに、ベンダーとモデルを画面から選択できる。一覧にないモデルもIDを手入力して利用可能。
- **外出先から安全に使える**: OpenRyokoをネットワーク公開する場合に、端末ごとの認証・ペアリング・アクセス解除を利用できる。
- **長い会話から必要な情報を見つけやすい**: 過去メッセージの検索、検索結果への直接移動、古い履歴の追加読み込みに対応。
- **長時間の作業を安心して任せられる**: Claudeの長時間セッションや再接続を安定化し、再起動後も作業画面を復元。データの自動バックアップと容量監視も追加。
- **Slackの短い承認で、そのまま作業を続けられる**: `GO`、`はい`、`OK`、`了解`、`続けて`、`✅`などをReactionだけで終わらせず、依頼の続きとして処理する。
- **Claudeの利用状況を確認できる**: Dashboardから5時間・7日間の利用状況を確認できる。

### Features
- **モデル選択 UI の刷新**: デフォルトモデルは Anthropic / OpenAI / Google、空気読みトリアージと Goal 判定は対応する Anthropic / OpenAI からベンダーとモデルを個別選択できる。すべてカスタムモデル ID の手入力と「自動」への復帰に対応し、ネイティブ label・focus・keyboard 操作も整備。
- **ネットワーク公開時の認証**: bearer/device auth、5分・単回使用の pairing code、browser device revoke、Host / Origin 防御を追加。loopback の従来操作は維持し、instance ごとに認証状態を分離。
- **長期セッションの履歴操作**: session/activity の cursor pagination、message の timestamp+rowid paging、FTS5 検索、検索結果への message anchor、旧履歴の段階読込に対応。
- **耐久性と運用ヘルス**: SQLite online backup（日次・7世代）、書込前の空き容量判定、status の storage health、上限付きログローテーション、機密値の redact、home/config の権限強制を追加。
- **Durable PTY と権限プロンプト**: 256 KiB・atomic 保存の scrollback snapshot、再起動後の復元、明示 opt-in の自動承認、曖昧な権限入力の拒否を追加。
- **Claude usage 表示**: OAuth usage API の 5h / 7d / model-scoped bucket を Dashboard に投影し、token と provider error は外部へ公開しない。

### Reliability / Fixes
- **Slack Reaction がタスク継続指示を飲み込む問題**: DM／DM相当会話のreact-only候補を、純粋な感謝・会話終了表現へ決定論的に限定。`GO`、`はい`、`OK`、`了解`、`続けて`、`お願いします`や承認系emojiは通常セッションへ渡し、直前がbot発言の場合もReaction判定を上書きしてタスク停止を防止。
- **Claude PTY の長時間ターン安定化**: 実モデルの context / auto-compact 上限を反映し、`UserPromptSubmit` 未確認時の Enter 再送、添付パスの保護、無活動 stall 判定、suggestion/reasoning metadata 除去を追加。
- **正確なターン会計**: 累積 transcript から今回ターン分だけを差分算出し、Web / connector / fallback / retry の各経路で一度だけ計上。
- **SSE proxy の再利用と回復**: PTY 単位の keep-alive pool、停止時 cleanup、応答前 socket error の backoff 付き再試行を追加。
- **Codex と Web API の入力境界**: positional argument に `--` fence、メッセージ本文にサイズ・空白検証を追加。
- **interactive PTY のレース修正**: stale hook、PTY death、permission pending、shutdown 時の snapshot flush、復元済み buffer reset の競合を解消。

### Verification
- backend: **85 test files / 732 tests pass**
- Web: **11 test files / 82 tests pass**
- backend / Web の TypeScript typecheck、production build、`git diff --check` 成功
- Claude CLI によるレビューを2巡し、最終競合指摘まで回帰テスト化
- 隔離された実行環境へデプロイし、OpenRyoko API、Slack Socket Mode、OpenClaw Gateway、Dashboard の正常稼働を確認

**Breaking changes**: なし。

## [2026.8.6] - 2026-08-04

> 2026.8.5 の実機検証で発見した誤警報のホットフィックス。

### Fixes
- **web セッションの notification 起床で「配信失敗」誤警報が出る問題**: web/API セッションは `connector` に擬似名（"web" 等 — createSession が source をデフォルト代入）を持つため、配信先が元々存在しないのに `no_target` が「顧客未達」として毎回記録されていた（親子セッションのコールバック起床でも発生）。reply_context に実際の宛先（channel/chatId/to）がある場合のみ未達として記録するよう修正。

## [2026.8.5] - 2026-08-04

> 2026.8.4 と同日の追加リリース（npm は同一 version の再 publish 不可のため番号を +1。2026.7.25 / 2026.7.26 の前例に倣う）。

### Features（Issue #38 フォローアップ: 自己起床する切り離しジョブ）
- **`ryoko job run` — 自己起床ジョブランナー**: ターンを跨ぐ長時間ジョブを 1 コマンドで切り離し実行。ジョブ終了時（成功 / 失敗 / タイムアウトすべて）に元のセッションを自動起床し、終了コード・ログパス・ログ末尾 40 行を通知する。monitor プロセスは `detached`（POSIX で setsid(2) 相当。macOS でも外部 `setsid` 不要）で自分のプロセスグループを持ち、ターン終了・エンジンの group kill・gateway 再起動を生き延びる。exactly-once 保証（O_EXCL claim ＋ dedupeKey ＋ sqlite トランザクション）、タイムアウト時のプロセスツリー kill、状態ファイル（`~/.ryoko/jobs/`）による孤児検知付き。`ryoko job list` で一覧。
- **notification 起床ターンの返信を元の会話へ配信**: `POST /api/sessions/:id/message` (`role: notification`) で起こされたターンの最終回答を、セッションの reply_context から元の Slack チャンネル / スレッドへ配信（disposition trailer の除去も同経路で担保）。gateway 再起動後の復元にも対応。配信失敗はセッションに永続記録され、無言の放置にならない。notification role は loopback 限定（外部から任意セッションを起こす口は作らない）。
- **system prompt の更新**: Process lifetime セクションの第一選択を `ryoko job run`（実セッション ID 埋め込み）に更新。起こされないまま終わったジョブ（notify_failed / orphaned）は次ターンの context に自セッション分のみ注入され、「起こされないまま放置」を構造的に防ぐ。

## [2026.8.4] - 2026-08-04

### Fixes
- **バックグラウンドタスクの寿命を system prompt で警告 (#38)**: one-shot エンジンプロセスのターン終了でバックグラウンドタスクがプロセスグループごと無言で死ぬ問題への予防策。`## Process lifetime` セクション（ESSENTIAL）を注入し、フォアグラウンド待機 / 切り離し手順（Linux: setsid、macOS: nohup+disown）/ 検証してから完了報告、を案内。interactive PTY セッションには persistent 変種を出し分け。
- **Slack sendMessage が target.thread を無視する非対称を解消 (#6)**: `explicitThread` ヘルパーで `/send`・proxy (`action: sendMessage`)・Slack コネクタの 3 経路を統一。proxy 経由の全コネクタで thread 指定がスレッド返信として配送されるようになった。
- **PTY レーステストの claude-oauth-gate 依存を解消**: 環境依存で落ちていたテスト 5 件を安定化。

## [2026.7.26] - 2026-07-25

> 2026.7.25 と同日の追加リリース（npm は同一 version の再 publish 不可のため番号を +1。2026.7.4 / 2026.7.5 が同日リリースだった前例に倣う）。

### Fixes
- **Claude→Codex フォールバック時のモデル引き継ぎバグ**: Claude の usage limit で Codex にフォールバックする際、Claude セッションのモデル ID（`sonnet` / `claude-opus-5` 等）をそのまま `codex exec --model` に渡して即 exit 1 になっていた。フォールバック実行は Codex 側の設定既定モデルを使い、セッション行の model はフォールバック中 null にクリア（`engineOverride.originalModel` に退避し、Claude 復帰時に復元）。復帰判定を純粋関数 `computeEngineOverrideRevert` に切り出し回帰テスト5件を追加。

## [2026.7.25] - 2026-07-25

### Features
- **Claude Opus 5 対応（`claude-opus-5`）**: Claude 既定モデルを `opus`（裸エイリアス）→ `claude-opus-5`（明示 ID）に更新（config-patch 同梱、カスタム値は保護・冪等）。裸の `opus` エイリアスはインストール済み Claude CLI が知る最新 Opus 止まりで、CLI が古いと Opus 4.8 に留まるため、明示 ID に統一（Codex の `gpt-5.6-sol` 統一と同じ方針）。Opus 5 は Opus 4.8 と同額（$5/$25 per MTok）・1M コンテキスト・128K 出力・effort 全レベル（low〜max）対応。設定画面の Claude モデル選択肢に Opus 5（既定）/ Opus 4.8（ピン留め用）/ opus（CLI 自動追従）を追加。`claudeSupportsXhigh` は既存の `opus-5` パターンで対応済みのためコード変更なし。
- **コスト価格表の修正**: Opus 5 の価格（$5/$25）を追加し、Opus 4.8/4.7/4.6 の誤った旧値（$15/$75 = Opus 4.1 世代の価格）を公式価格 $5/$25 に修正。

## [2026.7.10] - 2026-07-10

### Features
- **Slack 決定的メンションゲート（`connectors.slack.respondTo`）**: DM / グループDM / チャンネルごとに `always | mention | never` の応答ポリシーを指定可能に。LLM トリアージの**前段**で決定的に評価されるため、「チャンネルではメンション以外に絶対発言しない」を保証できる（トリアージは確率的で、DM-equivalent 高速パスは一度返信した相手にメンションなしで応答し続けるため、この保証を与えられなかった）。`engagedThreads: true`（既定）で bot が返信・リアクション済みのスレッド内は再メンション不要（メンション1回→以降は自然な会話）。未設定なら従来どおり全メッセージに応答（完全後方互換）。落とすメッセージのコストはゼロ（ネットワーク取得・LLM 呼び出しの前に判定）。botUserId 未解決時は fail-closed（勝手な発言をしない側に倒す）。設定 UI・README・template docs にも反映。顧客要望（チャンネル招待のたびに「メンション以外では発言しないで」と書き込む運用の解消）由来。
- **GPT-5.6 対応（Sol / Terra / Luna 3ティア）**: Codex 既定モデルを `gpt-5.5` → `gpt-5.6-sol` に更新（config-patch 同梱、カスタム値は保護・冪等）。設定画面のモデル選択に 3 ティア（松竹梅: Sol 上 / Terra 中 / Luna 小）を追加。**注意: 裸の `gpt-5.6` エイリアスは ChatGPT アカウントの Codex では 400 エラーになるため、明示 ID（`gpt-5.6-sol` 等）に統一**（2026-07-10 実機検証: 明示 ID は 3 ティアとも ChatGPT アカウントで動作確認済み）。
- **モデル選択 UI の刷新**: 空気読みトリアージ / Goal 判定のモデルをフリーテキスト入力からプルダウン選択に変更（エンジン連動で Anthropic / OpenAI 系を表示、「自動（エンジン既定）」も選択可、手入力済みの値は「（現在の設定）」として保持）。モデル一覧は `packages/web/src/lib/model-catalog.ts` に単一情報源として集約。

## [2026.7.5] - 2026-07-02

### Fixes（話者誤認 — 他人を operator と勘違いする問題）
- **operator 照合の正規化**: `portal.operatorName`（例:「亮介」）と話者のプロフィール名（「泉水亮介」「Ryosuke Sensui」「rsensui」）の照合が**完全一致**だったため、operator 本人すら毎ターン「⚠ NOT the operator」と誤マークされ、警告が狼少年化 → 本物の第三者への警告も無視される状態だった。共通の照合関数（NFKC正規化+大小無視+2文字以上の部分一致）に差し替え、システムプロンプトの identity/セッション両ブロックと Slack トリアージの operator 判定を統一。`portal.operatorAliases: []` で明示エイリアスも指定可能に。
- **メッセージ単位の話者アノテーション**: グループ会話ではエンジンへ渡す各メッセージの先頭に `[Speaker: ◯◯ — NOT the operator; …]` を付与。スレッドに複数人が参加しても・warm PTY 再利用でシステムプロンプトが古くても・長い会話履歴の惰性があっても、**毎ターン**誰が話しているかを明示。DM（1:1で自明）・cron・スラッシュコマンド（ネイティブコマンド検出を壊さない）は対象外。

## [2026.7.4] - 2026-07-02

### Features（upstream jinn 0.20〜0.23 から安定性4点セットを移植）
- **StopFailure grace window（20秒）**: `server_error`/`invalid_request`/`unknown` 系の StopFailure を即失敗確定せず猶予保留。CLI が自力リトライして完走すれば後続の Stop が**成功で上書き**、ツールフック/SSE活動で猶予を再アーム、**サブエージェントのAPIリクエストが in-flight の間は失敗確定を延期**（サブエージェントのAPIエラーが親ターンを誤って失敗させる問題の根本修正）。`rate_limit`/`billing_error`/`authentication_failed`/`max_output_tokens` は従来どおり即確定。
- **Lost-Stop recovery**: Stop フック自体が消失した場合（relay障害・gateway.json 差し替え等）、5分経過+60秒静穏+ツール/API非実行を条件に、**transcript から最終アシスタントメッセージを復元してターンを成功確定**。ターン終了後に結果テキストが空だった場合の transcript バックフィルも追加（「(no output)」返信の解消）。
- **status-reconciler**: `status:"running"` のままスタックしたセッションを15秒ごとにスイープし、ハートビート45秒超過+実ターンなしを**2回連続**確認したら idle に自動復旧（完了イベント喪失の最終バックストップ）。transient retry の待機中は20秒ごとのハートビートで誤検知を防止。
- **ネイティブコマンド処理**: `/compact`/`/clear`/`/model` 等（Stopフックを発火しない）は出力静穏ウィンドウで完了確定、`/usage`/`/limits` 等（Stop の last_assistant_message が**前ターンのテキスト**を載せてくる）は空で確定し、重複エコーの再投稿を防止。
- その他: 思考ブロック（`<thinking>`等）が最終テキストに漏れた場合の除去、bracketed-paste 後の CR を 50ms→150ms（ペースト未消化で送信が落ちるレースの解消、upstream知見）。

### Tests
- jimmy: 562 tests pass（grace window の保留/上書き/再アーム/延期、transcript 復元ヘルパー、status-reconciler の2スイープ確定、ネイティブコマンド判定・空確定の回帰テストを追加）。

## [2026.7.3] - 2026-07-02

### Fixes（空気読みトリアージ — 「スタンプだけ返す」が機能しない問題）
- **DM / DM-equivalent 高速パスの短文ack例外**: react 判定が最も刺さる状況（Ryoko の返信直後の「ありがとう」「了解」）は、DM では無条件スキップ・チャンネルでは bot が返信した時点で会話が DM-equivalent 化してトリアージを恒久スキップするため、**構造的に react に到達できなかった**（実測: 30日間で skip 333件 vs トリアージ実行 248件、フルエンジン側の disposition trailer は導入以来 0 件使用）。短いメッセージ（30文字以下・疑問符/URL/メンション/添付なし）は DM でも DM-equivalent でもトリアージに回すように。@メンション付きは従来どおり常にフル返信。
- **1:1 モードのトリアージプロンプト**: この例外パスでは判定空間を react / reply の二択に限定（silent = 無視は禁止）。「GO」「続けて」「はい」（bot の質問への返答）等の続行指示は reply に誘導し、誤スタンプで作業が止まらないようにガード。トリアージ失敗時のフォールバックも従来のフル返信（ghosting なし）。

## [2026.7.2] - 2026-07-02

### Fixes（インタラクティブエンジンの耐障害性 — 「server error で失敗」「返事が返ってこないまま終わる」対策）
- **Anthropic サーバーエラー (5xx/529) の自動リトライ**: `Interactive turn failed: server_error`（CLI が数分の内部リトライ後に諦めたケース）でターンを即エラー確定せず、バックオフ付き（既定 30s→2m→5m、`sessions.transientRetryDelaysMs` で調整可）で**同一エンジンセッションを resume して続行**するように。Slack には自動リトライ中である旨を一度だけ通知。障害が続いた場合のみ従来どおりエラーを報告。
- **バックグラウンド完了の配送（孤児 Stop フック）**: ターン確定後にサブエージェント／バックグラウンドタスクが完走して発火する Stop フックは、従来 30 秒バッファ後に**破棄**され、最終成果がどこにも届かなかった。孤児 Stop をセッションの会話（Slack スレッド等）へ配送し、親セッションにも完了通知（`notifyParentSession`）するように。`sessions.backgroundDelivery: false` で無効化可。あわせて、古い Stop が次ターンのリゾルバに流れ込み**前ターンのメッセージで即確定してしまう**バッファ競合も解消（terminal な孤児はバッファしない）。
- **作業中 PTY の保護**: keep-warm リーパー（ターン終了 10 分後に SIGTERM）と LRU 追い出しが、バックグラウンド作業中の PTY を殺して作業を無音で打ち切っていた。SSE プロキシの in-flight リクエスト／直近アクティビティと孤児フック受信を生存シグナルとして、**実際に動いている PTY は回収しない**ように。
- **ターン watchdog の誤爆防止**: 90 分のターン上限（`interactiveTurnTimeoutMs`）は「ハングしたターン」検出のためのものだが、長時間の正当な自律バッチも殺していた。エンジンが実際に活動中（API リクエストが流れている）の間はタイムアウトを発火しないように（真にハングした PTY は活動が止まるため従来どおり回収される）。

### Tests
- jimmy: 534 tests pass（孤児フックの配送/バッファ挙動、busy PTY の reaper/LRU 保護、`touch()` の grace 更新、SSE プロキシ in-flight 追跡、`isTransientServerError` 判定の回帰テストを追加）。

## [2026.7.1] - 2026-07-01

### Features
- **Claude Sonnet 5 対応**: `sonnet` エイリアスが解決する新モデル `claude-sonnet-5` をコスト推定表（headless / interactive 両方）と設定画面のモデル表記に追加。コンテキスト窓は既存の `sonnet` パターン一致で 1M に解決。
- **Claude の effort デフォルトを `xhigh` に**: Sonnet 5 / Opus 4.7・4.8 が対応した `xhigh` を標準化。設定画面の Effort Level に「Extra High」を追加。合成レジストリはモデル能力に応じて `xhigh` の可否を判定し（Opus 4.7+ / Sonnet 5 のみ）、Haiku や旧 Opus/Sonnet では `resolveEffort` が安全に `medium` へクランプ。
- **決定論的 config パッチ機構**: マイグレーションに `config-patch.json` を同梱すると、`ryoko update`（`ryoko migrate --auto`）が config.yaml のデフォルト値を**ユーザーのカスタマイズを壊さずに**追従更新（未設定→挿入 / 旧デフォルト一致→更新 / カスタム済み→スキップ、冪等）。2026.7.1 では `engines.claude.effortLevel: medium → xhigh` を適用。

### Fixes
- **interactive Claude のコスト計上**: エイリアス（`sonnet` 等）ではなくトランスクリプトの実モデルID（`claude-sonnet-5` 等）で料金を解決するようにし、Sonnet/Haiku が Opus 価格で過大計上される問題を修正。

### Tests
- jimmy: 521 tests pass（config パッチのセマンティクス・冪等・カスタム保護、出荷 patch の妥当性検証、モデル別 effort 能力判定の回帰テストを追加）。

## [2026.6.5] - 2026-06-03

### Features
- **設定画面に「インタラクティブPTY（Max定額）」トグル**: ダッシュボードの「エンジン設定」から `engines.claude.interactive` を確認・切替できるように（CLI を使わずに済む）。保存後はゲートウェイ再起動で反映。
- **Claude Opus 4.8 対応**: `opus` エイリアスは Claude CLI が最新 Opus に解決するため既定で 4.8 を使用。設定画面のモデル表記を `claude-opus-4-8` に更新し、コスト推定表に `claude-opus-4-8` を追加（旧 ID も履歴セッションのコスト再構築用に保持）。

### Tests
- jimmy: 452 tests pass（`PUT /api/config` の deep-merge が interactive フラグを設定しつつ connector secret/他フィールドを保持することの回帰テストを追加）。

## [2026.6.4] - 2026-06-03

### Features
- **インタラクティブモードのセットアップ・プロンプト**: `ryoko setup` / `ryoko update` で、Claude をインタラクティブ PTY（Max 定額課金）で動かすか対話で選べるように。TTY のときのみ・未設定のときのみ尋ね、CI/cron ではスキップ。`update` では再起動前に尋ねるので選択が即反映されます。
- **`ryoko config interactive [on|off]`**: ダッシュボード不要で `engines.claude.interactive` を確認・変更できる CLI。設定の書き込みは行ベースで config.yaml のコメント・整形を保持し、`engines.claude` ブロックにスコープ限定（他セクションの同名キーを誤爆しない）。

### Tests
- jimmy: 450 tests pass（`interactive-config` の行ベース編集・ブロックスコープ・各値形式の回帰テストを追加）。

## [2026.6.3] - 2026-06-03

本家 jinn の engine sprint からの移植 + 独自堅牢化。

### Features
- **Interactive Claude PTY エンジン（オプトイン）**: `config.engines.claude.interactive: true` で、Claude の作業ターンを headless `claude -p`（API 従量課金）ではなく**インタラクティブ PTY**（`cc_entrypoint=cli`）で実行。Max サブスクリプション課金になり API 課金を回避します。ターン解決は Claude Code の Stop フックを per-session `--settings` で登録し、`hook-relay.mjs` が loopback の `POST /api/internal/hook`（secret 認証）へ転送 → `HookRegistry` → `TurnResolver` で解決。既定は従来の `claude -p`。`sshHost` 従業員は PTY 不可のため headless `-p` フォールバックへ委譲。新規依存 `node-pty`。
- **ライブ xterm CLI ビュー**: `/ws/pty/:sessionId` WebSocket でセッションの PTY をブラウザの xterm に直結（`@xterm/xterm`）。`/api/status` の `engines.claude.interactive` で UI が live xterm / poll transcript を切替。
- **コンテキストメーター**: codex / claude 両エンジンで直近ターンの入力コンテキスト量（input + cache）を計測・永続化（`sessions.last_context_tokens`）し、Web にバッジ表示。

### Fixes
- **Slack リアクション承認（古いメッセージ）**: boot-replay ガードをリアクションの `event_ts` で判定するよう変更し、数時間待った承認カードへの新規リアクションが落ちる問題を解消。`:eyes:` 即時 ack を追加（本家 v0.17.1 相当）。

### Hardening / Security
- Interactive エンジンに**ターンタイムアウト**（既定 15 分, `interactiveTurnTimeoutMs`）を追加し、ハングした PTY がセッションをゾンビ化しないように。
- 起動時に `seedTrust(~/.claude.json, JINN_HOME)` で PTY 起動 claude の trust ダイアログを回避。
- `/ws` / `/ws/pty` の upgrade に host ガード、`/ws/pty` に Origin allowlist（stdin 注入対策）、sessionId の `decodeURIComponent` を try/catch 化。

### Tests
- jimmy: 442 tests pass（PTY ライフサイクル / hook registry+endpoint / SSE proxy / claude-interactive / SSH フォールバック / claude-settings 等を移植・追加）。

## [2026.5.29] - 2026-05-29

### Features
- **`ryoko update --restart`**: CLI 更新（＋マイグレーション）の後にゲートウェイを自動再起動するオプションを追加。再起動先は systemd `--user` ユニット → systemd system ユニット（既定名 `openryoko`）→ フォークデーモン（PIDファイル/ポート）の順に自動検出します。system ユニットへ直接 `systemctl restart` する権限が無い場合は `sudo -n` を試行し、それも不可なら手動コマンドを案内します。何も起動していなければ何もしません（`none`）。既定の `ryoko update` は従来どおり再起動しません（安全側のオプトイン）。
- **`ryoko update --service <name>` / `RYOKO_SERVICE`**: 再起動する systemd ユニット名を上書き可能に（既定 `openryoko`）。Linux 以外では systemd 検出をスキップしデーモン経路のみ。

### Tests
- jimmy: 32 files / 377 tests pass。
- `restartGateway()` の検出ロジック（systemd user/system、sudo フォールバック、権限拒否、サービス名上書き、デーモン再fork、none、非Linux）の回帰テスト（`restart.test.ts`）を追加。

## [2026.5.28] - 2026-05-28

### Features
- **Slack Assistant「新しいチャット」= 新セッション**: Assistant（Agents & AI Apps）の各チャットが持つ `thread_ts` ごとに独立した DM セッションを張るようにしました。「新しいチャット」を押すと、その時点の `engines.default` で新規セッションが始まります（従来は DM 全体が1セッションに合流し、最初に作られたエンジンに固定され続けていました）。`thread_ts` の無い素の DM は従来どおり1ユーザー1セッションを継続。`buildReplyContext` も threaded DM では当該スレッドに返信するよう変更。
- **Slack App manifest: Assistant 機能をデフォルト ON**: Settings のコピペ用 manifest に `features.assistant_view` ＋ `assistant:write` scope ＋ `assistant_thread_started` / `assistant_thread_context_changed` events を既定で含め、新規アプリでも「新しいチャット」が即使える状態にしました。
- **manifest の bot 名テンプレート化**: manifest の `display_information.name` / `bot_user.display_name` を設定済みの bot 名（`portalName`）から生成。未設定時のみ "Ryoko"。

### Fixes
- **Slack slash commands in threads**: スレッド内（および thread context 付きメッセージ）で `/new` `/status` `/model` `/doctor` `/cron` が無視されていた問題を修正。connector が付与する「[Thread context — parent message: …]」プリアンブルでコマンドが先頭から押し出され、エンジンに素通りしていたのが原因。生のユーザーテキストでコマンド判定し、コマンド時はプリアンブルを付けないようにしました（`SLASH_COMMANDS` / `startsWithSlashCommand()` を共有ヘルパー化）。特に `/new` が効かずスレッドが元エンジンを再開し続ける問題を解消。
- **Codex interim narration leak**: Codex エンジンの `text` イベントは（streaming delta ではなく）`item.completed` の完成済み agent_message を運ぶため、全て連結すると gpt-5.5 の中間進捗（例「まず boot ファイルを確認します」）が本回答の前に混ざっていました。最新の agent_message のみを結果として採用するよう修正（途中経過は従来どおり onStream で表示）。Gemini の delta 蓄積は正しいので不変更。
- **Agents View Canvas self-disable**: canvas 作成失敗（`canvas_tab_creation_failed` 等）時に 30s ごとへ無限リトライしてログと Slack API を叩き続ける問題を修正。連続 tick 失敗を数え、10回連続（既定間隔で約5分）で ERROR ログを出してループ停止。成功でカウンタはリセットするので一時的障害では止まりません。

### Improvements
- **Slack 受信ログ**: inbound メッセージのログに `channel_type` / `thread_ts` / `subtype` を出力し、スレッド / Assistant 周りの切り分けをしやすくしました。

### Tests
- jimmy: 31 files / 369 tests pass。web: typecheck pass。
- per-thread DM keying と reply context の回帰テスト（`threads.test.ts`）を追加。
- slash command の thread-context 内検出（`slash-commands.test.ts`）、Codex interim narration（`codex.test.ts`）、Agents Canvas 連続失敗時の self-disable（`agents-canvas.test.ts`）の回帰テストを追加。

## [2026.5.22] - 2026-05-22

### Features
- **Slack air-reading triage on Codex**: 空気読みトリアージの one-shot 判定を Claude だけでなく Codex でも実行できるようにしました。デフォルトは軽量な `codex` + `gpt-5-nano` です。
- **Goal extraction controls**: Slack の自然言語 goal 判定を `connectors.slack.goalExtraction.enabled` でオン/オフ可能にしました。遅延が目立つためデフォルトはオフです。
- **Web UI settings**: Settings 画面から Slack triage / goal extraction の engine、model、timeout、bin override を設定できるようにしました。

### Fixes
- **Slack threaded replies**: connector `/send` に `thread` がある場合は threaded reply として送信し、顧客向け返信がチャンネル直下に裸で投稿される事故を防ぎます。
- **Current conversation duplicate guard**: gateway MCP の `send_message` が現在会話へ投稿しようとした場合は拒否し、最終回答で返すよう促します。実返信と内部ナレーションの二重投稿を防ぎます。
- **Codex goal guard**: `/goal` は Claude 専用として扱い、Codex セッションでは実行しないようにしました。
- **Agents View Canvas**: `canvases.edit` 失敗時に無条件で Canvas ID を破棄していた挙動を修正。Slack API の恒久的な edit エラーで次回 tick が新規 Canvas 作成に戻り、Canvas が増殖する問題を防ぎます。Canvas が削除済み/見つからない場合だけ再作成します。
- **Migration auto mode**: `ryoko migrate --auto` が既存ファイルを skip した場合、version stamp と cleanup を行わないようにしました。未マージの重要テンプレートがあるのに最新版扱いになる問題を防ぎます。
- **Migration CLI copy**: `ryoko migrate` の表示と migrate skill の説明に残っていた `.jinn` / `jinn migrate` 表記を `.ryoko` / `ryoko migrate` に更新。
- **Version migration ordering**: `2026.5.7` のような OpenRyoko CalVer migration を、歴史的な `0.x.y` migration と同じ3セグメント数値版として正しく比較・ソートします。
- **Cost tests isolation**: gateway cost tests が実ユーザーの runtime DB を触らないよう、テスト用 DB に隔離しました。

### Improvements
- **2026.5.7 migration payload**: persona / memory layer の新規・更新テンプレートを migration `files/` 配下にも同梱し、AI migration がコピーまたはマージしやすい形にしました。

### Tests
- jimmy: 28 files / 347 tests pass。
- web: typecheck pass。
- Agents View Canvas の edit 失敗時に Canvas を重複作成しない回帰テストを追加。
- CalVer migration ordering の unit test を追加。
- Slack triage / goal extraction の Codex one-shot 実行と、goal extraction デフォルトオフの回帰テストを追加。

## [2026.4.30] - 2026-04-30

### 🐛 Fixes
- **Slack triage**: conversations now skip triage as soon as the bot has engaged AND only one human is speaking — scoped per-thread for threaded replies, and per-`(channel, user)` for non-threaded follow-ups. The decision is permanent until a third human joins (no TTL). Closes the silent-drop class of bugs where a bot+1 private channel was classified as `channel` and slow Haiku triage caused real user messages to be ignored, and also fixes the same problem for users who don't reply in threads. Replaces the old 10-minute `ActiveThreadTracker` window and the channel-membership-based DM-equivalent detector.
- **Slack triage**: bumped `DEFAULT_TIMEOUT_MS` from 8s to 30s. Real-world Haiku one-shot calls land at 5–9s in normal conditions and spike higher on slow API days; the 8s default was producing routine timeouts. Operators can still override via `connectors.slack.triage.timeoutMs` in `config.yaml`.

### 🗑 Deprecated
- `connectors.slack.triage.activeThreadTtlMs` — no longer used. Engagement is tracked permanently per-conversation now. The field is still accepted for backwards compatibility but has no effect.

## [2026.4.28] - 2026-04-28

### ✨ Features
- **`ryoko update`** — `npm install -g openryoko@latest` と `ryoko migrate --auto` を1コマンドで実行できるようにしました。`--no-migrate` でCLI更新だけも可能です。

## [2026.4.27] - 2026-04-27

### 🐛 Fixes
- **Slack typing indicator** — Slack の `assistant.threads.setStatus` を90秒ごとに更新し、長時間のエンジン実行中も「入力中...」表示が消えにくいように変更。
- **Slack status diagnostics** — typing status API の失敗を `warn` ログに出し、`missing_scope` / `no_permission` / `invalid_thread_ts` などの原因を確認しやすくしました。

## [2026.4.26] - 2026-04-26

### 🚀 リモートサーバー (Linux/systemd) 運用での詰まりポイントを一掃

VPS等で常駐させようとした初期ユーザーが踏んだ4つの落とし穴を全部潰しました。

#### 🐛 Fixes
- **`spawn claude ENOENT` (systemd配下)** — エンジン (Claude/Codex/Gemini) およびSlackトリアージのCLI起動を、起動時に純JSのPATH探索 (`shared/resolveBin.ts`) で絶対パス化するように変更。systemdの最小PATHでも動作。解決失敗時はインストールコマンド付きの親切なエラーを返す。
- **rootユーザーでClaude CLI拒否** — `shared/childEnv.ts` でuid==0検出時に `IS_SANDBOX=1` を自動付与しバイパス。同時に「root実行は非推奨、専用ユーザーを推奨」の警告ログを一度だけ出力。
- **WebUI Settingsで Slack トークン保存しても繋がらない** — `PUT /api/config` および `chokidar` watcher が、`connectors` または `portal.portalName/operatorName` の差分を検知すると `reloadAllConnectors()` を呼んでトップレベル＋インスタンスSlack/Discord/Telegram/WhatsAppコネクタを再接続。デーモン再起動不要。partial失敗 (例: 不正トークン) はUIにエラー表示。
- **クラッシュ後の自動復旧なし** — `scripts/systemd/openryoko.service` テンプレと `scripts/systemd/install.sh` を追加。`Restart=on-failure` + `RestartSec=5` で自動復旧。インストーラはユーザーの実シェル (bash/zsh/fish) でPATHを自動検出してunit fileに焼き込む。

#### 🏗️ Infrastructure
- `engines.node: ">=22"` を root / `packages/jimmy` / `packages/web` の package.json に明示。
- READMEに「🖥️ Linux サーバーで常駐させる (systemd)」セクションを追加。
- `SessionManager.setConfig()` / `setConnectorNames()` を追加 — config再読み込み時にセッションが boot 時の値を引きずる問題を解消。
- 連結器reloadを single-flight 化 (`reloadInFlight` mutex + pending coalescing) — 並行reload時の二重起動を防止。
- 連結器の停止 (`stop()`) が失敗した場合、参照を破棄せず手動再起動を案内 — 二重ライブクライアントによる重複応答を防止。
- API経由のconfig書き込み時に watcher の重複reloadを抑制 (`suppressNextConnectorReload`)、partial失敗時は抑制を解除して chokidar の retry チャンスを残す。

#### 🔒 Security
- `resolveBin` で `command -v ${bin}` のシェル展開を撤廃し、純JSの `process.env.PATH` 走査に置換。`engines.*.bin` を `PUT /api/config` 経由で書き換えられるため、シェルメタ文字を含む値で任意コマンド実行できてしまう脆弱性を修正。
- 同時に bin 名に `/`, `\`, NULL バイトを含む値を拒否 (path traversal 防御)。

#### ✅ Tests
- 新規: `shared/__tests__/resolveBin.test.ts` (絶対パス・PATH解決・コマンドインジェクション耐性)、`shared/__tests__/childEnv.test.ts` (root検出と IS_SANDBOX 注入)、`sessions/__tests__/manager-connector-names.test.ts` (setConnectorNames)
- jimmy: 23 files / **275 tests**、web: 7 files / 61 tests、すべて pass。

## [0.9.4-ryoko.2] - 2026-04-22

### 🐛 Fixes
- **Slack triage**: shared-channel barge-in fix — triage errors in ambient messages now fail silent (not reply) when `botUserId` is known, and explicit `<@other-user>` mentions are early-skipped regardless of thread activity. Breaks the cascade where one fail-open reply would mark a thread "active" and cause follow-ups to bypass triage for 10 minutes. ([#slack-triage](https://github.com/rsensui2/OpenRyoko/commit/61a010c))
- **Web chat input (IME)**: Enter during Japanese/Chinese/Korean IME composition no longer submits the message. Fixes split-message bug where confirming an IME conversion sent partial text. (#1, thanks @htpboost)

## [0.7.0] - 2026-03-19

### ✨ Features — Project Phoenix
- **Chat tabs** — Cmd+W close, Cmd+Shift+[/] switch, draft persistence, status indicators
- **Command palette** — cmdk-powered Cmd+K with actions, recents, sessions, skills search
- **Breadcrumb navigation** — context-aware breadcrumbs on all pages
- **ChatPane extraction** — reusable chat component decoupled from page
- **Enhanced sidebar** — expandable employee groups, pin/unpin, context menu, hover actions
- **React Query data layer** — query key factory, hooks for all resources, WS→cache invalidation bridge

### 🔧 Improvements
- **Tailwind migration** — 640→120 inline styles (81% reduction), shadcn token system
- **Header consolidation** — single 40px tab bar replaces 3 stacked headers on chat
- **Mobile UX** — more menu in top header, clean tab bar, responsive sidebar
- **Session state sync** — tabs and selected session stay in sync
- **Instant tab switching** — no scroll flash, useLayoutEffect for immediate scroll

### 🏗️ Infrastructure
- Goals CRUD API + SQLite table (backend, for future use)
- Cost aggregation API + budget enforcement system
- Mock engine for E2E tests
- Vitest setup (api + web), Playwright config, GitHub Actions CI workflow

### 🧹 Cleanup
- Removed: split view, goals/costs pages (no backend yet), 14 unused shadcn components
- Fixed: dual-fetch anti-pattern in sidebar, session delete via mutations
- Net: 81 files changed, +5,608 / -8,723 lines

## [0.3.0] - 2026-03-10

### 🔧 Improvements
- Codex engine now runs with `--dangerously-bypass-approvals-and-sandbox` — prevents Jimmy-managed Codex sessions from being constrained by CLI sandbox/approval defaults

## [0.2.0] - 2026-03-10

### ✨ Features
- Connector abstraction layer — connectors declare capabilities (threading, reactions, edits, attachments) and health status
- `replyMessage()` vs `sendMessage()` split — proper thread-aware message routing
- CronConnector — cron jobs are now message sources routed through SessionManager (unified flow)
- Slack config options — `shareSessionInChannel`, `allowFrom` whitelist, `ignoreOldMessagesOnBoot`
- Transport state tracking — new `transportState` field + queue depth visibility
- In-chat slash commands — `/cron list|run|enable|disable`, `/model <name>`, `/doctor`
- Runtime cron control — trigger/enable/disable jobs without restart
- Web UI: Slack settings toggles for new config options
- Web UI: Transport visibility — connector name, queue depth, transport state badges

### 🔧 Improvements
- Unified message routing — all sources flow through `SessionManager.route()` with uniform `IncomingMessage`
- Cron runner simplified — ~35% code reduction by delegating to SessionManager
- Capability-aware decorations — reactions/edits conditional on connector capabilities
- Config token masking — Slack tokens masked in `GET /api/config`
- Session queue monitoring — `getPendingCount()` and `getTransportState()`

### 🏗️ Infrastructure
- Build pipeline — web UI bundled into gateway dist
- Test suite — threads, queue, and registry tests using Node.js native test runner
- DB migration — auto-adds connector/transport columns, backfills from legacy fields

### 💥 Breaking Changes
- `Connector` interface expanded with new required methods: `replyMessage()`, `getCapabilities()`, `getHealth()`, `reconstructTarget()`
- `IncomingMessage` and `Session` types have new required fields
- `GET /api/connectors` response shape changed from `string[]` to objects with capabilities
- `startScheduler()` now takes `SessionManager` instead of engine map
- `sendMessage()` no longer posts to threads — use `replyMessage()`

## [0.1.1] - 2026-03-09

### 🐛 Bug Fixes
- Remove `@jinn/web` workspace dependency from published package — was causing `unsupported URL type "workspace:"` error on `npm i -g jinn-cli` (web UI is embedded as static files during build, not a runtime dependency)

### 🔧 Improvements
- Claude engine now runs with `--dangerously-skip-permissions` — prevents sessions from hanging on tool approval prompts in headless mode

## [0.1.0] - 2026-03-09

First release of the Jinn AI gateway platform.

### ✨ Core Platform
- Gateway server with HTTP REST API + WebSocket real-time events
- Session manager with context builder (32K char budget, progressive trimming)
- SQLite session registry with WAL mode
- Per-session serial execution queue
- File watchers for hot-reload (config, cron, org, skills)
- Daemon lifecycle management (start/stop/status as background process)
- Multi-instance support with dynamic home directory resolution

### ✨ Engines
- Claude Code CLI engine wrapper (spawn, JSON streaming, session resume)
- Codex SDK engine wrapper (in-process, streaming)
- Model/effort level passthrough and configuration

### ✨ CLI
- `jinn setup` — bootstrap ~/.jinn/ from templates
- `jinn start` / `stop` / `status` — daemon management
- `jinn create` / `list` / `remove` — instance management
- `jinn nuke` — permanent instance deletion with safety prompts
- `jinn migrate` — AI-assisted template migrations
- `jinn skills` — skill discovery + skills.sh integration
- `--port` flag for custom port binding

### ✨ Connectors
- Slack connector (Socket Mode via @slack/bolt)
- Thread/DM/channel source-ref mapping
- Reaction workflow (👀 → ✅/❌)
- Message splitting for long responses
- Attachment download support

### ✨ Organization System
- Employee personas (YAML) with departments, ranks, engine assignment
- Org scanner with @mention routing
- Department boards for inter-agent task tracking
- Rich employee identity + generic connector context
- Dynamic COO naming via onboarding

### ✨ Skills System
- Markdown-based skill playbooks (SKILL.md with YAML frontmatter)
- 10 built-in skills: management, cron-manager, skill-creator, self-heal, onboarding, migrate, sync, status, new, find-and-install
- Skill symlink syncing to .claude/skills/ and .agents/skills/
- skills.sh marketplace integration
- Skills directory watcher with WebSocket change events

### ✨ Cron System
- node-cron scheduler with hot-reloadable jobs.json
- Run logging to JSONL files
- Delegation pattern (cron → COO → employee → review → deliver)
- Optional delivery to connectors

### ✨ Web UI
- Full Next.js 15 static dashboard
- Chat interface with voice recording, file attachments, rich markdown
- Session browser with detail view
- Org map (React Flow) with grid/feed views + employee detail panels
- Kanban board with drag-drop, tickets, employee assignment
- Cron visualizations — weekly schedule heatmap, pipeline grid
- Cost dashboard with charts, anomaly detection, WoW comparison
- Activity console with log browser + floating live stream widget
- Global search (Cmd+K)
- Settings page + onboarding wizard
- 5-theme CSS system with accent color support
- shadcn/ui components

### ✨ Session Context
- Rich context injection (identity, CLAUDE.md, config, org, skills, cron, connectors, API reference)
- Local environment awareness
- Lazy onboarding (stub session)

### 🏗️ Infrastructure
- pnpm + Turborepo monorepo
- TypeScript throughout
- Web UI bundled into CLI package
- CI workflow (GitHub Actions)
- README, CONTRIBUTING guide, LICENSE
