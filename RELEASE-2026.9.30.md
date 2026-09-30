# OpenRyoko 2026.9.30 — Slack Canvas の連続失敗を停止

Agents View Canvas の編集が失敗しても失敗回数がリセットされ、30秒ごとに API 呼び出しとログ出力を続ける不具合を修正しました。作成・編集が10回連続で失敗すると同期を停止し、原因に応じた対処方法をログに表示します。

## 修正内容

- `restricted_action` などの編集エラーを自動停止の対象にしました。保存済み Canvas ID は保持し、重複作成を防ぎます。
- `missing_scope` やチャンネルのエラーを Canvas の削除と誤判定しないようにしました。`canvas_not_found` / `file_not_found` の再作成は維持します。
- チャンネル指定時に、そのチャンネル以外の同名 Canvas を自動採用する処理を削除しました。
- 設定画面と README に、既存 Slack アプリの再認可、Bot のチャンネル参加、Canvas の編集権限を確認する手順を追加しました。

## Canvas を有効にするには

1. 設定画面の Slack セットアップガイドから Manifest をコピーし、対象アプリの **App Manifest** に貼り付けて保存します。コピー用 JSON は Bot の `canvases:read` / `canvases:write` などの必要な権限を含みます。
2. 既存アプリは **OAuth & Permissions → Reinstall to Workspace** を実行します。Manifest の保存だけでは発行済みトークンの権限は増えません。Bot Token が変わった場合は OpenRyoko 側も更新してください。
3. Bot を表示先の専用チャンネルへ招待し、**Agents View Canvas** を有効にしてチャンネルを選び、保存します。既存 Canvas を使う場合は Bot に編集権限が必要です。

既存のチャンネル Canvas は内容全体をセッション一覧に置き換えるため、専用チャンネルを使ってください。チャンネル未指定時の独立した Canvas は、Slack のプランによって作成・編集が制限されます。

このリリースは繰り返し失敗する処理を停止するものです。対象 Canvas の権限やワークスペース側の制限は自動変更しません。原因を解消してゲートウェイを再起動すると同期を再開できます。

## 更新

```bash
npm install -g openryoko@2026.9.30
ryoko migrate --auto
ryoko stop
ryoko start
```

Docker 環境はイメージを更新して再作成してください。ローカル tarball を組み込む構成では、そのファイルも同じ版へ更新します。

## 検証

本体194ファイル・2,436テスト、Web19ファイル・128テストが成功しました。Canvas の回帰テストでは channel / standalone の連続失敗停止、成功後のカウンタリセット、削除後の再作成、別チャンネルの Canvas を採用しないことを確認しています。Web と本体のビルドも成功しました。

参考: [Slack アプリの再インストール条件](https://docs.slack.dev/app-management/distribution/)、[Canvas 編集の権限](https://docs.slack.dev/reference/methods/canvases.edit/)。
