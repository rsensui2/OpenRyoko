# JevとSlackの応答判定

## 役割と対応確認

JevはTypeSafe APIで「黙る／リアクション／返信」の入口を判定する。返信すると決まった後の作業は通常のClaude Code／Codex等へ渡す。

このスキルと同梱する実装は、Jevによる判定・能力の考慮・未依頼の場面への参加率設定に対応している。旧版や別ホストの稼働環境へ設定する際は、対象の `connectors/slack/triage-jev`、`triage` のbackend分岐、`integrations-typesafe-api` のルート配線と `proactiveParticipationPercent` の利用箇所を確認する。スキルだけをコピーした場合や、型にキーを足しただけでは有効にならない。

## 設定する接続先を特定する

通常は `connectors.slack.triage`。名前付きSlackなら `connectors.instances[]` の対象 `id` の **`config.triage`**。同じ種類の別コネクタを変えない。配列の部分更新はできないので、全要素を保って対象要素だけ変更する。

```yaml
connectors:
  slack:
    triage:
      enabled: true
      backend: jev
      engine: claude
      model: claude-haiku-4-5
      timeoutMs: 30000
      threadContextLimit: 10
      conversationIdleTimeoutMs: 1800000
      conversationMaxEntries: 5000
      jev:
        fallback: none
        useCapabilities: true
        proactiveParticipationPercent: 0
        model: jev-1.13.0
        apiKeyEnv: TYPESAFE_API_KEY
        timeoutMs: 3000
        maxConcurrent: 4
        minProbability:
          reply: 0.8
          react: 0.9
          silent: 0.97
```

既存設定へマージする例。モデルは確認した実装の値であり、最新推奨や利用可能性の保証ではない。

| 設定 | 挙動／注意点 |
|---|---|
| `enabled: false` | トリアージ自体を無効にする。応答を全部止める設定ではない |
| `backend: cli` | 従来CLIで判定（backend未指定時の既定） |
| `backend: jev-shadow` | CLIの判断で応答し、Jevを並行観測。CLI起動数は減らない |
| `backend: jev` + `jev.fallback: none` | Jevと既存の宛先・会話ルールで判断。Jevの失敗・不確実さを理由に判定CLIを起動しない |
| `jev.fallback: cli` | Jevが採用できないときに `triage.engine/bin/model` で従来判定を実行 |
| `jev.useCapabilities` | 既定true。社員の役割・提供サービスとスキルの名前／説明を判定材料にする。スキル本文・MEMORY・認証設定は送らない |
| `jev.proactiveParticipationPercent` | 0〜100の整数、既定0。未依頼でも具体的に役立てると判定した場面への参加率。`useCapabilities: true` が必要。100は対象条件を満たす機会すべて、50は平均して半分に参加する |
| `jev.timeoutMs` | 既定3000ms、最大10000ms。外側の `triage.timeoutMs` はCLI用で別 |
| `jev.maxConcurrent` | gatewayプロセス内の上限。既定4、最大16 |
| `jev.minProbability` | 返信・反応・沈黙の判定閾値。0〜1。確率を正解率と同一視しない |
| `conversationIdleTimeoutMs/conversationMaxEntries` | 通常の1対1会話の期限（既定30分）／件数上限（既定5000） |

`fallback: none` は「すべての障害で沈黙」ではない。DM・明示メンション・根拠のある続行は保護し、不確かな部屋の会話には沈黙する。純粋な感謝等はリアクションになり、作業に入る時は👀が付く。名前だけの呼びかけ、全体への依頼、他人宛て、他botへの続行を分けて検証する。

能力一致だけで会話へ割り込むわけではない。自己名は接続先社員の `displayName` → `name` → `portal.portalName` → Ryoko。別社員のスキル説明に出る名前を自己名として設定しない。

## 呼ばれていない時の参加率

