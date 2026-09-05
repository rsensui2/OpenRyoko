# Migration: 2026.7.1 (Claude Sonnet 5 対応 / effort デフォルト xhigh / 決定論的 config パッチ)

## Summary

3 点の変更を含む:

1. **Claude Sonnet 5 対応** — `sonnet` エイリアスが指す新モデル `claude-sonnet-5` の料金・表示ラベルを登録
2. **Claude の effort デフォルトを `medium` → `xhigh` に変更** — Sonnet 5 / Opus 4.7・4.8 が対応した `xhigh` を標準化
3. **決定論的 config パッチ機構の導入** — アップデート時に config.yaml のデフォルト値を、ユーザーのカスタマイズを壊さずに追従させる仕組み（本マイグレーション自身がその最初の利用例）

> **互換性メモ**: config.yaml の version key は **`jinn.version` のまま**。

## 決定論的 config パッチ（新機構）

これまで `ryoko update`（= `ryoko migrate --auto`）は**新規ファイルの追加のみ**で、既存 config.yaml の値は一切書き換えなかった（カスタマイズ保護のため）。本バージョンから、マイグレーションディレクトリに `config-patch.json` を同梱すると、`--auto` が config.yaml のキー単位で決定論的にパッチを当てる。

### `config-patch.json` の形式

```jsonc
[
  {
    "path": "engines.claude.effortLevel", // ドット区切りのキーパス
    "from": "medium",                     // 旧デフォルト（省略可）
    "to": "xhigh"                         // 新しい値
  }
]
```

### 適用セマンティクス（カスタマイズ保護）

| 現在の状態 | 挙動 |
|---|---|
| キーが未設定 | `to` を挿入 |
| 現在値 === `from` | `to` に更新（ユーザーが旧デフォルトのままだった） |
| 現在値が `from` 以外に設定済み | **スキップ**（ユーザーがカスタムした値を守る） |
| `from` 省略 & キー存在 | スキップ（既存値を上書きしない） |
| 現在値 === `to` | no-op |

冪等（何度実行しても結果は同じ）。実装は [configPatch.ts](../../src/shared/configPatch.ts)、適用は [migrate.ts の applyConfigPatches](../../src/cli/migrate.ts)。

## このマイグレーションが行う config 変更

`config-patch.json`:

```json
[{ "path": "engines.claude.effortLevel", "from": "medium", "to": "xhigh" }]
```

- `effortLevel` が **`medium`（旧デフォルト）または未設定**のユーザー → `xhigh` に自動更新
- `low` / `high` などに**カスタム済み**のユーザー → そのまま（変更されない）

## Template files changed（新規セットアップ向け、既存ユーザーには影響なし）

| ファイル | 変更 |
|---|---|
| `template/config.default.yaml` | `engines.claude.effortLevel: medium → xhigh` |
| `packages/web`（コンパイル済み UI） | 設定画面のモデルラベル `Sonnet (claude-sonnet-5)`、Claude effort に `Extra High` 追加 |

これらは**新規 `ryoko setup` にのみ**適用。既存ユーザーの config 値は上記 config-patch が担当する。

## Merge instructions

### 1. Config（自動）

`ryoko update` / `ryoko migrate --auto` が config-patch を自動適用し、`jinn.version` を `"2026.7.1"` に更新する。手動操作は不要。

### 2. Gateway 再起動

料金テーブルと effort フラグの反映のため gateway を再起動（`ryoko update --restart` なら自動）。

## Breaking changes

なし。config-patch はカスタム値を保護する。effort が `xhigh` になるのは旧デフォルト（medium）のままだったユーザーのみ。
