---
name: onboarding
description: Walk a new user through initial {{portalName}} setup, fill IDENTITY / SOUL / MEMORY, and finalize the workspace
---

# Onboarding Skill

## Trigger

このスキルは以下のいずれかで起動します:

1. **`~/.ryoko/BOOTSTRAP.md` が存在するとき**（初回起動時に CLAUDE.md / AGENTS.md から最優先で呼ばれる）
2. ユーザーが明示的にオンボーディングのやり直しを希望したとき

---

## Steps

### 0. 既存知識のチェック（アップグレード対応）

`~/.ryoko/knowledge/` を ls で確認:
- `user-profile.md` `preferences.md` `projects.md` 等が存在すれば**旧バージョンからのアップグレード**と判断し、それぞれ Read
- 何もなければ**新規セットアップ**として進める

旧ファイルがあった場合、内容を要約してユーザーに提示し:
- 「以下の情報が既にあります。引き継ぎますか？」
- 承認されたら、短い事実は後の Step 3 で `MEMORY.md` に転記、長文は `knowledge/` にそのまま残す
- 承認された情報については Step 2 のヒアリングで再質問しない

### 1. 挨拶

ユーザーに短く挨拶し、これからセットアップ対話に入ることを伝えます。

例（新規）: 「はじめまして。{{portalName}} としてセットアップを始めさせてください。いくつか質問させてもらいます。」
例（アップグレード）: 「{{portalName}} の persona/memory レイヤが追加されたので、いくつかだけ確認させてください。」

### 2. ヒアリング（一度に全部聞く）

以下を**まとめて**質問してください（1問ずつ聞かない）:

1. **あなたについて** — 名前、役割、所属/事業
2. **{{portalName}} に手伝ってほしいこと** — コードレビュー、デプロイ、監視、リサーチ等
3. **コミュニケーションの好み** — 簡潔/詳細、敬語/タメ口、絵文字の有無、使用言語
4. **{{portalName}} の人格** — どんな雰囲気で振る舞ってほしいか（落ち着いた / 軽快 / 茶目っ気 など）、絵文字を使うなら何を使いたいか、ユーモアは OK か
5. **進行中のプロジェクト** — 何に取り組んでいるか、技術スタック、リポジトリ、状況

### 3. 自己定義ファイルを書き込む

回答が揃ったら、以下のファイルを **Edit** で更新してください（**Write で全置換しない** — 既存セクション構造を保つ）。

#### `~/.ryoko/IDENTITY.md`

`Name` / `Vibe` / `Emoji` / `Pronouns` / `Origin` の各セクションをユーザーの回答で埋める。

#### `~/.ryoko/SOUL.md`

`Tone` / `Brevity` / `Humor` を回答で埋める。`Opinions` / `Boundaries` / `Quirks` はデフォルトのままでよい（ユーザーが言及した場合のみ調整）。

#### `~/.ryoko/MEMORY.md`

ヒアリング結果から「短い事実・好み」を抽出して `Facts` と `Preferences` に追記:

```markdown
## Facts
- ユーザー名: [name]
- 所属: [organization]
- 役割: [role]
- 主要言語/スタック: [stack]
- 主な依頼領域: [what they want help with]

## Preferences
- 冗長性: [concise / detailed]
- 敬語: [keigo / casual]
- 絵文字: [yes / no / minimal]
- 言語: [language]
```

進行中のプロジェクト情報は**長文になりがち**なので、`MEMORY.md` ではなく `~/.ryoko/knowledge/projects.md` に書きます:

#### `~/.ryoko/knowledge/projects.md`（新規作成）

```markdown
# Active Projects

## [Project Name]
- **Stack**: [tech stack]
- **Repo**: [repo path or URL]
- **Status**: [status]
- **Notes**: [anything relevant]
```

#### `~/.ryoko/TOOLS.md`（必要に応じて）

ユーザーが特定のツール（pnpm 統一、gh CLI 中心、特定の MCP サーバ等）に言及したら追記。言及がなければ触らない。

### 4. OpenClaw からの移行確認

`~/.openclaw/` が存在するか確認。あれば移行を提案:

1. `~/.openclaw/openclaw.json` を読んで設定を確認
2. `~/.openclaw/cron/jobs.json` の cron ジョブを確認
3. `~/.openclaw/skills/` のスキルプレイブックを確認
4. `~/.openclaw/memory/` と `~/.openclaw/knowledge/` の蓄積文脈を確認

サマリを提示してユーザーに何を移すか選んでもらう。承認されたものだけ移行する。

OpenClaw が無ければスキップ。

### 5. 組織のスキャフォールド

ユーザーのプロジェクトとニーズに基づき、初期の組織構造を提案:
- ソロ開発者 → `engineering` 部門に `dev-assistant` 一人
- コンテンツ制作者 → `content` と `research` 部門
- スタートアップ創業者 → `engineering`, `marketing`, `operations`

作る前に必ず確認を取る。

### 6. cron ジョブの提案

プロジェクトに合わせて有用な定期ジョブを提案:
- 日次スタンドアップ要約
- 週次レポート
- コードレビューのリマインダ

承認されたジョブだけ作成する。

### 7. BOOTSTRAP.md を削除（重要）

オンボーディングが完了したら、**必ず** BOOTSTRAP.md を削除してください:

```bash
rm ~/.ryoko/BOOTSTRAP.md
```

削除しないと、次回セッションでも BOOTSTRAP.md が読まれてオンボーディングがループします。

### 8. 締めくくり

何をセットアップしたかを短くまとめ、次の一歩を提案:
- 「従業員にタスクを委譲してみてください」
- 「カスタムスキルを作りたければ言ってください」
- 「Slack コネクタを設定すれば通知を受け取れます」

最後に「{{portalName}} として動きます」と一言宣言する。

---

## Error Handling

- `~/.ryoko/knowledge/` が無ければ作成する（通常は `jimmy init` で作られているはず）
- ユーザーが圧倒されている様子なら簡素化 — 1部門・1従業員だけ提案
- ユーザーがオンボーディングをスキップしたい場合、それを尊重して BOOTSTRAP.md を削除してから終了する
- `IDENTITY.md` などのファイルが存在しない場合、`jimmy init` の実行を促す（誤って削除された可能性）
