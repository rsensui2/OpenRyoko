---
# ryoko migrate --auto（ryoko update）は、この migration を適用済みにしません。
# AI セッションか所有者の作業が要る手順を含むためです。ryoko migrate で適用します。
auto: false
---

# 2026.10.13: バックアップ、再起動後の再開、同梱スキルの同期

この更新だけで、cron のジョブ・`AGENTS.md`・`CLAUDE.md`・記憶の中身を書き換えないでください。`config.yaml` に書くのは、最後に行う `jinn.version` の更新だけです。末尾の表「新しい設定」のキーは、`config.yaml` に書き足しません（どれも、書かなければ既定値で動きます）。以下は、資料の差し替えと、所有者に伝えて確かめることです。

## 1. 資料を差し替える

`files/docs/` の12本で、ホームの `docs/` の同名のファイルを置き換えます。無いファイルは置きます（`backup.md` はこの版で追加しました）。`docs/` にあるほかのファイルには触れません。

1. `files/` の `.md` に、`{{` と `}}` で囲んだ `portalName`・`portalSlug` が残っていたら、置く前に埋めます。`portalName` は `config.yaml` の `portal.portalName`（無ければ `Ryoko`）、`portalSlug` は、その名前を小文字にして、空白の並びを `-` に替えたものです。`files/skills/` のファイルを置くときも同じです。
2. 埋めたあとの内容がホームのファイルと同じなら、そのファイルには触れません。違うときは、migrate スキルの手順どおりに退避してから置き換えます。
3. 置いたあと、`docs/` の `.md` にこの2つのプレースホルダが残っていないことを確かめます。

## 2. スキル

この版で内容が変わった同梱スキルは `cron-manager`・`management`・`migrate`・`onboarding`・`openryoko-config`・`self-heal` の6つで、`files/skills/` にはこの6つがディレクトリごと入っています。どう扱うかは、この作業を始めたときのプロンプトで決まります。

- **プロンプトが、同梱スキルは同期済みだと言っているとき**（"Bundled skills were synced before this session started."）: `files/skills/` を当てるのは、プロンプトに、同期が触らなかったスキルとして挙がったものだけです。扱い方は、プロンプトがスキルごとに示しています。「触らない」「そのままにする」とされたスキル（symlink、読めない、大きすぎる、ディレクトリでない）は、書き換えません。「何も当てない」とされたスキル（最新、削除済み、退役）には、何も入れません。
- **プロンプトが、`skills/` は利用者が管理する symlink で同期は動かないと言っているとき**（"no bundled skill was synced"）: 何も同期されていません。`files/skills/` の6つを、migrate スキルの「同期が動かないホーム」の手順で扱います。無ければ置き、あれば、所有者の追記を保ってマージします。
- **プロンプトに同期についての記載が無いとき**: migrate スキルの手順どおり、何も適用せずに止め、ターミナルで `ryoko migrate` を実行するよう伝えます。

`self-heal` は、必ず確かめます。この版で、修復の手順を書き直しました。古いコピーには、次の手順が残っています。

- `tmp/` を空にする
- 読めない `cron/jobs.json` を空のリストで作り直す
- DB のセッションの状態を書き換える

書き換えてよいコピー（同期が触らなかった「編集済み」「記録が無い」もの。同期が動かないホームでは、ホームにあるコピー）は、所有者の追記を保ったうえで、この3つを新しい版の手順に置き換えます。新しい版の手順は、壊れたファイルはバックアップから戻す、セッションは API で止めるかリセットする、DB の復元は所有者に任せる、です。書き換えないコピー（symlink など）にこの3つが残っているときは、書き換えずに、残っていることを最後の報告で伝えます。

## 3. 所有者に伝える（設定しなくても有効になるもの）

次の3つは、この版から、設定しなくても働きます。それぞれ、何が起きるかと止め方を所有者に伝えます。

- **日次のバックアップ**: gateway が動いている間、1日1回、ホームのアーカイブと DB のコピーを `backups/` に取ります。最初の分は、起動の約15秒後です。アーカイブには `config.yaml` の token と `.env` が入ります。保存先を変えるのは `backup.directory`、止めるのは `backup.enabled: false` です（`docs/backup.md`）。
- **再起動で打ち切られたターンの再開**: 次の起動で、打ち切られたセッションへ通知を1回送り、元の会話に返信させます。止めるのは `sessions.resumeInterruptedOnBoot: false` です（`docs/architecture.md` の「Session Lifecycle」）。
- **同梱スキルの同期**: gateway の起動時と `ryoko migrate` の実行時に、ホームに無い同梱スキルを追加し、未編集の同梱スキルを新しい版に置き換えます。置き換える前の中身は `.migration-backups/` に残ります。以前に削除した同梱スキルは、削除の記録がまだ無いので、最初の同期で1回だけ戻っています。要らなければ、もう一度削除してもらいます（以後は戻りません）。起動時の同期を止めるのは `skills.autoSync: false` です（`docs/skills.md` の「Keeping bundled skills up to date」）。

