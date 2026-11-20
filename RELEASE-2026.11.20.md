# OpenRyoko 2026.11.20

![OpenRyoko 2026.11.20 — Ryoko を、チームで。](https://github.com/rsensui2/OpenRyoko/releases/download/v2026.11.20/openryoko-many-ryokos-banner.png)

Slack まわりの準備と調整を、Web の画面だけで済ませられるようにしたバージョンです。Slack アプリの作成、いつ話すかの設定、空気の読み方の選択を画面で行えます。また、メインの Ryoko と並んで動く Ryoko を何体でも作れるようになりました。

既存の環境では、主に **`connectors.instances` に Slack の接続を書いている場合**に、更新後に一度、会話が新しく始まります。詳しくは「更新の前に知っておくこと」を読んでください。

## Slack を画面からつなぐ

`/connect/slack` に、4つの手順の案内を置きました。各手順に、移動先の Slack の画面のスクリーンショットが付いています。

1. 名前とアイコンを決め、Slack の「設定トークン」（App Configuration Token の Refresh Token、`xoxe-…`）を1つ貼る。OpenRyoko が Slack アプリを作り、アイコンも設定する
2. Slack の画面で「許可する」を押す。gateway に自動で戻る
3. App-Level Token を作って貼る
4. つながったら、Slack での振る舞いを選ぶ

- 設定の途中でやり直したときは、作ったアプリを更新します。2つ目のアプリは作りません。接続まで済んだあとにもう一度設定すると、新しいアプリを作ります。
- 設定トークンは、設定の途中だけ保存します。アプリができたら消します。
- Slack は、インストール後の戻り先に https の URL しか使えません。gateway を http で開いている場合は、GitHub Pages に置いた中継ページ（`https://rsensui2.github.io/OpenRyoko/slack/callback/`）を経由して戻ります。中継ページは静的なページで、何も保存しません。Slack から受け取った一度だけ使えるコードを、ブラウザの中で gateway に渡すだけです。localhost・プライベート IP・Tailscale の IP（100.64.0.0/10）の gateway には自動で戻ります。それ以外のアドレス（ホスト名や公開 IP）は、移動する前にボタンで確かめます。
- 中継ページを使いたくない場合は、gateway を https で開くか、環境変数 `OPENRYOKO_SLACK_OAUTH_RELAY` に自分で置いた中継ページの URL を指定します。この URL は、クエリや `#` の付かない https の URL にしてください。それ以外は無視して、GitHub Pages の中継ページを使います。手作業で Bot Token を貼る方法も残しています。

## 振る舞いを設定ページのいちばん上に

設定ページを開くと、最初に「Slack での振る舞い」が出ます。

- **いつ話すか**: DM・グループ DM・チャンネル・自分が加わったスレッドのそれぞれで、返事をするかを選びます。チャンネルなら「@メンションされたときだけ」「会話を読んで、必要なときだけ（空気読み）」「すべてのメッセージに返事する」「チャンネルでは話さない」から選びます。
- **チャンネルごとの例外**: 特定のチャンネルだけ、別の動きにできます（`respondTo.channels`）。「いつも」にしたチャンネルでは、空気読みの判定を飛ばします。
- **空気はどうやって読む？**: 「会話を読んで、必要なときだけ」を選んだときの判定方法です。

| 選択肢 | 中身 | API キー |
|---|---|---|
| いま使っている AI で判断 | Claude Code か Codex が判定する。1通に数秒かかる | 不要 |
| 判断専用モデル | Jev（TypeSafe）、Jev（OpenRouter 経由）、OpenAI Decisions API。CLI より速い（TypeSafe の接続テストは 0.2 秒ほど） | 画面で保存し、「接続テスト」で確かめる |
| この PC の判断モデル | Ollama など、ループバックで動く判定モデル。メッセージは PC の外に出ない | 不要 |

- 設定は、Slack の接続の `triage.jev.provider`（例: `connectors.slack.triage.jev.provider`。値は `typesafe`・`openrouter`・`openai`）です。既定は `typesafe` で、これまでの設定はそのまま動きます。
- 判定する Slack の本文と履歴は、選んだ提供元へ送られます。送り先は提供元ごとに固定で、キーはその提供元にだけ送ります。
- OpenAI Decisions API には、OpenAI Platform の API キーが必要です。ChatGPT や Codex へのログインでは使えません。
- キーは `credentials/<提供元>.json` に、所有者だけが読める権限で保存します。API は `/api/integrations/decision-keys/:provider` です。

## Ryoko を何体も作る（「Ryoko たち」）

サイドバーに「Ryoko たち」を足しました。部下（社員）ではなく、メインの Ryoko と並ぶ1体として作れます。

- 作るときに、名前・絵文字・人格・動かす AI（Claude / Codex）・**記憶**を決めます。人格は「秘書」「エンジニア」などのひな形から選んで直せます。
- 記憶は、「メインの Ryoko と共有する」か「この Ryoko 専用の記憶を持つ」を選びます。あとから切り替えても、専用の記憶は消しません。
- 作ったら、そのまま専用の Slack アプリをつなぐ画面に進みます。手順はメインと同じです。
- 新しく作った Ryoko は、チャンネルではメンションされたときだけ話します。メインの Ryoko と同じチャンネルにいても、2体が同時に返事をしにくくするためです。ただし、一度加わったスレッドでは、メンションなしでも続けて返事します。両方が加わったスレッドでは、両方が返事をすることがあります。
- 会話は bot ごとに分かれます。同じ人が両方の bot に DM しても、互いの会話の続きにはなりません。
- 定義は `org/ryokos/<name>.yaml`、専用の記憶は `ryokos/<name>/` に置きます。API は `/api/ryokos` です。

**専用の記憶は、AI への指示で分けています。** 同じホームの上で動くので、ファイルの読み取りまで仕組みで止めるものではありません。完全に分けたい場合は、OpenRyoko を別に立ててください。記憶を使ってよい相手（`portal.trustedSpeakers`）は、すべての Ryoko で共通です。

## 更新の前に知っておくこと

- **`connectors.instances` の Slack の接続は、一度だけ会話が新しく始まります。** セッションのキーが、接続の id から始まるようになりました（例: `slack-hana:dm:U…`）。DM やスレッドは、更新前のセッションを続けません。`connectors.slack` の接続は、これまでのキーと会話をそのまま使います。
- **Ryoko や社員に結びついた bot は、ほかのアシスタントのセッションを続けなくなりました。** このバージョンから作られたセッションは、2つの bot をまたいで続きません。更新前に社員の bot が作ったセッションは、メインの bot が続けることがあります。気になる DM は `/clear` で新しく始めてください。
- **`send_message` で接続を指定しないときの送り先が変わりました。** id が `slack-<英小文字・数字・ハイフン>` の接続から始まった会話では、その接続の bot から送ります。これまでは、いつもメインの bot から送っていました。社員の bot がチャンネルに招待されていないと、送れないことがあります。
- **`connectors.instances` の接続のうち、存在しない社員に結びついたものへのメッセージは、返事をせずに捨てます。** これまでは、メインの Ryoko が代わりに答えていました。
- **`connectors.instances` の接続のうち、id が `slack`・`discord`・`telegram`・`whatsapp` のものと、前後に空白のある id のものは、起動しません。** 名前を変えてください。名前を変えると、その接続の会話はもう一度新しく始まります。cron の `delivery.connector` など、古い id を書いている箇所も合わせて直してください。
- 新しく足した機能は、使い始めるまで動きません。

## 更新

Node.js `^22.23.4`、`^24.22.1`、`^26.12.1` を使ってください。いつもの方法で `openryoko@2026.11.20` を入れ、gateway を動かしている環境で `ryoko migrate` を実行し、いつものサービス管理で再起動します。Docker の場合は、新しいパッケージでイメージを作り直してコンテナを作り直します。インスタンスのホームなどのマウントしたデータは残してください。

migration は、上の動きの変化と新しい機能を伝え、同梱スキル `openryoko-config` の更新を当て、`jinn.version` だけを書き換えます。応答の設定、接続、社員、ジョブ、指示書、記憶は変えません。

## 確かめたこと

- クリーンな checkout で、Node 22 と Node 24 のテスト・型チェック・ビルドが通ることを確かめました。
- Slack の設定トークンからのアプリ作成、アイコンの設定、中継ページ経由の「許可する」からの自動の戻りを、実際の Slack ワークスペースで確かめました。
- Jev（TypeSafe）の接続テストを、実際の API で確かめました。OpenRouter と OpenAI Decisions API は、公開されている仕様に合わせて作り、テストで確かめています。実際の API での確認はまだです。

PR: [#124](https://github.com/rsensui2/OpenRyoko/pull/124)、[#125](https://github.com/rsensui2/OpenRyoko/pull/125)、[#126](https://github.com/rsensui2/OpenRyoko/pull/126)
