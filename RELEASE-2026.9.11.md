# Macのjinn-devで2026.9.11の公開と実機更新を仕上げる

OpenRyokoの管理者向けの引き継ぎです。このPRは、command cron、ジョブ別effort、更新通知のバージョン比較修正、移行手順を含みます。PRの作成ではnpm公開もコンテナ更新も行われません。

初回は公開物の確認まで読み、公開・デプロイ・配布パッケージの順に進めてください。以下のパスは管理者のMacの配置例です。

## jinn-devでPRを確認し、公開するcommitを固定する

```bash
cd ~/jinn-dev
git status --short
git fetch origin
gh pr view feat/cron-command --repo rsensui2/OpenRyoko
gh pr checkout feat/cron-command --repo rsensui2/OpenRyoko
```

作業中の変更があれば先に保存します。PRの内容を確認し、マージする場合はマージ後のmainを取得してから以降の検証を行ってください。公開するソースに未コミット変更を残さず、commitを記録します。

```bash
OPENRYOKO_RELEASE_SHA=$(git rev-parse HEAD)
npm view openryoko dist-tags --json
node -p "require('./packages/jimmy/package.json').version"
```

予定版は2026.9.11です。既にnpmに同じ版がある場合は上書きできないので、公開済みの内容を調べてください。版を変更する場合はmigrationとBasic／Advancedの最低要求も揃え、変更後に検証します。

## Webを先にビルドし、検証したtarballを公開する

Node.js 22以上が必要です。今回更新した依存関係も、lockfileに従って取得します。

```bash
cd ~/jinn-dev
npx --yes pnpm@10.6.4 install --frozen-lockfile
npx --yes pnpm@10.6.4 audit --prod
cd packages/web
npm test
npm run build
cd ../jimmy
npm run typecheck
npm test
npm run build
npm pack
tar tzf openryoko-2026.9.11.tgz
shasum -a 256 openryoko-2026.9.11.tgz
```

tarballには `dist/bin`、`dist/web`、`dist/src/cron/command.js`、`template/docs/cron-commands.md`、2026.9.11のmigrationが必要です。配布前の実動検査は、外部コネクタを設定しない隔離インスタンスで行います。認証付きAPIから終了コード0と非ゼロのcommandを作成・起動し、履歴に終了コードが残り、AIセッションが0件のままであることを確認してください。

```bash
npm whoami
npm publish ./openryoko-2026.9.11.tgz
npm dist-tag ls openryoko
npm view openryoko@2026.9.11 version dist.shasum
shasum openryoko-2026.9.11.tgz
```

npmの公開認証はMac側で設定します。ログイン確認やdry-runだけでは公開権限まで保証されません。公開後は版とSHA-1が一致することを確認し、このtarballを実機へ使います。

## 同じtarballをDockerイメージへ入れて確認する

`~/openclaw-sandbox` のDockerfile、compose、現在のイメージID、`openryoko-local.tgz` を退避します。コンテナとcomposeのサービス名は `docker inspect` で確認してください。

Dockerfileがローカルtarballを上書きインストールする構成なら、公開した `openryoko-2026.9.11.tgz` を `openryoko-local.tgz` へコピーします。`ARG OPENRYOKO_VERSION` も2026.9.11へ更新します。引数だけ変えると、最後に古いtarballで上書きされることがあります。

イメージをビルドし、コンテナを入れ替える前に候補イメージの `ryoko --version` を確認します。実行中のAI作業とcommandジョブが終了していることを確認してから、対象サービスを `docker compose up -d --no-deps <service>` で再作成します。

```bash
docker exec openclaw-sandbox ryoko --version
docker exec openclaw-sandbox ryoko migrate
docker exec openclaw-sandbox ryoko api GET /api/status
docker exec openclaw-sandbox ryoko api GET /api/cron
```

`/health` はWeb画面を返す場合があり、HTTP 200だけではGatewayの正常性を判断できません。認証付き `/api/status` と、Slack／Discordの接続状態を確認します。既に導入済みの巡回・モデル設定は維持し、新しいcron-managerの差分を反映してください。

次の予定実行では `kind: command`、終了コード、成果物、AIセッションが作られていないことを照合します。外部送信のある巡回を、確認のためだけに手動実行しないでください。

不具合時は対象ジョブを無効にし、退避したイメージと設定を復元します。command対応前の本体へ戻す場合はジョブ定義も戻す必要があります。データを保持するボリュームは削除しません。

## 本体の公開後にBasic／Advanced 0.4.0を配布する

BasicとAdvancedは、それぞれ `feat/low-cost-automation-v0.4` のPRで更新します。販売パッケージをnpmへ含める変更はありません。購入者向けリポジトリで配布を続けます。

各PRを確認し、検証したcommitを対象に `v0.4.0` のGitHub Releaseを作成します。リリース本文にはCHANGELOGの変更点と、Basicの `docs/updates.md`、Advancedの `UPDATING.md` へのリンクを載せます。タグのcommitと検証したcommitの一致を確認してください。本体も同様に、npm公開に使ったcommitを対象として `v2026.9.11` を公開します。

所有者にはGitHubの **Watch → Custom → Releases** を設定してもらいます。BasicにはAIなしの更新確認・通知スクリプトを同梱しますが、通知先は所有者が指定してから有効にする設計です。Release作成だけで全購入者への到達を保証するものではありません。

最後に、npmの版、公開commit、tarballの照合、実機の版と稼働、3つのRelease、所有者への案内方法を記録します。Ryokoには更新した実行方式とモデル設定を説明し、運用の正典に今回の差分を残してください。

ここでいうtarballはnpmの配布アーカイブ、migrationは既存設定への変更の適用です。不明点は、秘密値を除いたログと対象commitを添えてリポジトリの管理者へ引き継いでください。
