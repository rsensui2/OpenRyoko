---
name: migrate
description: Apply pending version migrations to update this {{portalName}} instance
---

# Migrate Skill

## Trigger

このスキルは、ユーザーが `/migrate` を実行したとき、`ryoko migrate` から起動されたとき、またはインスタンスのアップデート/アップグレードを依頼されたときに発動します。

## Overview

OpenRyoko の新バージョンには、更新されたスキル、新ドキュメント、改良プロンプト、config スキーマ変更が含まれることがあります。これらは **migration folders** として `~/.ryoko/migrations/<version>/` 配下に出荷されます。各フォルダには:

- `MIGRATION.md` — 何が変わったかを AI が読める形で記述した指示書
- `files/` — 新規/更新ファイルを正しい相対ディレクトリ構造で配置

あなたの仕事は、**ユーザーのカスタマイズを保ちながら**改良を取り込むこと。

> **互換性メモ**: config.yaml の version key は **`jinn.version` のまま**です（後方互換のため）。これを `ryoko.version` に置き換えてはいけません。

## Steps

### 1. Read Current Version

`~/.ryoko/config.yaml` を読み、`jinn.version` フィールドを確認します。フィールドが無ければ `0.0.0` と仮定。

### 2. List Pending Migrations

`~/.ryoko/migrations/` 配下のディレクトリを列挙。各ディレクトリ名は3セグメントの数値バージョン（例: `0.2.0`, `0.3.0`, `2026.5.7`）。

数値バージョン昇順にソートし、現インスタンスバージョンより**大きいもの**だけにフィルタ。

保留中マイグレーションが無ければ、ユーザーに「最新です」と伝えて停止。

### 3. Apply Each Migration In Order

保留中の各バージョンを、昇順で:

#### a. Read the Migration Instructions

`~/.ryoko/migrations/<version>/MIGRATION.md` を読む。このファイルは:
- 当バージョンで何が変わったか
- 新規ファイル（直接コピーして OK）
- 更新ファイル（インテリジェントマージが必要）
- config スキーマの変更
- 破壊的変更や手動ステップ

#### b. Follow the Instructions

MIGRATION.md は変更を分類しています:

**新規ファイル**（安全 — そのままコピー）:
- `~/.ryoko/migrations/<version>/files/<path>` → `~/.ryoko/<path>`
- 既存ではない新規ファイルなので衝突なし

**更新ファイル**（マージ必要）:
- migration が **新テンプレート版**を提供
- ユーザーの**現バージョン**を読む
- 比較してインテリジェントにマージ:
  - **AGENTS.md / CLAUDE.md**: MIGRATION.md が求める変更だけを、境界か入口の1〜3行として `AGENTS.md` に足す。ユーザーのカスタマイズは絶対に削除しない。`CLAUDE.md` が `@AGENTS.md` を読み込む入口になっているときは、`CLAUDE.md` には何も足さない（下の「Merge Strategy Reference」）
  - **config.yaml**: 新しい key をデフォルト値で追加。既存値は絶対に上書きしない
  - **skills**: ユーザーがそのスキルを変更していなければ（前テンプレ版があれば比較）置換。変更ありなら、新指示をマージしつつカスタマイズを保つ
  - **docs**: 完全置換 — 参照ドキュメントなのでカスタマイズ対象外

**削除ファイル**（慎重に）:
- MIGRATION.md に明示されたファイルだけ削除
- 削除前に `<filename>.pre-migration.bak` にバックアップ

#### c. Back Up Before Modifying

既存ファイルを変更する前に必ずバックアップ:
- `file.ext` → `file.ext.pre-<version>.bak`
- 例: `CLAUDE.md` → `CLAUDE.md.pre-2026.5.7.bak`

これでユーザーはいつでも復元できます。

### 4. Update Version

すべての migration が成功したら `config.yaml` を更新:

```yaml
jinn:
  version: "<final-migrated-version>"
```

