# Claude エンジンの接続先（endpoints）

Anthropic 互換の API を持つサーバー（別の Mac で動く oMLX など）に、特定のモデルだけを送る。

```yaml
engines:
  claude:
    model: claude-opus-5-5
    endpoints:
      - name: local-mac
        baseUrl: http://100.64.0.10:1236
        apiKeyFile: /path/to/.ryoko/secrets/local-mac.env
        apiKeyEnv: LOCAL_MAC_API_KEY
        models:
          - my-local-model
          - id: my-local-model-uncensored
            label: ローカル（無検閲）
```

セッション・社員・cron ジョブのモデルに `my-local-model-uncensored` を指定すると、Claude Code（headless の `claude -p`）がこのサーバーに接続する。gateway から受け継ぐ `ANTHROPIC_*` の値はすべて外し、`ANTHROPIC_BASE_URL` と `ANTHROPIC_API_KEY` に接続先の値を入れる。Claude Code が内部で使う補助モデル（サブエージェント・バックグラウンド処理）も同じモデルにそろえ、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` で Anthropic への付随通信を止める。ここに書いていないモデルは、これまでどおり Anthropic へ送る。

## 項目

- `name`：ログ・エラー・モデル一覧の表示名に使う。
- `baseUrl`：http(s) の URL。`/v1`・認証情報・クエリを含めない。公開ネットワーク上の http は、鍵が暗号化されずに流れるので起動時に警告する。
- `apiKeyEnv` / `apiKeyFile`：どちらか一方は必須。両方あるときは環境変数を先に見て、無ければファイルを読む。ファイルは鍵だけを書いた1行か、`KEY=VALUE` の行の並び。後者は `apiKeyEnv` と同じ名前の行を使う。`apiKeyEnv` が無いときは、`KEY=VALUE` の行がちょうど1行の場合だけ使う。
- `fallback`：`true` にすると、接続先で失敗したターンを `engines.claude.fallback` の代替エンジン（既定は Codex）へ引き継ぐ。既定は `false` で、ローカルで扱う仕事をクラウドへ渡さない。
- `models`：モデル ID の文字列か、`id` に `label`・`contextWindow`・`supportsEffort`・`effortLevels` を添えたもの。`supportsEffort: true` を書かない限り、`--effort` は渡さない。

接続先のモデルは、ダッシュボードと Slack のモデル選択に、既存の Claude モデルの後ろに並ぶ。`models:` ブロックで Claude のモデルを限定していても表示する。同じモデル ID を2つの接続先に書いた場合は、先に書いたほうを使う。

設定ファイルの再読み込みで反映し、gateway の再起動は要らない。実行中の Claude プロセスは起動時の接続先のまま動く。

## Anthropic へ送らないための決まり

- 鍵が見つからないとき、項目の誤りで接続先が無効になったときは、そのモデルのターンを失敗させる。Anthropic へは送らない。
- 接続先のターンの成否は、Anthropic アカウントのログイン・利用上限の記録に数えない。Anthropic が利用上限でも、接続先のモデルで始まるセッションは接続先で動く。
- `engines.claude.interactive: true` の間も、接続先のモデルは headless で動かす。
- 接続先のセッションを複製すると、複製の1ターンも接続先で動く。
- `sshHost` の社員は、接続先の URL と鍵をリモートへ持ち込めないので、接続先のモデルを使えない（エラーになる）。

## 注意

- 接続先のモデルも、Anthropic のモデルと同じ権限で動く（`--dangerously-skip-permissions`、gateway の環境変数、作業ディレクトリ）。外部へ漏れないのは Anthropic の認証情報と依頼の内容で、モデルが手元で触れられる範囲は変わらない。信頼できないモデルを登録しない。
- Slack のトリアージ、ゴールの抽出・判定など、モデル選択と別に動く補助処理は、それぞれの設定どおりのエンジン（Haiku・Codex など）を使う。
- モデル管理画面（`/models`）には表示しない。社員・cron ジョブのモデルとして直接書く。
