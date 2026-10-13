---
# ryoko migrate --auto（ryoko update）は、この migration を適用済みにしません。
# AI セッションか所有者の作業が要る手順を含むためです。ryoko migrate で適用します。
auto: false
---

# Migration: 2026.5.7 (OpenClaw-style Persona / Memory Layer)

## Summary

OpenClaw 由来の **persona / memory レイヤ**を導入。エージェントの「人格」「記憶」「初回儀式」をマークダウンファイルとして workspace 直下に配置し、エンジン CLI（Claude Code / Codex）のネイティブロード機構（`@`-import / Read 指示）で system prompt に注入する。

このマイグレーションは「OpenRyoko 旧版（persona レイヤなし）」から「OpenRyoko 2026.5.7 (persona レイヤあり)」への移行を担当する。

> **互換性メモ**: config.yaml の version key は **`jinn.version` のまま**。`ryoko.version` には変更しない。

## Template files changed

### 新規ファイル（`ryoko setup` 再実行、または `files/` からコピー）

| ファイル | 用途 |
|---|---|
| `IDENTITY.md` | 名前・雰囲気・絵文字・由来 |
| `SOUL.md` | トーン・意見・ユーモア・境界線 |
| `MEMORY.md` | 長期記憶（事実・好み・決定） |
| `TOOLS.md` | ツール覚書 |
| `BOOTSTRAP.md` | 初回起動の儀式（onboarding スキルを呼んで自分を削除） |
| `memory/` ディレクトリ | 日次ノート用（`YYYY-MM-DD.md`） |