> 繰り返し: key 名は `jinn:` のまま（互換性のため）。

### 5. Sync Skill Symlinks

新スキルを追加した場合、シンボリックリンクが存在することを確認:
- `~/.ryoko/.claude/skills/<skill-name>` → `../../skills/<skill-name>`
- `~/.ryoko/.agents/skills/<skill-name>` → `../../skills/<skill-name>`

### 6. Clean Up

適用済みの migration ディレクトリを `~/.ryoko/migrations/` から削除。
バックアップファイルは残す — ユーザーが後で手動削除可能。

### 7. Report

ユーザーに明確なサマリ:

```
Migration complete: v{old} → v{new}

Added:
- IDENTITY.md SOUL.md MEMORY.md TOOLS.md (persona/memory layer)
- BOOTSTRAP.md (initial onboarding ritual)
- memory/ (daily notes directory)

Updated:
- AGENTS.md (added Read instructions for persona files)
- skills/onboarding/SKILL.md (writes IDENTITY/SOUL/MEMORY, deletes BOOTSTRAP at end)

Backups created:
- AGENTS.md.pre-2026.5.7.bak
- skills/onboarding/SKILL.md.pre-2026.5.7.bak
```

## Merge Strategy Reference

### CLAUDE.md / AGENTS.md Merging

最もデリケートなファイル — ユーザーが大きくカスタマイズしている可能性があります。また、毎回のセッションで全文が読まれるので、足した分だけほかの指示が効きにくくなります。以下の方針で扱います。

1. **入口かどうかを先に見る**: `CLAUDE.md` に `@AGENTS.md` の行があれば、それは `AGENTS.md` を読み込むだけの入口です。`CLAUDE.md` には何も追記せず、変更は `AGENTS.md` にだけ入れます。入口でなければ、2つのファイルに同じ変更を入れます
2. **足すのは入口の行だけ**: 同梱テンプレートの節をそのまま写しません。MIGRATION.md が求める変更を、境界または「どこを読むか」の1〜3行にして足します。手順・スキーマ・例は `docs/` と Skill にあるので、そこへの参照を書きます
3. **既存の記述**: 両方にある場合、MIGRATION.md が明示的に「置換」と言わない限りユーザー版を残します
4. **削除**: MIGRATION.md が明示的に言わない限り削除しません
5. **順序**: ユーザーの既存の順序を保ち、足す行は関係する節の中か末尾に置きます
6. **整理の提案**: 2つのファイルの内容が食い違っている、または 15KB を超えているときは、勝手に直さず、所有者へ整理を提案します

### config.yaml Merging

1. **新トップレベル key**: デフォルト値で追加
2. **新ネスト key**: 既存親の下にデフォルト値で追加
3. **既存 key**: 絶対に上書きしない — ユーザーの値が優先
4. **削除 key**: MIGRATION.md が明示的に言う場合のみ（稀）

### Skills Merging

1. **新スキルディレクトリ**: 丸ごとコピー
2. **更新スキル**: ユーザーの SKILL.md が前テンプレ版と差分があるか確認
   - 同一（カスタマイズなし）: 新版で置換
   - 差分あり（カスタマイズあり）: 慎重にマージ、ユーザー追加部分を保持
3. **付随ファイル**（スキル内のデータ・テンプレ等）: ユーザー変更がなければ更新

## Error Handling

- migration が途中で失敗したら**停止**。後続バージョンに進まない
- どのバージョンのどのステップで失敗したか記録
- config.yaml の version はまだ更新されていないので、`ryoko migrate` を再実行すればリトライ可能
- ファイル衝突を自動解決できない場合は**ユーザーに確認**
- バージョンフォルダに MIGRATION.md が無ければそのバージョンをスキップして警告

## Dry Run

ユーザーが dry run やプレビューを依頼したら、保留中の MIGRATION.md を全て読んで、何が変わるかをサマリ — ファイル変更はしない。
