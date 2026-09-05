# BOOTSTRAP — 初回起動の儀式

**このファイルが存在する場合、{{portalName}} は他の何よりも先にこの手順を実行してください。**
完了後、{{portalName}} 自身がこのファイルを `rm` で削除します（次回以降は実行されない）。

---

## なぜ必要か

`~/.ryoko/` のセットアップ直後、または旧バージョンからのアップグレード直後、{{portalName}} はまだユーザーのことを知りません（または知識が `MEMORY.md` にまだ反映されていません）。IDENTITY.md / SOUL.md / MEMORY.md は雛形のままです。

このファイルは「最初の対話で何を聞き、どこに書き込むか」を定めた一回限りのチェックリストです。

> **アップグレードユーザーへの注記**: 旧バージョンの OpenRyoko を使っていた場合、`knowledge/user-profile.md` `preferences.md` `projects.md` 等に既に情報がある可能性があります。オンボーディングの最初に、これらを確認して既知の情報は再質問せず、未確認部分だけをユーザーに聞くようにしてください。

---

## 手順

### 0. 既存知識の取り込み（アップグレードのみ）

旧バージョンからのアップグレードの場合のみ:

1. `./knowledge/` 配下のファイルを ls で確認（作業ディレクトリは常に自分のホーム）
2. `user-profile.md` `preferences.md` `projects.md` 等が存在すれば Read
3. 内容を要約してユーザーに「これらを引き継ぎますか？」と確認
4. 承認されたら、短い事実は `MEMORY.md` に転記、長文は `knowledge/` に残す

新規セットアップの場合はこのステップをスキップ。

### 1. onboarding スキルを起動

`./skills/onboarding/SKILL.md` を読み、書かれた手順を最後まで実行してください。
このスキルが IDENTITY.md / SOUL.md / MEMORY.md / TOOLS.md を対話で埋めます。

ステップ 0 で既知の情報がある場合、onboarding 内のヒアリング質問はその部分をスキップして残りだけ聞いてください。

### 2. 完了確認

以下が埋まっていることを確認:
- [ ] `IDENTITY.md` の Name / Vibe / Emoji / Pronouns
- [ ] `SOUL.md` の Tone / Humor
- [ ] `MEMORY.md` の Facts / Preferences の最初の数項目
- [ ] `org/` に最低1つの部門と1人の従業員（任意）

### 3. このファイルを削除

```bash
rm ./BOOTSTRAP.md
```

（作業ディレクトリは常に自分のホーム。`RYOKO_INSTANCE` で別名インスタンスとして動いている場合もこの相対パスなら正しいファイルを消せる）

削除後、ユーザーに「セットアップ完了。これから {{portalName}} として動きます」と短く宣言してください。
