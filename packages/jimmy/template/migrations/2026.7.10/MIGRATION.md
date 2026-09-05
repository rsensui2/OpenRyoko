# Migration: 2026.7.10 (GPT-5.6 対応 / Codex 既定モデル gpt-5.6 / モデル選択 UI 刷新)

## Summary

OpenAI **GPT-5.6**（Sol / Terra / Luna の3ティア）に対応する。3 点の変更を含む:

1. **Codex 既定モデルを `gpt-5.5` → `gpt-5.6-sol`（Sol / 上ティア）に変更** — 新規セットアップと、旧デフォルトのままの既存インスタンス（config-patch）に反映
2. **モデルのティア（松竹梅: Sol 上 / Terra 中 / Luna 小）を UI から選択可能に** — 設定画面の Codex モデル選択肢に GPT-5.6 3ティアを追加
3. **空気読みトリアージ / Goal 判定のモデルをフリーテキスト入力からプルダウン選択に変更** — 最新の Anthropic / OpenAI モデルをエンジンに応じて選べる（`自動（エンジン既定）` も選択可）

> **互換性メモ**: config.yaml の version key は **`jinn.version` のまま**。

## GPT-5.6 のティア（Codex CLI のモデル ID）

| ティア | 松竹梅 | Codex モデル ID | 位置づけ |
|---|---|---|---|
| Sol | 上 | `gpt-5.6-sol` | フラッグシップ |
| Terra | 中 | `gpt-5.6-terra` | バランス・低コスト |
| Luna | 小 | `gpt-5.6-luna` | 最速・最安（トリアージ向け） |

いずれも context window 1.05M / max output 128K。

> **⚠️ 裸の `gpt-5.6` エイリアスは使わないこと**: API では `gpt-5.6` = `gpt-5.6-sol` のエイリアスだが、**ChatGPT アカウントの Codex では 400 エラー**（`The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account`）になる（2026-07-10 実機検証）。明示 ID（`gpt-5.6-sol` / `-terra` / `-luna`）は ChatGPT アカウントでも動作する。ゲートウェイは通常サブスク枠（ChatGPT アカウント）で運用されるため、config・UI とも明示 ID に統一した。

## このマイグレーションが行う config 変更

`config-patch.json`:

```json
[{ "path": "engines.codex.model", "from": "gpt-5.5", "to": "gpt-5.6-sol" }]
```

- `engines.codex.model` が **`gpt-5.5`（旧デフォルト）または未設定**のユーザー → `gpt-5.6-sol` に自動更新
- 別モデルに**カスタム済み**のユーザー（例: `gpt-5.6-terra` を明示指定）→ そのまま（変更されない）

冪等。適用セマンティクスの詳細は [configPatch.ts](../../src/shared/configPatch.ts) を参照。

## Template files changed（新規セットアップ向け、既存ユーザーの config 値には影響なし）

| ファイル | 変更 |
|---|---|
| `template/config.default.yaml` | `engines.codex.model: gpt-5.5 → gpt-5.6-sol` |
| `packages/jimmy/src/shared/models.ts` | synth 既定 fallback `gpt-5.3-codex → gpt-5.6-sol` |
| `packages/jimmy/src/cli/setup.ts` | フォールバック設定テンプレートの codex model を `gpt-5.6-sol` に |
| `packages/web`（コンパイル済み UI） | Codex モデル選択肢に GPT-5.6 Sol/Terra/Luna を追加、トリアージ / Goal のモデルをプルダウン化、モデルカタログを単一情報源に集約 |

これらは新規 `ryoko setup` にのみ適用。既存ユーザーの config 値は上記 config-patch が担当する。

## Merge instructions

### 1. Config（自動）

`ryoko update` / `ryoko migrate --auto` が config-patch を自動適用し、`jinn.version` を `"2026.7.10"` に更新する。手動操作は不要。

### 2. Gateway 再起動

モデル定義の反映のため gateway を再起動（`ryoko update --restart` なら自動）。

## Breaking changes

なし。config-patch はカスタム値を保護する。既定が `gpt-5.6-sol` になるのは旧デフォルト（`gpt-5.5`）のままだったユーザーのみ。

## Also in 2026.7.10

- **`connectors.slack.respondTo`（決定的メンションゲート）**: DM / グループDM / チャンネルごとに `always | mention | never` を指定できる応答ポリシー。LLM トリアージの前段で決定的に評価され、`engagedThreads: true`（既定）で bot 参加済みスレッドは再メンション不要。未設定なら従来どおり全メッセージに応答（後方互換・config-patch 不要のオプトイン機能）。詳細は `docs/connectors.md` を参照。
