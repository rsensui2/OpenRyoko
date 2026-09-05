# Migration: 2026.7.25 (Claude Opus 5 対応 / Claude 既定モデル claude-opus-5)

## Summary

Anthropic **Claude Opus 5**（2026-07-24 発表、モデル ID `claude-opus-5`）に対応する。

1. **Claude 既定モデルを `opus`（裸エイリアス）→ `claude-opus-5`（明示 ID）に変更** — 新規セットアップと、旧デフォルトのままの既存インスタンス（config-patch）に反映
2. **設定画面の Claude モデル選択肢を刷新** — `claude-opus-5`（既定）/ `claude-opus-4-8`（ピン留め用）/ `opus`（CLI 自動追従）/ `sonnet` / `haiku`
3. **コストダッシュボードの価格表に Opus 5（$5/$25 per MTok）を追加** — あわせて Opus 4.8/4.7/4.6 の誤った旧値（$15/$75 = Opus 4.1 世代の価格）を公式価格 $5/$25 に修正

> **互換性メモ**: config.yaml の version key は **`jinn.version` のまま**。

## Claude Opus 5 について（2026-07-25 公式 docs 確認）

| 項目 | 値 |
|---|---|
| モデル ID | `claude-opus-5`（日付サフィックスなしの固定 ID、Opus 4.8 と同じ命名規則） |
| 価格 | $5 / MTok 入力・$25 / MTok 出力（**Opus 4.8 と同額**） |
| コンテキスト | 1M トークン / 最大出力 128K |
| effort | `low` / `medium` / `high`（既定）/ `xhigh` / `max` すべて対応 |
| thinking | 未指定なら adaptive thinking が**デフォルトで有効**（4.8 は無効だった） |

> **⚠️ 裸の `opus` エイリアスではなく明示 ID を使う理由**: `opus` は「インストール済み
> Claude CLI が知っている最新 Opus」に解決されるため、CLI が古いと 4.8 等の旧世代に
> 留まる。明示 ID は API パススルーなので CLI バージョンに関係なく Opus 5 が使われる。
> Codex の `gpt-5.6-sol` 明示 ID 統一（2026.7.10）と同じ方針。

> **API 直叩き実装者向けの注意**（gateway は Claude CLI 経由なので影響なし）:
> Opus 5 では `thinking: {type: "disabled"}` + effort `xhigh`/`max` の組み合わせが
> 400 になる（4.8 は許容していた）。gateway は thinking を無効化しないため非該当。

## このマイグレーションが行う config 変更

`config-patch.json`:

```json
[{ "path": "engines.claude.model", "from": "opus", "to": "claude-opus-5" }]
```

- `engines.claude.model` が **`opus`（旧デフォルト）または未設定**のユーザー → `claude-opus-5` に自動更新
- 別モデルに**カスタム済み**のユーザー（例: `claude-opus-4-8` をピン留め）→ そのまま（変更されない）

冪等。適用セマンティクスの詳細は [configPatch.ts](../../src/shared/configPatch.ts) を参照。

## Template files changed（新規セットアップ向け、既存ユーザーの config 値には影響なし）

| ファイル | 変更 |
|---|---|
| `template/config.default.yaml` | `engines.claude.model: opus → claude-opus-5` |
| `packages/jimmy/src/shared/models.ts` | synth 既定 fallback `opus → claude-opus-5`（`claudeSupportsXhigh` は既に `opus-5` パターン対応済みでコード変更なし） |
| `packages/jimmy/src/cli/setup.ts` | フォールバック設定テンプレートの claude model を `claude-opus-5` に |
| `template/CLAUDE.md` | cron ジョブ例の model を `claude-opus-5` に |
| `packages/web`（コンパイル済み UI） | Claude モデル選択肢に Opus 5 を追加（既定）、cron 作成 UI 初期値を `claude-opus-5` に、価格表を更新 |

これらは新規 `ryoko setup` にのみ適用。既存ユーザーの config 値は上記 config-patch が担当する。

## Merge instructions

### 1. Config（自動）

`ryoko update` / `ryoko migrate --auto` が config-patch を自動適用し、`jinn.version` を `"2026.7.25"` に更新する。手動操作は不要。

### 2. Gateway 再起動

モデル定義の反映のため gateway を再起動（`ryoko update --restart` なら自動）。

## Breaking changes

なし。config-patch はカスタム値を保護する。既定が `claude-opus-5` になるのは旧デフォルト（`opus`）のままだったユーザーのみ。既存 cron ジョブの `"model": "opus"` はエイリアスとして引き続き動作する。
