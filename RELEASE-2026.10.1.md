# OpenRyoko 2026.10.1 — Node 24 の SQLite クラッシュを回避

Node 24.19 以降のヘッダでビルドされた旧 better-sqlite3 が、GC 時に `Statement::~Statement()` → `RemoveEnvironmentCleanupHook` のアサーションで異常終了する問題に対応しました。依存を N-API 版の `better-sqlite3 ^13.0.3` に更新し、パッケージ内の依存を手動で差し替えなくても対策が適用されるようにしました。

2026.9.30 の追加修正として、次の未使用番号を採番しています。Node.js の対応条件は従来どおり 22 以上です。DB スキーマの変更はありません。

## 修正内容

- **SQLite の依存更新**：better-sqlite3 13.0.3 を採用しました。13 系は N-API を使い、対応プラットフォーム向けのプリビルドをパッケージに同梱します。
- **Node 24 の CI**：Node 24.21.0 でビルド・本体テスト・CLI 起動・セッション作成・中断セッションの復旧・全文検索・バックアップと再オープン・90秒間の GC 負荷試験を実行します。
- **Slack の空本文**：転送プレビューなどで本文が空または空白だけ、かつファイル添付がないイベントはスキップします。空のプロンプトで Claude CLI を起動することや、親メッセージを新しい依頼として処理することを防ぎます。ファイルだけの投稿は引き続き処理します。転送プレビューの本文展開は今回の対象外です。

## 更新

```bash
npm install -g openryoko@2026.10.1
ryoko migrate --auto
ryoko stop
ryoko start
```

Docker 環境はイメージを更新して再作成してください。ローカル tarball を組み込む構成では、そのファイルも同じ版へ更新します。

## 検証

- Node 22.20.0 と Node 24.21.0 で、本体194ファイル・2,439テストが成功しました。
- Linux の Node 24.21.0 で、ソースビルドした better-sqlite3 11.10.0 の同一アサーションによる異常終了を再現しました。13.0.3 は同じ90秒の再現スクリプトを完走しました。
- 合成データを使った隔離環境で、実際のセッション保存、GC、復旧、全文検索、バックアップの整合性と再オープン後の読み書きを確認しました。

参考：[Node.js の不具合報告](https://github.com/nodejs/node/issues/65446)、[better-sqlite3 13 の N-API 移行](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)、[PR #98](https://github.com/rsensui2/OpenRyoko/pull/98)。
