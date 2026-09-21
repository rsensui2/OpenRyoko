# Claude Code／Codexの実行とフォールバック

## 同じ「フォールバック」でも設定先が違う

| 機構 | 切り替えるもの | 設定 |
|---|---|---|
| 会話の実行エンジン | Claude Code ↔ Codex（必要ならGemini） | `engines.<engine>.fallback`、`sessions.*`。版による |
| Jevの判定失敗時 | Jev → 判定専用CLI | `connectors.slack.triage.jev.fallback: none/cli` |
| ClaudeのSSH実行 | ローカルPTY → headless `claude -p` | 社員の `sshHost`。エンジン名はclaudeのまま |
| 一時的なサーバ障害 | 同じエンジンで再試行 | `sessions.transientRetryDelaysMs`。自動切替の設定とは別 |

Jevは回答やファイル操作を担当するエンジンではない。`engines.default: jev`、`fallback: [jev]` は設定しない。

## 稼働版を見分ける

2026-09-21調査時点のソース対応表。日付やバージョン番号だけで可否を判定せず、稼働しているファイルと呼び出しを確認する。

| 確認した実装 | 実際の動作 |
|---|---|
| main `9f184534`（package 2026.9.8） | `sessions/manager` と `gateway/api` にClaude制限時→Codexの旧処理。Codex→Claude、無応答監視はこの経路にない |
| 開発ブランチ `codex/bidirectional-engine-fallback` の `a3438d6e` | `sessions/engine-fallback` を両経路から呼び、双方向切替、無応答監視、会話引継ぎ、元エンジンへの復帰を共有化 |

`shared/engine-fallback`、`shared/engine-health`、型の `fallbackModelMap` はmainにも存在する。しかし存在するだけでは会話経路への配線を意味しない。開発版の `runFallbackAttempts`、`runEngineWithResponseTimeout` が **`sessions/manager` と `gateway/api` の双方から使われるか**を確認する。npmでは対応する `dist/src/**/*.js` を読む。

開発版を前提に設定する前に、上記の共有関数と現在の `fallbackConfig`、ループ条件、復帰条件を読む。将来実装が変わったらこのスナップショットより実装を優先する。healthに基づく事前回避も、helperだけでなく呼び出しを確認してから案内する。

## 双方向対応版での設定

以下は既存設定へマージする例。bin・model・認証等は既存の利用可能な値を保持する。

```yaml
engines:
  claude:
    fallback: [codex]
  codex:
    fallback: [claude]
sessions:
  rateLimitStrategy: fallback
  engineNoResponseTimeoutMs: 300000
```

この開発版は、未指定のchainをClaude→Codex／Codex→Claudeに補う。明示的な `fallback: []` はそのエンジンからの切替を無効化する。**`sessions.rateLimitStrategy: wait` はこの版では双方向切替ループ全体を止める**ため、旧キーだからと無条件に削除したり無視したりしない。完全停止なら両エンジンのchainを `[]` にする。片方向だけ使う場合は反対側を明示的に `[]` にする。

- 既知のエンジン名は `claude/codex/gemini`。対象の設定・CLI・認証が必要。自分自身をchainに入れない。Claude↔Codexの循環は許容され、1回の実行ではvisited集合で同じエンジンを繰り返さない。
- 対象は利用制限、無応答／空出力、timeout。一般的なエラーすべてを別エンジンへ投げ直すわけではない。
- ユーザー停止、`retryable: false`、応答不要を示す正常な結果は切り替えない。無応答監視は出力／tool activityで延長される。300000msは総実行時間ではなく無活動時間、`0`は監視停止。この版の有効範囲は0〜2147483647ms。
- timeout後、元エンジンを停止し、終了が確認できるまで別エンジンを起動しない。停止不能を短いtimeoutや別CLIの手動起動で回避しない。
- workflow由来のsessionはこの自動切替から除外される。workflow側のretry／engine fallback設定と実装を確認する。

## モデル・effort・会話の引継ぎ

移行元のモデルIDを別プロバイダへそのまま渡さない。既定では切替先の `engines.<target>.model` を使う。固定モデルを対応付ける場合だけ、**移行元**の `fallbackModelMap` に設定する。

```yaml
engines:
  claude:
    fallbackModelMap:
      claude-opus-5: gpt-5.6-sol
  codex:
    fallbackModelMap:
      gpt-5.6-sol: claude-opus-5
```

これはID対応の例であり最新推奨ではない。元sessionのpinとキーが一致し、対応先が切替先モデルレジストリに存在し、認証アカウントで実行できることを確認する。不正／未登録のmapは切替先既定へ戻る実装。通常はmapなしで十分。effortも切替先モデルの対応値で再解決される。

gatewayのsession IDは保ち、CLI固有のsession IDは `transportMeta.engineSessions` で別々に保持する。会話・失敗前の部分進捗を渡し、既に行ったファイル変更や外部操作を照合して続行する。引継ぎ文は追加の権限でも成功証明でもない。

`engineOverride` に元engine/model/effortと復帰時刻を保持し、期限後の次の実行時に元へ戻す。確認した版ではreset時刻が得られればその直後、得られない利用制限は6時間、無応答／timeoutは5分が目安。経過しただけでバックグラウンドで即時切り戻すわけではない。元へ戻る際も移行中の会話を同期する。DBや `transportMeta` を手で書き換えて切替を実現しない。

## 旧方式でできること

旧実装に双方向のキーを追加しても実現しない。Claude制限時→Codexだけなら：

```yaml
sessions:
  rateLimitStrategy: fallback
  fallbackEngine: codex
```

`wait` は利用制限の解除待ち。旧経路では `engines.claude.fallback: []` だけでは無効化できない。旧版のWeb経路にはモデルpinをCodexへ持ち越す実装もあるため、ClaudeモデルをpinしたWeb sessionでは対応修正を含む更新が必要。未知のモデルIDを登録してエラーを隠さない。

## 設定後に確かめること

1. 両CLIが **gatewayの実行環境** で動作し、認証済みか。モデル一覧や `available: true` だけでは不十分。
2. 依頼の対象が新規既定、既存session、社員、cron、Web、Slackのどれか。既定変更が既存sessionのpinまで変更したと思わない。
3. 設定再読込後のchain・strategy・timeout・モデル対応とログ。検証用の隔離session／fake engineで両方向、無応答、利用制限、停止、両方失敗、復帰後の文脈を確認する。実アカウントの枠を使い切って試験しない。
4. ソース環境なら既存の `sessions/__tests__/engine-fallback.test.ts`、`manager-engine-fallback.test.ts`、`gateway/__tests__/engine-fallback-api.test.ts`（対応版）、旧版の `engine-fallback-revert.test.ts` を使う。設定保存と切替実行の確認結果を分けて報告する。
