# Migration: 2026.8.28 (MEMORY.md のプライバシーゲート付き注入)

## Summary

MEMORY.md（長期記憶）の扱いがコア機能になった。gateway が **private web セッションと、
`portal.trustedSpeakers` に載る相手との DM に限り** MEMORY.md を system prompt に注入する。
共有チャンネル・cron・employee セッションには注入されない。

これまで MEMORY.md はコードでは一切注入されず、テンプレート CLAUDE.md の `@MEMORY.md`
import（Claude エンジンのみ・**話者を問わず**）だけが読み込んでいた。この import は
新ゲートの迂回路になるため、既存インスタンスの指示ファイルから取り除く必要がある。

## 既存インスタンスへの適用手順（このファイルを読んだ AI セッションが実行する）

1. **`~/.ryoko/CLAUDE.md` から `@MEMORY.md` の行を削除する**（`@IDENTITY.md` `@SOUL.md` は残す）。
   ユーザーが独自に編集している場合も、`@MEMORY.md` の import 行だけをピンポイントで消す
2. CLAUDE.md / AGENTS.md の自己定義・記憶セクションに「MEMORY.md は毎セッション読む/読まれる」
   という記述があれば、次の内容に沿って書き換える（ユーザーの独自ルールは保持し、該当文だけ更新）:
   - MEMORY.md は自分から Read しない。gateway が信頼相手（private web セッション、または
     `portal.trustedSpeakers` に Slack ID を載せた相手との DM）とのセッションにだけ注入する
   - 共有チャンネルでは誰が話していても注入されない
   - 必要があって自分で Read した場合も、内容を当人以外に出力で出さない
3. **ユーザーに次の設定を推奨として伝える**（config.yaml の `portal:` 直上のコメント参照。
   勝手に値を推測して書き込まない — Slack ID はユーザーに確認する）:
   - `portal.operatorSlackId` — オペレータ本人の Slack ID。設定すると本人確認が ID の厳密一致になる
   - `portal.trustedSpeakers` — MEMORY を DM で注入してよい相手（オペレータ自身の ID も入れる）
4. 適用後、`~/.ryoko/CLAUDE.md` に `@MEMORY.md` が残っていないことを grep で確認する

## 互換性メモ

- `portal.operatorSlackId` / `portal.trustedSpeakers` 未設定でも動作は安全側
  （MEMORY は web セッションでのみ注入。Slack では一切注入されない）
- 旧挙動（@MEMORY.md による無差別読み込み）に戻したい場合は import を書き戻せばよいが、
  共有チャンネルでの個人情報露出リスクを理解した上で行うこと
