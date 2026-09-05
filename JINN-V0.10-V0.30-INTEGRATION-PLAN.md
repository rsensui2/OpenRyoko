# Jinn v0.10〜v0.30 → OpenRyoko 統合計画

更新日: 2026-08-17

## 方針

OpenRyoko の Slack/Discord/Telegram/WhatsApp、複数エンジン、Next.js UI、日本語運用を維持し、Jinn の改善を機能単位で移植する。両リポジトリは履歴とパス構成が異なるため、commit 単位の cherry-pick は行わない。

## 評価結果

| Jinn | 主な改善 | OpenRyoko での判断 |
|---|---|---|
| v0.10–0.12 | Telegram、Slack mention、PTY/WebSocket 安定化 | 主要部分は実装済み。回帰のみ個別移植。 |
| v0.13–0.17 | session paging/index、callback、音声/添付、承認 | callback・添付・承認は概ね実装済み。DB index は Phase 1、paging は Phase 2。 |
| v0.18–0.22 | 動的モデル、中途切替、検索、Grok/Hermes/Talk | モデルと再起動は実装済み。FTS5 は Phase 2、新 engine は需要確定後。 |
| v0.23–0.25 | snapshot cache、history paging、engine 別 native ref | engine 切替と reconciler は実装済み。snapshot/paging は Phase 2。 |
| v0.26 | auth、backup/disk check、log rotation、durable PTY、Todos/Workflows/Notes | log 上限は Phase 1。auth/backup/PTY は Phase 2。業務 object は製品判断が必要。 |
| v0.27 | model 別 usage bucket、長期 session anchor | ターン単位会計は Phase 1。bucket/anchor は Phase 2。 |
| v0.28.0–0.28.4 | multi-workspace、権限、migration、MCP 再生成、compaction | home 権限と context 上限は Phase 1。workspace は multi-instance と統合設計。 |
| v0.28.5–0.30 | 1M context、turn accounting、submit 確認、stall、proxy pool、Codex 引数 | 運用障害に直結するため Phase 1 の主対象。 |

## Phase 1：実装済み

1. Claude PTY の context/auto-compact 上限と local proxy の first-party 判定を保証する。
2. 累積 transcript から「ターン開始後の usage」だけを算出し、Web/connector/fallback/retry の各経路で一度だけ計上する。
3. warm PTY の `UserPromptSubmit` を確認し、未確認時は Enter を有限回再送する。添付パスは backtick で保護する。
4. 15 分経過かつ 5 分無活動で、復元可能な transcript がない turn を stall error にする。
5. suggestion/reasoning metadata を保存前に除去する。
6. instance home を POSIX `0700`、機密ファイルを `0600` に保つ。
7. SSE proxy の keep-alive pool を PTY 単位にし、stop 時に破棄する。pre-response socket error は backoff 付き最大 3 試行。
8. Codex の positional argument に `--` fence、Web API に空白入力検証を追加する。
9. gateway log から token/secret を除去して有限ローテーションし、session activity/parent 用 DB index を追加する。

## Phase 2：実装済み

- session/activity の安定 cursor pagination、message の timestamp+rowid paging、FTS5 検索、段階描画と旧履歴の追加読込。
- message-id anchor による検索結果ジャンプ、前後 window 取得、URL と sidebar 選択の競合防止。
- network bind 時の bearer/device auth、単回・5分期限 pairing code、Origin/Host 防御、browser device revoke。
- SQLite online backup（日次・7世代）、書込前 disk 容量判定、status での warning/critical 公開。
- 256 KiB 上限・atomic 保存の durable PTY snapshot、再起動後 scrollback 復元、正常終了時の stale snapshot 除去。
- permission prompt の通知、曖昧入力を拒否する strict parser、明示 opt-in 時だけの自動承認。
- instance registry の検証・重複排除・atomic 0600 保存、instance ごとの auth cookie、接続元 host を保つ切替 URL。
- Claude OAuth usage API の 5h/7d/model-scoped bucket 投影と Dashboard 表示。token と provider error は非公開。

## Phase 3：OpenRyoko の既存機能へ統合（重複実装しない）

- Todos は既存 Kanban / department board を正本とする。Jinn Todos を別 DB として追加すると状態が二重化するため、UI の paging/anchor 改善だけを今後取り込む。
- Workflows は既存 Cron、親子 session callback、goal queue を正本とする。Jinn Workflows の実行器を重ねない。
- Notes は既存 `knowledge/`、`docs/`、日次 memory を正本とする。検索は今回の chat FTS と分離し、将来は権限付き knowledge index として追加する。
- Plugins は既存 Skills / MCP / connector instance を正本とする。Jinn の Web plugin host は第三者 UI を同一 origin で動かすため、sandbox と署名仕様が固まるまで見送る。
- Talk は既存ローカル STT 音声入力を維持する。常時マイク・音声による副作用承認は誤操作面が大きく、明示 consent と監査ログを別設計してから追加する。
- Grok / Hermes / Antigravity は現時点では追加しない。Claude/Codex/Gemini の fallback と会計を安定させ、利用者・認証方式・保守責任が決まった engine だけ追加する。

この判断は「機能を捨てる」ものではなく、Jinn の有用な基盤改善を既存の OpenRyoko の正本へ適用し、同じ概念の DB・queue・permission surface を二重化しないための統合境界である。

## 受け入れ基準

- ターン会計、PTY env/submit/stall/sanitize、Codex 引数、home 権限、proxy retry/cleanup をテストする。
- `pnpm --filter openryoko typecheck`、`pnpm --filter @openryoko/web typecheck`、両 package の Vitest 全件、production build が成功する。
- connector、engine 切替、親子 callback、添付配信の外部仕様を変えない。
- network 公開時は未認証 HTTP/WS と cross-origin browser request を拒否し、loopback の従来操作は維持する。
- Claude CLI による差分レビューを各 phase 後に実施し、指摘を再現テストまたは明示的な非採用理由へ落とす。

## Claude 再監査記録

- 1回目: stale buffered hook、PTY death lifecycle、URL selection、history bound、Origin/CORS、permission state、pairing body 上限を指摘。再現可能な項目はすべて修正・回帰テスト化した。
- 会計の「cost/numTurns 未報告時に1ターン加算」は、上流 commit `3d290e22` の明示契約（cost 再構成不能でも完了ターンを数える）と一致するため変更しなかった。
- 2回目: permission 待ちを stall 解放する条件が lost-Stop 成功復元にも流用されていた点を指摘。成功復元は `activeTools=0 && !permissionPending && !upstreamInflight` に分離した。
- 最終確認: 並列 tool の無関係な PostToolUse が permission pending を消す競合を指摘。通知時点の全 in-flight tool が完了して `activeTools=0` になった時だけ解除し、自動承認も keystroke 送信だけでは成功扱いしないよう修正した。
- Graceful shutdown は debounce 中の PTY tail を `flushSync` してから SIGTERM し、復元済み screen は新 PTY 開始時に buffer 削除と xterm reset を行う。
- 最終結果: backend 85 test files / 727 tests、Web 10 test files / 72 tests、production build、`git diff --check` が成功。
