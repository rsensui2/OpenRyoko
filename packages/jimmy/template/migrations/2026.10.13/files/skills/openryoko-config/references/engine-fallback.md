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

このスキルと同梱する実装はClaude Code／Codexの双方向切替に対応している。スキルだけをコピーした旧環境や、別ホストの稼働版も同じとは限らない。日付やバージョン番号だけで可否を判定せず、稼働しているファイルと呼び出しを確認する。

| 確認した実装 | 実際の動作 |
|---|---|
| 旧実装（例：package 2026.9.8） | `sessions/manager` と `gateway/api` にClaude制限時→Codexの旧処理。Codex→Claude、無応答監視はこの経路にない |
| 同梱する双方向対応実装 | `sessions/engine-fallback` を両経路から呼び、双方向切替、無応答監視、会話引継ぎ、元エンジンへの復帰を共有化 |
| 同梱する実装（利用上限の先回り） | 上に加えて `sessions/new-session-engine` がある。利用上限中と記録されたエンジンを、新しいセッションが最初から避ける。`GET /api/status` の `engines.<名前>.health` に記録が出る |

`shared/engine-fallback`、`shared/engine-health`、型の `fallbackModelMap` は旧実装にも存在する。しかし存在するだけでは会話経路への配線を意味しない。`runFallbackAttempts`、`runEngineWithResponseTimeout` が **`sessions/manager` と `gateway/api` の双方から使われるか**を確認する。npmでは対応する `dist/src/**/*.js` を読む。

双方向切替を設定する前に、上記の共有関数と現在の `fallbackConfig`、ループ条件、復帰条件を読む。将来実装が変わったらこの資料より実装を優先する。利用上限の先回りは、`sessions/new-session-engine` があり、`/api/status` に `health` が出る版だけの動作。無い版には、下の「利用上限に当たったとき」のうち先回りの項目が当てはまらない。

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

双方向対応実装は、未指定のchainをClaude→Codex／Codex→Claudeに補う。明示的な `fallback: []` はそのエンジンからの切替を無効化する。**`sessions.rateLimitStrategy: wait` は双方向切替ループ全体を止める**ため、旧キーだからと無条件に削除したり無視したりしない。`wait` は切り替えないという意味で、いつまでも待つという意味ではない（下の「利用上限に当たったとき」）。完全停止なら両エンジンのchainを `[]` にする。片方向だけ使う場合は反対側を明示的に `[]` にする。

- 既知のエンジン名は `claude/codex/gemini`。対象の設定・CLI・認証が必要。自分自身をchainに入れない。Claude↔Codexの循環は許容され、1回の実行ではvisited集合で同じエンジンを繰り返さない。
- 対象は利用制限、無応答／空出力、timeout。一般的なエラーすべてを別エンジンへ投げ直すわけではない。
- ユーザー停止、`retryable: false`、応答不要を示す正常な結果は切り替えない。無応答監視は出力／tool activityで延長される。300000msは総実行時間ではなく無活動時間、`0`は監視停止。この版の有効範囲は0〜2147483647ms。
- timeout後、元エンジンを停止し、終了が確認できるまで別エンジンを起動しない。停止不能を短いtimeoutや別CLIの手動起動で回避しない。
- workflow由来のsessionはこの自動切替から除外される。workflow側のretry／engine fallback設定と実装を確認する。
- `fallback` と `fallbackModelMap` の書き損じ（リストでない値、自分自身、存在しないエンジン）は、起動時と設定の再読込時に、問題ごとに1回だけ警告が出る。設定は拒否されない。リストでない `fallback` は「切替先なし」として扱われる。

## 利用上限に当たったとき

