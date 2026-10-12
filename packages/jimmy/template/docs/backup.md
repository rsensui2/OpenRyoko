# Backup

`~/.ryoko/` の設定・cron・人格・記憶は、人もエージェントも直接編集します。壊したときに前の状態へ戻せるように、gateway が1日1回バックアップを取ります。設定は要りません。既定で有効です。

ファイルを壊したと気づいたら、手で作り直す前に `ryoko backup list` を見てください。昨日の状態が残っています。

## 何が取られるか

gateway が動いている間、対象ごとに前回の成功から24時間たつと取ります（起動した直後にも判定します）。できるものは2種類です。

**ホームのアーカイブ**（`home-<日時>.tar.gz`）。中身は次の種類に分かれていて、復元のときに `--only` で選べます。

| 種類 | 中身 |
|---|---|
| `config` | `config.yaml`、`.env`（あれば） |
| `cron` | `cron/jobs.json` |
| `cron-history` | `cron/runs/`（ジョブの実行履歴） |
| `persona` | ホーム直下の `*.md` すべて。`AGENTS.md`・`CLAUDE.md`・`SOUL.md`・`IDENTITY.md`・`TOOLS.md`・`BOOTSTRAP.md` と、自分で足した文書。`MEMORY.md` だけは `memory` に入る |
| `memory` | `MEMORY.md`、`memory/` |
| `org` | `org/` |
| `skills` | `skills/`、`skills.json` |
| `docs` | `docs/` |
| `knowledge` | `knowledge/` |
| `workflows` | `workflows/` のうち DB 以外 |

**DB のコピー**。セッションの記録（`sessions-<日付>.db`）と、workflow の定義と実行履歴（`workflows-<日付>.db`。workflow を使っている場合）。DB のコピーは1日に1つで、同じ日にもう一度実行しても取り直しません。

アーカイブには `config.yaml` の token や `.env` の鍵がそのまま入ります。ファイルは所有者だけが読める権限（0600）で作られますが、持ち出すときは秘密として扱ってください。

## 取られないもの

次のものはバックアップに入りません。入っている前提で作業しないでください。

- `logs/`、`tmp/`、`files/`（アップロードされたファイル）、`cron/commands/`（実行中のロックと出力）
- 対象の中にある `node_modules`、`.git`、`.venv`、`__pycache__`（どの深さでも）
- 認証の状態: `credentials/`、`connectors/`、`.whatsapp-auth`、`gateway-auth.json`、`auth-devices.json`。編集するものではないので、ホームごと失ったときは復元ではなく再認証します
- **symlink の先**。symlink はリンクとして記録するだけで、指している先の中身は読みません。`skills/` にホームの外のフォルダを symlink している場合、その中身は別の方法で守ってください
- ホーム直下の `*.md` 以外のファイル（`AGENTS.md.bak-…` のような退避ファイルなど）

## 保存先と設定

保存先は `~/.ryoko/backups/` です。ホームの中にあるので、目的は誤編集からの復旧です。ディスクごと失う事故に備えるなら、`backup.directory` でホームの外（別のディスクなど）を指定します。

```yaml
backup:
  enabled: true                  # false にすると日次のバックアップを止める
  directory: /path/to/backups    # 省略時は ~/.ryoko/backups
  retention: 14                  # アーカイブを残す日数
  maxArchiveMb: 512              # 1回のアーカイブに入れるファイル合計の上限
  maxEntries: 50000              # 1回のアーカイブに入れるファイル・ディレクトリ・symlink の数の上限
```

`retention` は日数です。バックアップのある日を新しい順に `retention` 日分残し、それぞれの日の最新を必ず残します。同じ日に何度も取った場合、その日の分は直近 3 個までです。手動で何回取っても、前の日の分が押し出されることはありません。復元の前に自動で取られる `pre-restore-…` も、同じ数え方で別枠に残ります。

DB のコピーは1日1つ、7 世代で固定です。

ホームの対象が `maxArchiveMb` か `maxEntries` を超えると、アーカイブは書かれず失敗として扱います（DB のコピーは続きます）。空のファイルやディレクトリは容量を取りませんが、数としては数えます。大きなファイルや不要なファイルの山を対象の外へ出すか、上限を上げてください。この失敗は次の日次の機会まで再試行しないので、直したあとは `ryoko backup run` で取り直せます。

2つの上限は、アーカイブを読むとき（`verify`・`restore`）にも掛かります。上限を上げて取ったアーカイブは、同じ設定のもとで読めます。`config.yaml` が壊れていて読めないときは既定の上限が使われるので、それを超えるアーカイブから戻すには、先に `backup:` の節だけを書いた最小の `config.yaml` を置いてください。