これらは新規ファイルなので**衝突なし**。`ryoko setup` を再実行すれば自動配置される（[setup.ts:424-457](../../src/cli/setup.ts#L424-L457) の persona ロジックが既存ユーザーも brand-new 同等に扱い、BOOTSTRAP.md も配置する）。

この migration には同じ内容を `files/` 配下にも同梱しているため、AI migration では `~/.ryoko/migrations/2026.5.7/files/<path>` から `~/.ryoko/<path>` へコピーしてもよい。

### 更新ファイル（既存ファイルなので `ryoko setup` ではマージされない）

| ファイル | 何が変わったか |
|---|---|
| `CLAUDE.md` | 冒頭に「自己定義ファイル必読（@-import）」「初回起動 BOOTSTRAP」セクション追加。「自己進化」を「記憶の使い分け（MEMORY ↔ knowledge 二層）」に書き換え。ディレクトリ表に新ファイル追記 |
| `AGENTS.md` | CLAUDE.md と同じ構造変更、ただし `@`-import の代わりに Codex 向け Read 指示 |
| `skills/onboarding/SKILL.md` | Step 0（既存 knowledge 確認）追加。Step 3 を IDENTITY/SOUL/MEMORY 書き込みに変更。`.jinn` パス → `.ryoko`。Step 7 で BOOTSTRAP.md 削除を必須化 |
| `skills/migrate/SKILL.md` | 全てのパス `~/.jinn/` → `~/.ryoko/`、製品名 `Jinn` → `OpenRyoko`、コマンド `jinn migrate` → `ryoko migrate`（config key の `jinn.version` だけは互換性のため据え置き） |

更新ファイルの最新版テンプレートも `files/` 配下に同梱している。既存ファイルは無条件上書きせず、以下の merge instructions に従って追記または置換判断すること。

## Version bump

`config.yaml` の `jinn.version` を `"2026.5.7"` に更新。

## New features

### Persona / Memory レイヤ

エージェントの「人格・記憶」を Workspace 直下のマークダウンとして表現:

- **IDENTITY.md / SOUL.md / MEMORY.md** — Claude Code は CLAUDE.md 冒頭の `@`-import で自動ロード。Codex は AGENTS.md の Read 指示で取得
- **TOOLS.md** — ユーザー保守のツール覚書
- **BOOTSTRAP.md** — 初回起動でエージェントが onboarding スキルを呼び、完了後に自分を削除
- **memory/** — 日次ノート（`YYYY-MM-DD.md`）

### 記憶の二層モデル

- **長期記憶**: `MEMORY.md`（毎セッション読まれる、短く保つ）
- **参照記憶**: `knowledge/<topic>.md`（必要時に grep / Read で探す、長文OK）

旧バージョンの `knowledge/user-profile.md` `preferences.md` `projects.md` は廃止ではないが、短い事実は `MEMORY.md` に集約する設計。

### BOOTSTRAP の brand-new 判定

`ryoko setup` は persona ファイル（IDENTITY/SOUL/MEMORY/TOOLS）が一つも無いとき BOOTSTRAP.md を配置する。これは:
1. 新規セットアップ（初回 `ryoko setup`）
2. **旧バージョンからのアップグレード**（CLAUDE.md/config.yaml はあるが persona は無い）

の両方を含む。エージェントは BOOTSTRAP.md の Step 0 で旧 `knowledge/` を読み込み、既知の情報を引き継ぐ。

## Merge instructions

### 1. Config

`config.yaml` の `jinn.version` を `"2026.5.7"` に更新。

### 2. 新規ファイルの取り込み

ユーザーに `ryoko setup` の再実行を促す。これだけで:
- IDENTITY/SOUL/MEMORY/TOOLS/BOOTSTRAP の5ファイルが自動配置
- `memory/` ディレクトリが自動作成
- 既存 CLAUDE.md/AGENTS.md は触られない（skip される）

setup を呼べない環境では、agent がパッケージ同梱の template から手動コピー:

```bash
# パッケージのインストール先を取得
RYOKO_PKG=$(npm root -g)/openryoko
# 新規ファイルをコピー
cp "$RYOKO_PKG/template/IDENTITY.md" ~/.ryoko/
cp "$RYOKO_PKG/template/SOUL.md" ~/.ryoko/
cp "$RYOKO_PKG/template/MEMORY.md" ~/.ryoko/
cp "$RYOKO_PKG/template/TOOLS.md" ~/.ryoko/
cp "$RYOKO_PKG/template/BOOTSTRAP.md" ~/.ryoko/
mkdir -p ~/.ryoko/memory
```

プレースホルダ `{{portalName}}` は `~/.ryoko/config.yaml` の `portal.portalName` 値で置換すること。

### 3. CLAUDE.md / AGENTS.md のマージ

これらは既存ユーザーが大きくカスタマイズしている可能性があるため、**追記のみ**で対応。

各ユーザーの `~/.ryoko/CLAUDE.md` を Read し、以下の新セクションが**存在しなければ**冒頭側に追記:

#### 追記すべきセクション（CLAUDE.md）

```markdown
## 自己定義ファイル（必読）

以下のファイルがあなたの「核」です。セッション開始時に必ず参照してください。

@IDENTITY.md
@SOUL.md
@MEMORY.md

- **IDENTITY.md** — 名前・雰囲気・絵文字・由来
- **SOUL.md** — トーン・意見・ユーモア・境界線
- **MEMORY.md** — 長期記憶（短く保つ）

---

## 初回起動（BOOTSTRAP）

`~/.ryoko/BOOTSTRAP.md` が存在する場合、**他の何よりも先に**そのファイルを読み、書かれた手順を最後まで実行してください。完了後は BOOTSTRAP.md 自身を `rm` で削除します。
```

#### 追記すべきセクション（AGENTS.md）

CLAUDE.md と同様だが、`@`-import の代わりに Read 指示:

```markdown
## 自己定義ファイル（必読）

セッション開始時、最初のターンで必ず以下3ファイルを `~/.ryoko/` から読み込んでください。Codex は `@`-import 構文を解釈しないので、Read で明示的に取得すること。

- `~/.ryoko/IDENTITY.md`
- `~/.ryoko/SOUL.md`
- `~/.ryoko/MEMORY.md`

---

## 初回起動（BOOTSTRAP）

（CLAUDE.md と同じ）
```

#### 「記憶の使い分け」セクション

既存 CLAUDE.md/AGENTS.md に「自己進化」セクション（`knowledge/user-profile.md` 等を案内）があれば、新版の「記憶の使い分け」セクション（パッケージ同梱の最新 template/CLAUDE.md 参照）で**置き換え**る。

理由: 旧案内は MEMORY.md レイヤと矛盾するため。ユーザーカスタマイズが含まれている場合のみ、新旧を併記してユーザーに判断を委ねる。

#### ディレクトリ表

`## ~/.ryoko/ ディレクトリ` の表に以下の行を追記:

```markdown
| `IDENTITY.md` | あなたの自己定義（名前・雰囲気・絵文字） |
| `SOUL.md` | 人格・トーン・境界線 |
| `MEMORY.md` | 長期記憶（短い・必ず読まれる） |
| `TOOLS.md` | ツール覚書（運用ノウハウ） |
| `BOOTSTRAP.md` | 初回起動の儀式（完了後に自分で削除） |
| `memory/` | 日次ノート（`YYYY-MM-DD.md`） |
```

### 4. skills/onboarding/SKILL.md の置換

旧版は `~/.jinn/knowledge/` パスのまま、IDENTITY/SOUL/MEMORY を扱う Step を持っていない。

ユーザーがこのスキルをカスタマイズしている可能性は低い（標準オンボーディング）ので、**全置換**を推奨。パッケージ同梱の `template/skills/onboarding/SKILL.md` をそのままコピー。

カスタマイズがある場合は、ユーザーに diff を提示して判断を委ねる。

### 5. skills/migrate/SKILL.md の置換

このスキル自体も更新対象。`~/.jinn/` パスが12箇所あるため、**全置換**を推奨。パッケージ同梱の `template/skills/migrate/SKILL.md` をそのままコピー。

### 6. Backups

ファイル変更前に必ず `<filename>.pre-2026.5.7.bak` でバックアップ。

### 7. Database

スキーマ変更なし（gateway 起動時に自動処理）。

## Manual steps after migration

1. **エージェントセッションを再起動**（CLAUDE.md/AGENTS.md の変更を反映するため）
2. **次回起動時に BOOTSTRAP.md が認識される**ことを確認 — エージェントが onboarding スキルを呼び出す
3. **オンボーディング中、Step 0 で旧 knowledge/ を読み込む**ことを確認 — 既知情報の再質問を避けるため

## Breaking changes

なし。既存ファイルは破壊されず、新ファイルが追加されるだけ。`knowledge/user-profile.md` 等は残るが、新フローでは MEMORY.md が主軸になる。
