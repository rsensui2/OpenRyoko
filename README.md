# 🐕 OpenRyoko

Slackで空気を読んで働くAIゲートウェイ。必要なときだけ発言し、雑談には入らない。Claude Code / Codex / Gemini CLI を統合するデーモン型のアシスタント基盤です。

> OpenRyokoは [Jinn](https://github.com/hristo2612/jinn)（MIT License, by Hristo Stoyanov）をベースにした日本語ファーストの派生版です。

<p align="center">
  <img src="assets/ryoko-avatar.png" alt="Ryoko" width="240" />
</p>

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="OpenRyoko Web Dashboard" width="800" />
</p>

## 🐕 OpenRyokoとは

OpenRyokoは、Claude Code CLI / Codex SDK / Gemini CLI をひとつの常駐デーモンにまとめ、Slack等のチャンネルに「AI同僚」として配置できるゲートウェイです。OpenRyokoはバス（導管）であり、脳ではありません — 知能はラップするCLI側に任せ、OpenRyokoは「どこに流すか／誰に任せるか／いつ沈黙するか」を担当します。

### Jinn との違い（OpenRyoko独自の追加機能）

- **発言者認識**: SlackのユーザーIDからdisplay nameを解決し、operatorと混同しないように system prompt を組み立てる
- **空気読みトリアージ**: メッセージごとに軽量LLM（Haikuをデフォルト採用）で `silent / react / reply` を判定。メンションされない限り基本沈黙、自分が役に立てる話題にだけ介入
- **日本語デフォルト**: UI・CLI・設定テンプレートが日本語
- **`~/.ryoko` ホームディレクトリ**: 既存 `~/.jinn` からの自動マイグレーション付き

## 💡 なぜOpenRyokoか

### 🔑 Anthropic Maxサブスクリプションで動く

OpenRyokoはClaude Code CLIを子プロセスとして起動するため、Anthropicの公式クライアントとして扱われ、[月額$200のMaxサブスクリプション](https://www.anthropic.com/pricing)の枠内で動作します。APIトークン従量課金ではありません。

空気読みトリアージは軽量Haikuを使いますが、こちらもClaude Code CLI経由なのでMaxサブスクに含まれます（$0）。

### 🧠 「バス、脳ではない」哲学

OpenRyokoは独自のプロンプトエンジニアリング層を持ちません。Claude Codeが既にツール利用・ファイル編集・マルチステップ推論・記憶を担当しているので、OpenRyokoはそれを外の世界（Slack、cron、WebUI）に接続するだけ。Claude Codeが進化すれば、OpenRyokoも自動的に強くなります。

### 🐕 空気読み能力

「うざくならず、必要な時には出てくる」を守るため、Slackメッセージは受信時に以下のフローで判定されます：

```
受信メッセージ
  ├─ DM？               ──→ 常に返信
  ├─ @メンション？       ──→ 常に返信
  └─ グレーゾーン        ──→ 軽量LLM（Haiku）でトリアージ
                             ├─ silent → 何もしない
                             ├─ react  → 絵文字スタンプだけ付ける
                             └─ reply  → 本エンジンで返信
```

判定基準（デフォルトプロンプトより）:
- 明らかに自分宛 → reply
- 自分の専門領域で役に立てる → reply
- 単なる同意・感謝 → react（絵文字のみ）
- それ以外 → silent（雑談には絶対に割り込まない）

確信度 60% 未満なら silent に倒す保守的設計です。

## ✨ 主要機能

- 🔌 **3エンジン対応** — Claude Code CLI + Codex SDK + Gemini CLI
- 💬 **コネクタ** — Slack（スレッド・リアクション・空気読み）、WhatsApp、Discord、Telegram
- 📎 **ファイル添付** — Web チャットにドラッグ&ドロップしたファイルをエンジンへパススルー
- 📱 **モバイル対応** — サイドバー折りたたみ・モバイル向けダッシュボード
- ⏰ **Cron スケジューリング** — ホットリロード対応のバックグラウンドジョブ
- 👥 **AI組織システム** — 部門・階級・マネージャー・従業員・タスクボード
- 🌐 **Web ダッシュボード** — チャット、組織図、カンバン、コスト追跡、cron可視化
- 🔄 **ホットリロード** — config、cron、組織ファイルを再起動なしで反映
- 🛠️ **自己改変** — エージェントが自分の設定・スキル・組織を実行中に編集可能
- 📦 **スキルシステム** — エンジンがネイティブに従う再利用可能なMarkdownプレイブック
- 🏢 **マルチインスタンス** — 複数のOpenRyokoインスタンスを並列起動
- 🔗 **MCP対応** — 任意のMCPサーバーに接続

## 🚀 クイックスタート

```bash
# このリポジトリをクローンして開発インストール
git clone https://github.com/rsensui2/OpenRyoko.git
cd OpenRyoko
pnpm install
pnpm --filter "@openryoko/web" build
pnpm --filter openryoko build
npm install -g ./packages/jimmy

# 初期化
ryoko setup
ryoko start
```

ブラウザで [http://localhost:7777](http://localhost:7777) を開くとダッシュボードが表示されます。

## 🏗️ アーキテクチャ

```
                          +----------------+
                          |   ryoko CLI    |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |   ゲートウェイ  |
                          |    デーモン     |
                          +--+--+--+--+---+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                  |
      +-------v-------+ +------v------+  +-----------v---+
      |    エンジン    | |  コネクタ    |  |    Web UI     |
      |Claude|Codex|Gem| | Slack|WA|DC |  | localhost:7777|
      +----------------+ +-------------+  +---------------+
              |                 |
      +-------v-------+ +------v------+
      |     Cron      | |   組織       |
      | スケジューラ    | |  システム     |
      +---------------+ +-------------+
```

CLI がゲートウェイデーモンにコマンドを送信。デーモンがAIエンジンへ作業を振り分け、コネクタ統合を管理し、cron ジョブを実行し、Web ダッシュボードを配信します。

## ⚙️ 設定

OpenRyokoは `~/.ryoko/config.yaml` から設定を読み込みます（`~/.jinn/` が既存の場合、初回起動時に自動マイグレーション）。

```yaml
gateway:
  port: 7777

engines:
  claude:
    enabled: true
  codex:
    enabled: false

connectors:
  slack:
    app_token: xapp-...
    bot_token: xoxb-...
    # 空気読みトリアージ（メンションなしメッセージへの過剰反応を抑制）
    triage:
      enabled: true
      model: claude-haiku-4-5
      timeoutMs: 20000
      threadContextLimit: 10

cron:
  jobs:
    - name: daily-review
      schedule: "0 9 * * *"
      task: "PRをレビューして要約を投稿"

portal:
  portalName: Ryoko
  operatorName: 亮介
  language: Japanese

org:
  agents:
    - name: reviewer
      role: code-review
```

## 📁 プロジェクト構成

```
OpenRyoko/
  packages/
    jimmy/          # ゲートウェイデーモン + CLI（パッケージ名: openryoko）
    web/            # Web ダッシュボード（パッケージ名: @openryoko/web）
  turbo.json
  pnpm-workspace.yaml
```

## 🧑‍💻 開発

```bash
git clone https://github.com/rsensui2/OpenRyoko.git
cd OpenRyoko
pnpm install
pnpm setup   # 一回限り: 全パッケージビルド + ~/.ryoko 作成
pnpm dev     # ゲートウェイ + Next.js dev サーバーをホットリロードで起動
```

[http://localhost:3000](http://localhost:3000) で Web ダッシュボードが開けます。

> **前提条件:** Node.js 22+、pnpm 10+、[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`npm install -g @anthropic-ai/claude-code`）

### 主要スクリプト

| コマンド | 説明 |
| --- | --- |
| `pnpm setup` | 全パッケージビルド + `~/.ryoko` 初期化（一回限り） |
| `pnpm dev` | ゲートウェイ（`:7777`）と Next.js dev サーバー（`:3000`）をホットリロードで起動 |
| `pnpm start` | クリーンビルド後にゲートウェイを `:7777` で起動 |
| `pnpm stop` | 稼働中のゲートウェイデーモンを停止 |
| `pnpm status` | ゲートウェイの稼働状態を確認 |
| `pnpm build` | 全パッケージをビルド |
| `pnpm typecheck` | TypeScript 型チェックを実行 |
| `pnpm lint` | 全パッケージを lint |
| `pnpm clean` | ビルド成果物を削除 |

## 🔗 Jinn からの移行

既に `~/.jinn/` で Jinn を運用している場合、OpenRyoko は初回起動時に自動でディレクトリを `~/.ryoko/` にリネームします。トークン・セッション履歴・スキル・組織ファイルはすべてそのまま引き継がれます。

環境変数で古い設定を尊重することもできます：

- `JINN_HOME` — 指定パスをホームとして使用（後方互換）
- `JINN_INSTANCE` — インスタンス名指定（後方互換）
- `RYOKO_HOME` / `RYOKO_INSTANCE` — 新推奨

## 📄 ライセンス

[MIT](LICENSE)

元の著作権表記（Jimmy AI Contributors / Hristo Stoyanov）は `LICENSE` ファイルに保持されています。OpenRyoko の追加変更も同じく MIT ライセンスで提供されます。

## 🙏 謝辞

- 本体の 95% は [Jinn](https://github.com/hristo2612/jinn) のコードそのものです。素晴らしい基盤を公開してくれた Hristo Stoyanov 氏に感謝します
- Web ダッシュボードのUIコンポーネントは [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice を基礎にしています

## 🤝 コントリビュート

本リポジトリは現在、個人利用に合わせた日本語ファーストの実験的派生版です。上流 Jinn に還元できる汎用的な改善は積極的に PR を送る方針です。