- **待つのは6時間まで。** 切替先が無い（または `rateLimitStrategy: wait`）とき、ターンは上限のリセットを待つ。待つのは、リセットが6時間以内の場合と、時刻が分からない場合（最長6時間）。リセットが6時間より先と分かっている上限は、待たずに失敗する。エラーにはリセットの時刻が入る（`… which is too far off to wait for`）。
- **待っているターンは再起動をまたぐ。** 待機中に gateway が再起動しても、次の起動で、リセットの10秒後にそのセッションを起こして続きを実行する（`sessions.resumeInterruptedOnBoot` が有効な場合）。
- **新しいセッションは、最初から切替先で始まる。** あるエンジンが利用上限中と記録されている間、そのエンジンを使うはずだった新しいセッションは、失敗するターンを挟まずに切替先で始まり、リセット後の次の実行で元のエンジンへ戻る。コネクタ経由でも `POST /api/sessions` でも同じ。対象外は、エンジンかモデルを名指しした呼び出し（cronジョブの `engine`／`model` を含む）、`rateLimitStrategy: wait`、workflowの試行、`sshHost` の社員。切替先は、起動してから一度はターンを返したエンジンに限る。再起動の直後は、最初の1件だけが従来どおり1ターン失敗してから切り替わる。
- **記録は `GET /api/status` で読める。** `engines.<名前>.health` の `state` が `exhausted` なら上限中で、`until` がエンジンの示したリセット。明示されたリセットが過ぎる、そのエンジンがターンを返す、gatewayの再確認で枠が開いている、のどれかで記録は消える。`degraded` は、終わりの時刻を示さなかった失敗の印で、セッションの開始先は変えない。
- **ログインしていない切替先には留まらない。** 切り替えた先がログインを拒否したら（別のプロセスで試し直しても同じなら）、切替を取り消し、元の失敗の扱いに戻る。利用上限なら、上の待ち方になる。そのエンジンは30分のあいだ切替先から外れる。
- **仕事をしたターンは、最初からやり直さない。** ツールの実行や出力が観測された試行は、同じ依頼を最初から流し直す再試行（エンジン側の会話の作り直し、一時的な障害の再試行、切替先のログインの再確認）の対象から外れる。その失敗がターンの答えになる。実行済みの操作があるかもしれないので、同じ依頼を手で流し直す前に結果を確かめる。

## モデル・effort・会話の引継ぎ

移行元のモデルIDを別プロバイダへそのまま渡さない。既定では切替先の `engines.<target>.model` を使う。固定モデルを対応付ける場合だけ、**移行元**の `fallbackModelMap` に設定する。

```yaml
engines:
  claude:
    fallbackModelMap:
      claude-opus-5-5: gpt-5.6-sol
  codex:
    fallbackModelMap:
      gpt-5.6-sol: claude-opus-5-5
```

これはID対応の例であり最新推奨ではない。元sessionのpinとキーが一致し、対応先が切替先モデルレジストリに存在し、認証アカウントで実行できることを確認する。不正／未登録のmapは切替先既定へ戻る実装。通常はmapなしで十分。effortも切替先モデルの対応値で再解決される。

gatewayのsession IDは保ち、CLI固有のsession IDは `transportMeta.engineSessions` で別々に保持する。会話・失敗前の部分進捗を渡し、既に行ったファイル変更や外部操作を照合して続行する。引継ぎ文は追加の権限でも成功証明でもない。

`engineOverride` に元engine/model/effortと復帰時刻を保持し、期限後の次の実行時に元へ戻す。復帰時刻は、エンジンがリセットの時刻を示した利用上限ならその直後で、最長でも12時間後（それより先のリセットは、12時間たった時点で元のエンジンを実際に試し、まだ上限中なら改めて切り替える）。上限の記録が先に消えたときは、期限を待たずに次の実行で戻る。リセットの時刻が無い利用上限は6時間、無応答／timeoutは5分。経過しただけでバックグラウンドで即時切り戻すわけではない。切り替えるとき、離れるエンジンがそのセッションのために動かしていた処理は止める。元へ戻る際も移行中の会話を同期する。DBや `transportMeta` を手で書き換えて切替を実現しない。

## 旧方式でできること

旧実装に双方向のキーを追加しても実現しない。Claude制限時→Codexだけなら：

```yaml
sessions:
  rateLimitStrategy: fallback
  fallbackEngine: codex
```

`wait` は切り替えずに利用制限の解除を待つ（待つ長さは版による。同梱する実装では上の「利用上限に当たったとき」）。旧経路では `engines.claude.fallback: []` だけでは無効化できない。旧版のWeb経路にはモデルpinをCodexへ持ち越す実装もあるため、ClaudeモデルをpinしたWeb sessionでは対応修正を含む更新が必要。未知のモデルIDを登録してエラーを隠さない。

## 設定後に確かめること

1. 両CLIが **gatewayの実行環境** で動作し、認証済みか。モデル一覧や `available: true` だけでは不十分。利用上限の記録は `GET /api/status` の `engines.<名前>.health` で読む。
2. 依頼の対象が新規既定、既存session、社員、cron、Web、Slackのどれか。既定変更が既存sessionのpinまで変更したと思わない。
3. 設定再読込後のchain・strategy・timeout・モデル対応とログ。検証用の隔離session／fake engineで両方向、無応答、利用制限、停止、両方失敗、復帰後の文脈を確認する。実アカウントの枠を使い切って試験しない。
4. ソース環境なら既存の `sessions/__tests__/engine-fallback.test.ts`、`manager-engine-fallback.test.ts`、`gateway/__tests__/engine-fallback-api.test.ts`（対応版）、旧版の `engine-fallback-revert.test.ts` を使う。設定保存と切替実行の確認結果を分けて報告する。