ダッシュボードのJev設定で `proactiveParticipationPercent` を変更できる。既定の0では未依頼の提案をしない。0より大きい場合は、能力との具体的な一致に加えて「今、未解決の困りごとに役立てるか」を追加判定し、その条件を満たした機会だけを指定割合で選ぶ。100でもすべての発言へ応答するわけではない。明確な人宛て、解決済み、担当者が対応中、引用、単なる雑談、参加不要の意思表示は対象外。会話履歴が不完全な場合も参加しない。

名指しの依頼、通常の返信・会話継続、軽いリアクションにはこの割合を適用しない。`useCapabilities: false` なら未依頼の参加判定も無効になる。`jev-shadow` ではJevは観測のみで、実際の参加はCLI判定に従う。`respondTo` やallowlistなど入口の制限は引き続き先に適用される。

同じ投稿の再処理で抽選し直さず、割合による見送りをCLIで再判定しない。参加時は👀を付け、回答エンジンへ自発的な提案であることを伝える。参加の判定は外部操作の承認を意味しない。

## 認証キー

対応版の設定画面（Jev／TypeSafe連携）で登録する。APIは `GET /api/integrations/typesafe` で `configured/source` だけ取得し、`PUT` でキーを保存、`DELETE` で保存済みキーのみ削除する。秘密値をコマンドの `--data` やチャットに埋め込まない。

- 保存先は対象ホームの `credentials/typesafe.json`（所有者のみ読み書き）。APIからキー自体は返さない。rawファイルを表示して確認しない。
- `apiKeyEnv: TYPESAFE_API_KEY` の既定では、保存済みキー → gatewayプロセスの環境変数の順。独自の変数名ならその変数だけを使い、UI保存キーには戻らない。
- 環境変数変更にはgatewayの再起動、Docker Composeの `env_file` 変更には通常コンテナ再作成が必要。対話シェルでexportしただけでは起動済みdaemonへ届かない。
- 保存キー削除後も環境変数があれば利用可能なまま。`source` を確認する。標準のstatus/test APIは既定キーを調べるため、独自 `apiKeyEnv` の認証成功までは証明しない。

依頼された接続設定の検証には、合成入力だけを送る `POST /api/integrations/typesafe/test` を使える。接続先は `https://api.typesafe.ai/v1/systemone` に固定。これは外部API呼出しであり、通常運用ではSlackの判定対象本文・履歴・有効なら役割／スキル説明がTypeSafeへ送られることを設定時に伝える。会話本文を使った評価やSlackへのテスト投稿を暗黙に追加しない。

## 遅延・取りこぼしの切り分け

1. `respondTo`・allowlist・コネクタhealthで入口を確認する。`triage`より前に落とされていないか。
2. Jevの `backend/fallback` とキーのsource、固定エラー理由、latencyを確認する。`jev-shadow`や`fallback: cli`ではCLIが動き得る。
3. 返信の作業エンジン、`goalExtraction`、Codexの完了評価は別の呼出し。Jev専用にしてもそれらは止まらない。ユーザーが「判定CLIを減らす」と言っただけでゴール管理を無効化しない。
4. 会話追跡は実際に送れた文章を基準にする。リアクションだけで継続中にならず、他人の参加や会話期限も関係する。対応版の `state/slack-conversations-*.json` は実行状態であり、通常設定として書き換えない。
5. コネクタ再読込と `[triage:jev:active]` / `[triage:jev:shadow]` の診断結果を確認する。ログに会話本文・キーを保存しない。

Jevから従来判定へ戻すなら `triage.backend: cli`。会話追跡はそのまま継続する。CLI起動を避けたい依頼では自動的にこの切り戻しを選ばず、希望に合う `jev.fallback: none` を保持して原因を報告する。

ソースでの一次情報：`connectors/slack/triage.ts`、`triage-jev.ts`、`conversation-tracker.ts`、`shared/triage-capabilities.ts`、`shared/typesafe-credentials.ts`、`gateway/integrations-typesafe-api.ts`。同じディレクトリのテストと、ソースリポジトリの `docs/jev-slack-triage.md` も参照する。