失敗は gateway のログ（`Backup failed (...)`）と、`GET /api/status` の `backup` に出ます。`level` が `warning` のときは、どの対象がなぜ失敗したかが `targets` に入っています。

## どこで実行するか

`ryoko backup` は、gateway が動いている場所で実行します。ホームをコンテナに bind mount している場合は、コンテナの中です。

ホスト側から同じホームへ向けて実行しないでください。コンテナの境界を越えると、プロセスの番号は通じません。ファイルのロックも、構成によっては共有されません。そのため、ホスト側のコマンドは動いている gateway を確実には見つけられず、`ryoko backup run` は、gateway が使っている DB を gateway に知られないまま読むことがあります。

## 戻し方

```bash
ryoko backup list                                    # 新しい順の一覧。左端が id
ryoko backup verify <id>                             # 読み戻して壊れていないか確かめる
ryoko backup restore <id> --only config --dry-run    # 何が変わるかだけ表示する
ryoko backup restore <id> --only config              # 実際に戻す
```

- `--only` には上の表の種類をカンマ区切りで渡します（`--only config,cron`）。省くと、アーカイブにあるすべての種類が対象です。まず `--dry-run` で確かめてください。
- ファイルの復元は、gateway が動いたままで構いません。`config.yaml`・`cron/jobs.json`・`org/`・`skills/` は、gateway が変更を検知して読み直します。
- **復元は上書きだけ**です。バックアップにあるファイルを戻し、バックアップに無いファイル（あとから足したメモや Skill）は消しません。消したいものは、表示された一覧を見て自分で消します。
- 戻す直前の状態は、自動で `pre-restore-<日時>` として退避されます。戻しすぎたら `ryoko backup restore pre-restore-<日時>` で、上書きされたファイルを復元前の内容に戻せます。ただし、これも上書きだけの復元です。**復元で新しく作られたファイルは、`pre-restore-…` へ戻しても消えません**。要らないものは自分で消します。どれが残るかは、`ryoko backup restore pre-restore-<日時> --dry-run` の「バックアップに無いので手を付けないファイル」で確かめられます（件数が多いときは `--json` で全件が出ます）。
- `cron` が戻すのは `jobs.json` だけです。実行履歴まで巻き戻したいときだけ `cron-history` を指定します。
- `persona` を戻すと、オンボーディングが終わる前のバックアップなら `BOOTSTRAP.md` も戻ります。`--dry-run` に「作成 BOOTSTRAP.md」と出たら、戻したあとで消してください（残すとオンボーディングがやり直しになります）。
- ホームの外を指す symlink を新しく作ることになる復元は、既定では拒否されます。自分で張ったリンクを戻すときは `--allow-external-symlinks` を付けます。
- `<id>` には、別の場所へ持ち出したバックアップのファイルパスも渡せます。

大きな変更の前に、いま取っておきたいときは `ryoko backup run` を使います。何度実行しても構いません（その日の分は直近 3 個が残ります）。

## DB を戻すとき

DB（`sessions-…`、`workflows-…`）の復元は、**gateway を止めてから**行います。動いている gateway の下で DB を差し替えると、記録が壊れます。

1. gateway を止める（`ryoko stop`。サービスやコンテナで動かしている場合は、その方法で止める）
2. 1分ほど待つ
3. gateway が動いていた場所で実行する。ホームをコンテナに bind mount している場合は、**コンテナの中**で実行する。gateway を止めるとコンテナごと終了する構成では、同じホームを mount した一回限りのコンテナで実行する
4. `ryoko backup restore sessions-<日付> --gateway-stopped`
5. gateway を起動する

`--gateway-stopped` は「止めたことを確認した」という申告で、必須です。コマンドも稼働中の gateway を自分で探しますが、DB を開いて確かめることはしません。使われているかもしれない DB は、開くだけで記録を壊すことがあるためです。見るのは次の2つだけです。

- PID ファイル（`gateway.json`・`gateway.pid`）が指すプロセスが生きているか
- DB と、その `-wal`・`-shm` が、直近1分以内に書き換えられているか

どちらかに当たると、何も変えずに断ります。gateway を止めた直後は、たいてい2つ目に当たります。手順2で1分ほど待つのはそのためです。

この確認は確実ではありません。コンテナの中の gateway の PID は、ホスト側からは見えません。1分以上なにも書いていない gateway は、動いていても見つけられません。ホスト側で実行すると、動いている gateway に気づかないまま差し替えてしまうことがあります。手順3のとおり、gateway が動いていた場所で実行してください。

置き換える前の DB は `pre-restore-<日時>-sessions` として退避されます。

エージェントは DB を復元できません。自分が動いている gateway を止める必要があるためです。DB の復元が要ると判断したら、上の手順をオペレータに伝えてください。
