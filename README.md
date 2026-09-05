# 🌸 OpenRyoko

**Slackで空気を読み、必要な時だけ発言し、頼まれた仕事は最後までやり切る AI 同僚。**

「最後までやって」と言えば自律で動き続け、進捗は Slack の Canvas にライブ表示。
Claude Code v2.1.139+ の `/goal` Stop hook と Agent View をネイティブに Slack に橋渡しした、
**Slackファースト・日本語ファースト**の常駐AIゲートウェイです。

<p align="center">
  <img src="assets/ryoko-avatar.jpeg" alt="Ryoko" width="240" />
</p>

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="OpenRyoko Web Dashboard" width="800" />
</p>

> 🪶 OpenRyokoは [Jinn](https://github.com/hristo2612/jinn)（MIT License, by Hristo Stoyanov）の AI 組織・cron・Web ダッシュボードといった土台レイヤーを継承しつつ、Slack 上での**振る舞い** — 空気読み・自律完遂・状態可視化 — に集中して大きく前進した設計です。

---

## 💡 OpenRyokoが解く問題

社内 Slack に AI を住まわせると、すぐ3つの壁にぶつかります：

1. **「うざい」問題** — 雑談に割り込んでくる、誰宛か分からない発言に毎回反応する
2. **「中途半端」問題** — 1ターンで返事して止まる。長い作業の途中でユーザーが「続けて」「次は？」を投げ続けないといけない
3. **「見えない」問題** — 何が動いてるのか、何が詰まってるのか、Slack の会話ログを遡らないと分からない

OpenRyoko はこの3つを**Slack側のメカニズムごと用意**して解決します：

| 問題 | OpenRyoko の解 | 実装 |
|---|---|---|
| ① うざい | **空気読みトリアージ** — メッセージ毎に Haiku が silent/react/reply を判定。確信度60%未満は黙る | `slack/triage.ts` |
| ② 中途半端 | **自然言語 `/goal`** — 「最後までやって」等を Haiku が検出 → Claude Code の Stop hook を自動起動 → 各ターンの応答が個別 Slack メッセージで届く | `slack/goal-extractor.ts` + `engines/claude.ts` |
| ③ 見えない | **Agents View Canvas** — running/waiting/errored/idle の全セッションを Slack チャンネルのタブとして30秒毎ライブ同期 | `slack/agents-canvas.ts` |

---

## ⚡ 30秒で始める

```bash
npm install -g openryoko
ryoko setup
ryoko start
```

ブラウザで [http://localhost:7777](http://localhost:7777) → Settings → Slack に Bot Token を貼って保存。
WebUI の onboarding wizard が `/goal` / Canvas / triage を案内するので、迷わず有効化できます。

> 💡 Slack 機能をフルに使うには **Claude Code v2.1.139 以降**が必要です（`/goal` コマンド対応）。`npm install -g @anthropic-ai/claude-code@latest` で最新化してください。

---

## 🌸 OpenRyoko 独自の差別化

[Jinn](https://github.com/hristo2612/jinn) からは「常駐デーモン + マルチエンジン + AI組織 + Webダッシュボード + Cron + Skills + MCP」の枠を継承していますが、**Slack 上で AI同僚として実用に耐える挙動**は OpenRyoko のためにフルに作り直しました。

### Slack 振る舞い系（全て OpenRyoko 独自）

- 🌸 **空気読みトリアージ** — Haiku で `silent / react / reply` を判定。雑談・横の会話には介入しない保守的設計
- 🎯 **自然言語 `/goal`** — 「最後までやって」「完成するまで止まらないで」「終わったら教えて」等の意図を Haiku が拾い、Claude Code の Stop hook を起動
- 🖼️ **Agents View Canvas** — 全 Ryoko セッションを Slack の Canvas タブにライブ同期。設定 UI から channel picker でワンクリック有効化
- 💬 **ターン毎の個別投稿** — `/goal` で多ターン回した時、Claude の各ターンの応答が個別の Slack メッセージとして到着（進捗が見える）
- 👤 **発言者認識** — Slack ID から display name を解決し、operator と他者を system prompt 上で明示区別
- 🧵 **DM-equivalent 検出** — チャンネル内でも「ボット + 自分だけの会話」を検出して triage を skip、自然な対話を実現
- 📡 **Telegram コネクタ** — Jinn には無い 4 つ目のコネクタ

### エンジン / コスト最適化系（全て OpenRyoko 独自）

- 💸 **Interactive PTY エンジン** — Claude を「対話モード」で PTY 起動（`cc_entrypoint=cli`）。2026/6/15 の Claude 改定後も自動化を**通常のサブスク利用枠**で動かし、Agent SDK クレジットの消費・追加課金を回避（オプトイン。SSH 実行は `claude -p` に自動フォールバック、ターンタイムアウト等で堅牢化）
- 📊 **コンテキストメーター** — codex / claude 両エンジンで直近ターンの入力コンテキスト量を計測・可視化。コンテキスト枯渇の予兆が一目で分かる
- 🖥️ **ライブ xterm CLI ビュー** — ダッシュボードで Claude の PTY セッションをそのままターミナル表示（`/ws/pty`、Origin/host ガード付き）
- ⚙️ **`ryoko config interactive` + setup/update プロンプト** — CLI でも Web UI でも interactive を切替。更新時に未設定なら対話で案内

### セキュリティ / 運用系（全て OpenRyoko 独自）

- 🔒 **端末認証 + Host/Origin guard** — ネットワーク公開時は自動的に認証を要求。単回ペアリング、端末解除、DNS rebinding対策付き
- 🌐 **会話型オンボーディング** — Ryoko 自身が新規ユーザーに名前・役割・好みを聞いて `~/.ryoko/knowledge/` に保存
- ✨ **Onboarding ウィザード** — Web UI 初回起動時に Slack 機能（`/goal` / Canvas / triage）を視覚的に紹介
- 💡 **Inline discovery hint** — Slack tokens 設定済みで Canvas 未有効なら設定画面で気づかせる
- 🧠 **Persona / Memory レイヤー** — `ryoko update` で自動マイグレーションされる人格・記憶テンプレート
- 🏠 **`~/.ryoko` ホームディレクトリ** — `~/.jinn` からの自動マイグレーション付き、日本語ファースト

### Jinn から継承している土台（変えていない強み）

- 🔌 **3エンジン対応** — Claude Code CLI + Codex SDK + Gemini CLI
- 💬 **マルチコネクタ** — Slack / Discord / WhatsApp / Telegram
- 👥 **AI 組織システム** — 部門・階級・マネージャー・従業員・タスクボード
- 🌐 **Web ダッシュボード** — チャット / 組織図 / カンバン / コスト追跡 / cron 可視化
- ⏰ **Cron スケジューリング** — ホットリロード対応
- 🔄 **ホットリロード** — config / cron / org ファイルを再起動なしで反映
- 🛠️ **自己改変** — エージェントが自分の設定・スキル・組織を実行中に編集可能
- 📦 **スキルシステム** — Markdown プレイブックでエンジンが native に従う
- 🏢 **マルチインスタンス** — 複数の Ryoko を並列起動
- 🔗 **MCP 対応** — 任意の MCP サーバーに接続

---

## 📦 「中身」もほしい人へ（OpenRyoko パッケージ）

OpenRyoko 本体（この基盤）は **MIT ライセンスで無料**です。ここは今後も変わりません。

ただ、セットアップ直後のアシスタントは「まっさら」で、実務で使えるようになるまでには
指示書・人格ファイル・記憶の運用・cron の設計・検証ゲートを自分で育てる必要があります。
この「育てた中身」を、本家 Ryoko が実際に使っているものから固有情報を除いて配布しています。

| | 内容 |
|---|---|
| **基本パッケージ** ¥29,800 | 計26ファイル: 運用指示書 完全版（AGENTS.md / CLAUDE.md）・人格ファイル5枚・記憶の2層運用設計・cron 設計パターン集と雛形4本・独立検証ゲート4本・スキル3本・配線スクリプト |
| **拡張パッケージ** ¥98,000 | さらに計55ファイル: 時間軸つき知識グラフ（スキーマ・取込アダプタ・質問スクリプト・3D可視化）・自律ループ3層キット（設計書テンプレ4本＋ランタイム部品）・read-only rootfs の Docker 常駐環境 |

各ルールには「なぜ」（多くは実際に起きた障害）が添えてあり、そのまま使っても、
自分の環境に合わせて書き換えても構いません。買い切り・GitHub リポジトリ招待で即納です。

→ **[パッケージの詳細と購入 (tekion.jp/openryoko/packages)](https://tekion.jp/openryoko/packages)**

## 💎 設計哲学

### 🔑 Anthropic Max サブスクリプションで動く

OpenRyoko は Claude Code CLI を子プロセスとして起動するため、Anthropic の公式クライアントとして扱われ、[Max サブスクリプション](https://www.anthropic.com/pricing)の利用枠で動作します。APIトークン従量課金を前提にしません。

> **⚠️ 2026年6月15日の Claude 改定への対応**
>
> この日から「Claude Agent SDK クレジット」という**別枠の月次クレジット**が新設され、**プログラム的な利用**（`claude -p` 非対話モード / Claude Agent SDK / Claude Code GitHub Actions）はこの別枠（消費レートは API と同一・プラン額相当を毎月付与）から消費されるようになりました。一方、**対話（インタラクティブ）利用は対象外で、従来どおり通常のサブスク枠**で動きます。
>
> OpenRyoko は **Interactive PTY エンジン**（`engines.claude.interactive`）を備え、自動化のターンも「人が使うのと同じ対話モード」で Claude を起動します。これにより**改定後も通常のサブスク利用枠で動き続け**、Agent SDK クレジットの消費や追加課金を避けられます。
> - 既定は従来の headless `claude -p`。**`ryoko config interactive on`**、または **設定画面 → エンジン設定 → 「インタラクティブPTY」トグル**、もしくは `ryoko setup` / `ryoko update` の対話プロンプトで有効化（反映にはゲートウェイ再起動）。
> - SSH リモート実行の従業員は PTY を使えないため、自動で headless `claude -p` にフォールバックします。

空気読みトリアージと `/goal` 抽出は軽量 Haiku を使いますが、これも Claude Code CLI 経由です。

### 🧠 「バス、脳ではない」哲学

OpenRyoko は独自のプロンプトエンジニアリング層を持ちません。Claude Code が既にツール利用・ファイル編集・マルチステップ推論・記憶・**`/goal` の Stop hook** を担当しているので、OpenRyoko はそれを外の世界（Slack、cron、WebUI、Canvas）に接続するだけ。Claude Code が進化すれば、OpenRyoko も自動的に強くなります。

### 🌸 空気読みの判断フロー

```
受信メッセージ
  ├─ DM？               ──→ 常に返信
  ├─ @メンション？       ──→ 常に返信
  ├─ DM相当の会話？      ──→ 常に返信（一度engage済み + 1ユーザーだけの会話）
  └─ グレーゾーン        ──→ Haiku でトリアージ
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

## 🚀 クイックスタート

### npm で入れる（推奨）

```bash
npm install -g openryoko
ryoko setup
ryoko start
```

アップデートは `ryoko update`。稼働中のゲートウェイをそのまま新コードに載せ替えたい場合は `ryoko update --restart` を使うと、更新・マイグレーション後に自動で再起動します（systemd ユニット → フォークデーモンの順に検出。systemd ユニット名は `--service <name>` か環境変数 `RYOKO_SERVICE` で上書き可、既定は `openryoko`）。

### ソースから入れる（開発・改造向け）

```bash
git clone https://github.com/rsensui2/OpenRyoko.git
cd OpenRyoko
pnpm install
pnpm build
npm install -g ./packages/jimmy

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
  host: "127.0.0.1"

engines:
  default: claude
  claude:
    bin: claude
    model: claude-opus-5   # Opus 5 明示 ID（裸の opus エイリアスは CLI が知る最新 Opus 止まり）
    effortLevel: medium
    interactive: false     # true で対話モード(PTY)起動 → 6/15改定後も通常サブスク枠で動く
  codex:
    bin: codex
    model: gpt-5.6-sol     # GPT-5.6 3ティア: gpt-5.6-sol(上) / gpt-5.6-terra(中) / gpt-5.6-luna(小)

connectors:
  slack:
    app_token: xapp-...
    bot_token: xoxb-...
    # 決定的な応答ゲート（トリアージの前段で評価。省略時は全メッセージに応答）
    respondTo:
      im: always            # DM: メンション不要で常に応答
      mpim: mention         # グループDM: @メンション時のみ
      channel: mention      # チャンネル: @メンション時のみ
      engagedThreads: true  # botが参加済みのスレッド内は再メンション不要（デフォルト true）
    # 空気読みトリアージ（メンションなしメッセージへの過剰反応を抑制）
    triage:
      enabled: true
      model: claude-haiku-4-5
      timeoutMs: 20000
      threadContextLimit: 10
  discord:
    botToken: ...
    # 平場チャンネルでの返信先: channel（そのまま投稿・既定）/ reply（元メッセージにリプライ）
    # / thread（元メッセージからスレッドを作って返信。Slack 風にスレッド単位のセッションになる。
    #   既存デプロイで thread に切り替えると平場チャンネルの進行中セッションは新規に切り直される）
    replyStyle: reply
    # Slack と同じ決定的な応答ゲート。
    # 省略時も他ユーザー宛のメンション/リプライには応答しない（Slack と同じ既定挙動）
    respondTo:
      dm: always            # DM（1:1・グループ）: メンション不要で常に応答
      channel: mention      # チャンネル/スレッド: @メンション or botへのリプライ時のみ
      engagedThreads: true  # botが参加済みのスレッド内は再メンション不要（デフォルト true）

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

## 🖥️ Linux サーバーで常駐させる（systemd）

VPS等で 24/7 稼働させたい場合、`scripts/systemd/` に systemd unit テンプレートと
インストーラを用意しています。これを使えば「`spawn claude ENOENT`」「rootだとClaude
CLIに弾かれる」「クラッシュ後に手動で立ち上げ直し」といったお決まりの落とし穴を
回避できます。

```bash
# 1. 専用ユーザーを作成（rootで動かさない）
sudo useradd -m -s /bin/bash ryoko

# 2. その ryoko ユーザーで Node 22+ と OpenRyoko をインストール
sudo -u ryoko -i bash -lc '
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.nvm/nvm.sh
  nvm install 22
  npm install -g openryoko @anthropic-ai/claude-code
  ryoko setup
'

# 3. systemd unit を /etc/systemd/system/ に配置して enable
sudo ./scripts/systemd/install.sh ryoko

# 4. ログ追跡
journalctl -u openryoko -f
```

`install.sh` は対象ユーザーの PATH（nvm の Node ディレクトリ含む）を自動検出して
unit ファイルに焼き込みます。手動で `openryoko.service` をコピーする場合は、
テンプレート先頭のコメント（User / WorkingDirectory / Environment=PATH=… /
ExecStart）を必ず編集してください。

常駐運用ではアップデートと再起動を `ryoko update --restart` の1コマンドで完結できます。
この unit（`openryoko`）を自動検出して `systemctl restart` を実行します（直接の権限が無い場合は
`sudo -n` を試行）。ユニット名が異なる場合は `--service <name>` か環境変数 `RYOKO_SERVICE` で指定してください。

> **rootで動かしたい場合**: 非推奨ですが、OpenRyoko が `IS_SANDBOX=1` を自動付与
> するので Claude CLI の root 拒否はバイパスされます。それでも専用ユーザー運用を強く推奨します。

## ⚙️ Web UI からの設定変更

ダッシュボードの Settings 画面で Slack トークン等を保存すると、`~/.ryoko/config.yaml`
が更新されたあと自動でコネクタが再接続されます（v0.9.5 以降）。デーモン再起動は
不要です。手動で再接続したい場合は `POST /api/connectors/reload` を叩けます。

Settings → エンジン設定 には **「インタラクティブPTY（Max定額）」トグル** もあり、
`engines.claude.interactive` を切替できます（6/15 の Claude 改定対応）。エンジンの選択は
起動時に確定するため、このトグルの反映には**ゲートウェイの再起動が必要**です
（`ryoko update --restart` か `ryoko stop && ryoko start`）。

## 🎯 自然言語 `/goal` — 自律完遂タスク

Claude Code v2.1.139+ で追加された `/goal` コマンドを、Slackの自然な日本語/英語から
自動起動できます。

例えば DM や @メンションで：

> 5社の人事SaaSの料金/機能を比較した表をこのスレッドに投げて、**最後までやって**

と頼むと、OpenRyoko は内部で Haiku を呼んで完了条件を一文に蒸留し、Claude Code への
プロンプトに `/goal X` を前置します。Claude は `/goal` の Stop hook を立て、**条件が
満たされるまで複数ターンに渡って自律的に作業**を続けます。各ターンの応答はそれぞれ
独立した Slack メッセージとして投稿されるので、進捗が見える形で届きます。

トリガーは決定論的なフレーズ（「最後まで」「止まらないで」「完成するまで」「終わったら
教えて」「keep going」「until done」等）に加え、文中に **埋め込まれた停止条件**
（「完了と書いたら止まる」「Xになるまで」「別々のターンで」等）にも反応します。
意味判定は Haiku が行うので、対応フレーズを覚える必要はありません。

> 💡 Claude Code は **v2.1.139 以降が必須** です（古いバージョンだと `/goal isn't available
> in this environment` になります）。`npm install -g @anthropic-ai/claude-code@latest`
> で最新化してください。

## 🖼️ Agents View Canvas — Slack でいつでも状況把握

設定で有効化すると、Ryoko は指定した Slack チャンネルに **「Ryoko Agents View」**
というタブ付き Canvas を自動作成し、現在動いている全セッションを30秒ごとに更新
します。Running / Waiting / Errored / Interrupted / Idle のグループに分かれて、
チャンネル上部のタブから即座に「いま何が走っているか」が把握できます。

### 有効化手順

1. **Slack App に scope を追加** — Settings ページの「Slack App Manifest」ブロックを
   コピーして自分の Slack App に貼り直し、Reinstall to Workspace を実行。これで
   `canvases:write` / `canvases:read` を含む必要 scope がすべて揃います
2. **Settings → Slack → Agents View Canvas** で：
   - 「有効化」をON
   - 「表示先チャンネル」のドロップダウンから対象チャンネル選択（Bot が member の
     channel のみ表示されます）
   - 必要に応じてタイトル・更新間隔・表示件数を調整
3. 保存すると30秒以内に指定チャンネルに Canvas が出現します

設定はホットリロード対応なので、デーモン再起動は不要です。

## 🔒 セキュリティ運用上の注意

OpenRyoko は **個人マシン or 信頼境界内の VPS で 1 人 / 1 チームが使う前提**で
設計されています。本番運用する場合は以下を必ず守ってください：

- **`gateway.host` はデフォルト `127.0.0.1` のままにする**。ネットワーク公開時は
  OpenRyokoの端末認証が自動的に有効になるが、通信を暗号化する機能は内蔵しない。
  **Tailscale/VPN内で利用するか、HTTPSリバースプロキシ**（Cloudflare Access、Caddy、
  nginx等）を前段に置くこと。平文HTTPのままインターネットへ公開しない。
- `gateway.host` は待受アドレスであり接続先URLではない。`0.0.0.0` / `::` で待ち受ける
  場合もローカルAPIは `ryoko api GET /api/status` のように呼ぶ。`ryoko api` は安全な
  loopback URLを選び、Bearer認証を自動付与する。直接HTTPを使う必要がある子プロセスには
  接続可能なURLが `$RYOKO_GATEWAY_URL` で渡される。
- リバースプロキシの公開名は `gateway.allowedHosts` に列挙する。プロキシが設定する
  `X-Forwarded-Proto`をCookieの`Secure`判定に使う場合だけ
  `gateway.trustProxyHeaders: true`を設定し、プロキシの接続元IPを
  `gateway.trustedProxyAddresses`に列挙する。一覧にない接続元の転送ヘッダーは無視される。
- `ryoko pair`が発行するコードは5分・1回限り。認証端末はDashboardから解除でき、
  サーバー側でも30日で失効する。
- **`connectors.slack.allowFrom` を必ず設定する**。空欄だとワークスペース全員が
  Ryoko を駆動でき、`/goal` の自然言語起動と組み合わさると秘密情報の流出経路に
  なり得る。trusted user の Slack ID をホワイトリストで明示すること。
- **Slack Bot の権限はそのまま Ryoko の権限**。Bot に `chat:write` `files:read` 等が
  付与されている以上、Slack の任意ユーザが promptインジェクション経由で Ryoko に
  これらを使わせる可能性は理論上残る。`allowFrom` の絞り込みが第一防御線。
- **Loopback Host header guard / 限定 CORS** を v2026.5.13 から有効化。`gateway.host`
  が `127.0.0.1` の時は loopback origin 以外からの API 呼び出しを 421 で拒否する。
  これにより DNS rebinding によるローカルブラウザ経由の attack をブロック。

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

- **デーモン・組織・cron・Webダッシュボード・skills・MCP** といった土台レイヤーは [Jinn](https://github.com/hristo2612/jinn) by Hristo Stoyanov のコードを継承しています。素晴らしい基盤を公開してくれた Hristo 氏に感謝します
- Web ダッシュボードの UI コンポーネントは [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice を基礎にしています
- `/goal` 自然言語化・Slack Canvas 同期・空気読みトリアージ等 **Slack 振る舞い系の機能**は OpenRyoko 独自実装で、上流に汎用化できる部分は Jinn に PR を送る方針です

## 🤝 コントリビュート

本リポジトリは現在、個人利用に合わせた日本語ファーストの実験的派生版です。上流 Jinn に還元できる汎用的な改善は積極的に PR を送る方針です。
