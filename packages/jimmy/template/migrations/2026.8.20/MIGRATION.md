# Migration: 2026.8.20（Gateway bind / connect URL分離）

## 概要

`gateway.host` はGatewayが待ち受けるアドレスであり、AI、Cron、CLI、スクリプトが
接続するURLではありません。`0.0.0.0` / `::` を接続先に使うとHostガードに拒否され、
2026.8.19では `421 host_not_allowed` による無言の失敗が発生する場合がありました。

本バージョンでは内部の接続先をloopbackへ統一し、認証付きの `ryoko api` コマンドを
追加します。

## 自動マイグレーション

`ryoko update` / `ryoko migrate --auto` は、インスタンスホーム内のテキストファイルから
以下を探し、変更前のバックアップを作成して置換します。

- `http://0.0.0.0:<port>` → `http://127.0.0.1:<port>`
- `http://[::]:<port>` → `http://[::1]:<port>`

対象は `~/.ryoko` 内の設定、Cron定義、スキル、ドキュメント、スクリプトです。
symlink、ログ、DB、モデル、source checkout、2 MiBを超えるファイルは変更しません。
バックアップは `~/.ryoko/backups/gateway-url-<timestamp>/` に保存します。

また、保護された `/api/` を直接curlしているのにBearer認証処理が見当たらないファイルは
警告します。認証処理は自動推測で書き換えず、次のCLIへ移行してください。

```bash
ryoko api GET /api/status
ryoko api POST /api/sessions --data '{"prompt":"..."}'
```

## 手動確認・再実行

```bash
ryoko migrate --check
ryoko migrate --fix
```

`~/.ryoko` 外の独自スクリプトは自動変更されません。直接HTTPが必要な場合は、子プロセスへ
渡される `$RYOKO_GATEWAY_URL` を接続先にし、`gateway-auth.json` のtokenをBearerとして
付与してください。通常はtokenを手書きしない `ryoko api` を推奨します。

## セキュリティ

Hostガードは緩和しません。`gateway.allowedHosts` に `0.0.0.0` / `::` を追加しても無視されます。
応急処置で追加していた場合は設定から削除できます。