## 4. 確かめて、結果を所有者に伝える（読み取りだけ）

ここでは何も書き換えません。見つけたことを、最後の報告に書きます。

1. **cron のアラート**: `config.yaml` の `cron.alertConnector`・`cron.alertChannel` の設定の有無。この版から、セッションがエラーで終わった実行と、結果を配信できなかった実行は、実行履歴に `error` と記録され、設定があればアラートが出ます。これまでは `success` と記録していました。緑だったジョブが赤くなることがあります（`docs/cron.md` の「Run Logs」「Failure Alerts」）。
2. **Slack の `respondTo`**: `config.yaml` のトップレベルの `connectors.slack` に `respondTo` があるか。あれば、この版から初めて効きます。`channel: mention` なら、メンションの無いチャンネルの投稿に応答しなくなり、チャンネルのリアクションも扱わなくなります。意図した設定かどうかを、所有者に確かめてもらいます（`docs/connectors.md` の「Response Gating」）。
3. **オペレータ ID**: `portal.operatorSlackId`・`portal.operatorDiscordId` の有無と、値の形。値は、引用符で囲んだ、空でない文字列でなければなりません。数字だけの ID を引用符なしで書いたものや、空の値は無視され、キーがあるかぎり、誰もオペレータと認められません（起動のログに `[identity]` の警告が出ます）。この版から、チャットから Claude Code のコマンドを実行できるのは、オペレータ本人の `/compact` と `/clear` だけです。どちらかのキーがある環境では、`/model <名前>` と `/cron run|enable|disable` も、オペレータだけが使えます。キーが無い環境では、`/compact` と `/clear` は誰も実行できず、`/model` と `/cron` はこれまでどおりです（`docs/connectors.md` の「Commands in Chat」）。
4. **廃止した API と、変わった前提**: ホームの中のスクリプト・スキル・cron の prompt に、次が残っていないか。
   - `/api/files/transfer`、`POST /api/files` の `path`・`url`・`open`（廃止しました）
   - `/api/connectors/<名前>/send` の応答を確かめずに「送信済み」と扱う処理（届かなかった送信は 500 を返すようになりました）
   - `tmp/` を丸ごと消す処理（添付の置き場 `tmp/attachments/` は gateway が片付けます）
5. **`remotes:`**: `config.yaml` に残っているか。残っていても読み込みには影響しませんが、もう使われません。
6. **symlink のスキル**: `skills/` そのもの、または個々のスキルが symlink か。symlink は同期されず、リンクの先にある中身はバックアップに入りません。
7. **Slack の bot token**: Slack を使っている場合に伝えます。これまでの版は、Slack に共有されたリモートファイル（Google Drive など、Slack 以外のホストにあるファイル）の URL へ bot token を送っていました。そうしたファイルが bot の読める場所に共有されたことがある環境では、bot token の再発行を検討してください。この版からは送りません。

## 5. DB の復元は自分でしない

DB の復元には、gateway を止める必要があります。必要になったら、`docs/backup.md` の「DB を戻すとき」を所有者に渡します。`ryoko` のコマンドの実行を所有者に頼むときは、gateway が動いている場所（コンテナで動かしているなら、コンテナの中）で実行するよう添えます。

## 新しい設定（どれも省略できます。`config.yaml` には書き足しません）

| キー | 既定値 |
|---|---|
| `backup.enabled` | `true` |
| `backup.directory` | ホームの `backups/` |
| `backup.retention`（日数） | `14` |
| `backup.maxArchiveMb` | `512` |
| `backup.maxEntries` | `50000` |
| `sessions.resumeInterruptedOnBoot` | `true` |
| `sessions.resumeInterruptedMaxAgeMinutes` | `120` |
| `skills.autoSync` | `true` |
| `cron.alertThrottleMinutes` | `60` |
| `maxAttachmentMb`（`connectors.slack`・`connectors.discord`・`connectors.whatsapp` と、`connectors.instances[]` の各エントリ） | `200` |
| `connectors.slack.providerAuth.enabled` | `false`（`true` にすると、オペレータが自分の Slack の DM から Claude・Codex にログインし直せます。`docs/connectors.md` の「Provider Re-login」） |
