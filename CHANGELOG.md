# Changelog

> **バージョン体系について**: 2026.4.26 から日付ベース (`YYYY.M.D`) のCalVerに移行しました。npm semver の制約上、月・日の leading zero は付けません (例: 4月26日 → `2026.4.26`)。

## [Unreleased]

### 🐛 Fixes
- **Slack triage**: conversations now skip triage as soon as the bot has engaged AND only one human is speaking — scoped per-thread for threaded replies, and per-`(channel, user)` for non-threaded follow-ups. The decision is permanent until a third human joins (no TTL). Closes the silent-drop class of bugs where a bot+1 private channel was classified as `channel` and slow Haiku triage caused real user messages to be ignored, and also fixes the same problem for users who don't reply in threads. Replaces the old 10-minute `ActiveThreadTracker` window and the channel-membership-based DM-equivalent detector.
- **Slack triage**: bumped `DEFAULT_TIMEOUT_MS` from 8s to 30s. Real-world Haiku one-shot calls land at 5–9s in normal conditions and spike higher on slow API days; the 8s default was producing routine timeouts. Operators can still override via `connectors.slack.triage.timeoutMs` in `config.yaml`.

### 🗑 Deprecated
- `connectors.slack.triage.activeThreadTtlMs` — no longer used. Engagement is tracked permanently per-conversation now. The field is still accepted for backwards compatibility but has no effect.

## [2026.4.28] - 2026-04-28

### ✨ Features
- **`ryoko update`** — `npm install -g openryoko@latest` と `ryoko migrate --auto` を1コマンドで実行できるようにしました。`--no-migrate` でCLI更新だけも可能です。

## [2026.4.27] - 2026-04-27

### 🐛 Fixes
- **Slack typing indicator** — Slack の `assistant.threads.setStatus` を90秒ごとに更新し、長時間のエンジン実行中も「入力中...」表示が消えにくいように変更。
- **Slack status diagnostics** — typing status API の失敗を `warn` ログに出し、`missing_scope` / `no_permission` / `invalid_thread_ts` などの原因を確認しやすくしました。

## [2026.4.26] - 2026-04-26

### 🚀 リモートサーバー (Linux/systemd) 運用での詰まりポイントを一掃

VPS等で常駐させようとした初期ユーザーが踏んだ4つの落とし穴を全部潰しました。

#### 🐛 Fixes
- **`spawn claude ENOENT` (systemd配下)** — エンジン (Claude/Codex/Gemini) およびSlackトリアージのCLI起動を、起動時に純JSのPATH探索 (`shared/resolveBin.ts`) で絶対パス化するように変更。systemdの最小PATHでも動作。解決失敗時はインストールコマンド付きの親切なエラーを返す。
- **rootユーザーでClaude CLI拒否** — `shared/childEnv.ts` でuid==0検出時に `IS_SANDBOX=1` を自動付与しバイパス。同時に「root実行は非推奨、専用ユーザーを推奨」の警告ログを一度だけ出力。
- **WebUI Settingsで Slack トークン保存しても繋がらない** — `PUT /api/config` および `chokidar` watcher が、`connectors` または `portal.portalName/operatorName` の差分を検知すると `reloadAllConnectors()` を呼んでトップレベル＋インスタンスSlack/Discord/Telegram/WhatsAppコネクタを再接続。デーモン再起動不要。partial失敗 (例: 不正トークン) はUIにエラー表示。
- **クラッシュ後の自動復旧なし** — `scripts/systemd/openryoko.service` テンプレと `scripts/systemd/install.sh` を追加。`Restart=on-failure` + `RestartSec=5` で自動復旧。インストーラはユーザーの実シェル (bash/zsh/fish) でPATHを自動検出してunit fileに焼き込む。

#### 🏗️ Infrastructure
- `engines.node: ">=22"` を root / `packages/jimmy` / `packages/web` の package.json に明示。
- READMEに「🖥️ Linux サーバーで常駐させる (systemd)」セクションを追加。
- `SessionManager.setConfig()` / `setConnectorNames()` を追加 — config再読み込み時にセッションが boot 時の値を引きずる問題を解消。
- 連結器reloadを single-flight 化 (`reloadInFlight` mutex + pending coalescing) — 並行reload時の二重起動を防止。
- 連結器の停止 (`stop()`) が失敗した場合、参照を破棄せず手動再起動を案内 — 二重ライブクライアントによる重複応答を防止。
- API経由のconfig書き込み時に watcher の重複reloadを抑制 (`suppressNextConnectorReload`)、partial失敗時は抑制を解除して chokidar の retry チャンスを残す。

#### 🔒 Security
- `resolveBin` で `command -v ${bin}` のシェル展開を撤廃し、純JSの `process.env.PATH` 走査に置換。`engines.*.bin` を `PUT /api/config` 経由で書き換えられるため、シェルメタ文字を含む値で任意コマンド実行できてしまう脆弱性を修正。
- 同時に bin 名に `/`, `\`, NULL バイトを含む値を拒否 (path traversal 防御)。

#### ✅ Tests
- 新規: `shared/__tests__/resolveBin.test.ts` (絶対パス・PATH解決・コマンドインジェクション耐性)、`shared/__tests__/childEnv.test.ts` (root検出と IS_SANDBOX 注入)、`sessions/__tests__/manager-connector-names.test.ts` (setConnectorNames)
- jimmy: 23 files / **275 tests**、web: 7 files / 61 tests、すべて pass。

## [0.9.4-ryoko.2] - 2026-04-22

### 🐛 Fixes
- **Slack triage**: shared-channel barge-in fix — triage errors in ambient messages now fail silent (not reply) when `botUserId` is known, and explicit `<@other-user>` mentions are early-skipped regardless of thread activity. Breaks the cascade where one fail-open reply would mark a thread "active" and cause follow-ups to bypass triage for 10 minutes. ([#slack-triage](https://github.com/rsensui2/OpenRyoko/commit/61a010c))
- **Web chat input (IME)**: Enter during Japanese/Chinese/Korean IME composition no longer submits the message. Fixes split-message bug where confirming an IME conversion sent partial text. (#1, thanks @htpboost)

## [0.7.0] - 2026-03-19

### ✨ Features — Project Phoenix
- **Chat tabs** — Cmd+W close, Cmd+Shift+[/] switch, draft persistence, status indicators
- **Command palette** — cmdk-powered Cmd+K with actions, recents, sessions, skills search
- **Breadcrumb navigation** — context-aware breadcrumbs on all pages
- **ChatPane extraction** — reusable chat component decoupled from page
- **Enhanced sidebar** — expandable employee groups, pin/unpin, context menu, hover actions
- **React Query data layer** — query key factory, hooks for all resources, WS→cache invalidation bridge

### 🔧 Improvements
- **Tailwind migration** — 640→120 inline styles (81% reduction), shadcn token system
- **Header consolidation** — single 40px tab bar replaces 3 stacked headers on chat
- **Mobile UX** — more menu in top header, clean tab bar, responsive sidebar
- **Session state sync** — tabs and selected session stay in sync
- **Instant tab switching** — no scroll flash, useLayoutEffect for immediate scroll

### 🏗️ Infrastructure
- Goals CRUD API + SQLite table (backend, for future use)
- Cost aggregation API + budget enforcement system
- Mock engine for E2E tests
- Vitest setup (api + web), Playwright config, GitHub Actions CI workflow

### 🧹 Cleanup
- Removed: split view, goals/costs pages (no backend yet), 14 unused shadcn components
- Fixed: dual-fetch anti-pattern in sidebar, session delete via mutations
- Net: 81 files changed, +5,608 / -8,723 lines

## [0.3.0] - 2026-03-10

### 🔧 Improvements
- Codex engine now runs with `--dangerously-bypass-approvals-and-sandbox` — prevents Jimmy-managed Codex sessions from being constrained by CLI sandbox/approval defaults

## [0.2.0] - 2026-03-10

### ✨ Features
- Connector abstraction layer — connectors declare capabilities (threading, reactions, edits, attachments) and health status
- `replyMessage()` vs `sendMessage()` split — proper thread-aware message routing
- CronConnector — cron jobs are now message sources routed through SessionManager (unified flow)
- Slack config options — `shareSessionInChannel`, `allowFrom` whitelist, `ignoreOldMessagesOnBoot`
- Transport state tracking — new `transportState` field + queue depth visibility
- In-chat slash commands — `/cron list|run|enable|disable`, `/model <name>`, `/doctor`
- Runtime cron control — trigger/enable/disable jobs without restart
- Web UI: Slack settings toggles for new config options
- Web UI: Transport visibility — connector name, queue depth, transport state badges

### 🔧 Improvements
- Unified message routing — all sources flow through `SessionManager.route()` with uniform `IncomingMessage`
- Cron runner simplified — ~35% code reduction by delegating to SessionManager
- Capability-aware decorations — reactions/edits conditional on connector capabilities
- Config token masking — Slack tokens masked in `GET /api/config`
- Session queue monitoring — `getPendingCount()` and `getTransportState()`

### 🏗️ Infrastructure
- Build pipeline — web UI bundled into gateway dist
- Test suite — threads, queue, and registry tests using Node.js native test runner
- DB migration — auto-adds connector/transport columns, backfills from legacy fields

### 💥 Breaking Changes
- `Connector` interface expanded with new required methods: `replyMessage()`, `getCapabilities()`, `getHealth()`, `reconstructTarget()`
- `IncomingMessage` and `Session` types have new required fields
- `GET /api/connectors` response shape changed from `string[]` to objects with capabilities
- `startScheduler()` now takes `SessionManager` instead of engine map
- `sendMessage()` no longer posts to threads — use `replyMessage()`

## [0.1.1] - 2026-03-09

### 🐛 Bug Fixes
- Remove `@jinn/web` workspace dependency from published package — was causing `unsupported URL type "workspace:"` error on `npm i -g jinn-cli` (web UI is embedded as static files during build, not a runtime dependency)

### 🔧 Improvements
- Claude engine now runs with `--dangerously-skip-permissions` — prevents sessions from hanging on tool approval prompts in headless mode

## [0.1.0] - 2026-03-09

First release of the Jinn AI gateway platform.

### ✨ Core Platform
- Gateway server with HTTP REST API + WebSocket real-time events
- Session manager with context builder (32K char budget, progressive trimming)
- SQLite session registry with WAL mode
- Per-session serial execution queue
- File watchers for hot-reload (config, cron, org, skills)
- Daemon lifecycle management (start/stop/status as background process)
- Multi-instance support with dynamic home directory resolution

### ✨ Engines
- Claude Code CLI engine wrapper (spawn, JSON streaming, session resume)
- Codex SDK engine wrapper (in-process, streaming)
- Model/effort level passthrough and configuration

### ✨ CLI
- `jinn setup` — bootstrap ~/.jinn/ from templates
- `jinn start` / `stop` / `status` — daemon management
- `jinn create` / `list` / `remove` — instance management
- `jinn nuke` — permanent instance deletion with safety prompts
- `jinn migrate` — AI-assisted template migrations
- `jinn skills` — skill discovery + skills.sh integration
- `--port` flag for custom port binding

### ✨ Connectors
- Slack connector (Socket Mode via @slack/bolt)
- Thread/DM/channel source-ref mapping
- Reaction workflow (👀 → ✅/❌)
- Message splitting for long responses
- Attachment download support

### ✨ Organization System
- Employee personas (YAML) with departments, ranks, engine assignment
- Org scanner with @mention routing
- Department boards for inter-agent task tracking
- Rich employee identity + generic connector context
- Dynamic COO naming via onboarding

### ✨ Skills System
- Markdown-based skill playbooks (SKILL.md with YAML frontmatter)
- 10 built-in skills: management, cron-manager, skill-creator, self-heal, onboarding, migrate, sync, status, new, find-and-install
- Skill symlink syncing to .claude/skills/ and .agents/skills/
- skills.sh marketplace integration
- Skills directory watcher with WebSocket change events

### ✨ Cron System
- node-cron scheduler with hot-reloadable jobs.json
- Run logging to JSONL files
- Delegation pattern (cron → COO → employee → review → deliver)
- Optional delivery to connectors

### ✨ Web UI
- Full Next.js 15 static dashboard
- Chat interface with voice recording, file attachments, rich markdown
- Session browser with detail view
- Org map (React Flow) with grid/feed views + employee detail panels
- Kanban board with drag-drop, tickets, employee assignment
- Cron visualizations — weekly schedule heatmap, pipeline grid
- Cost dashboard with charts, anomaly detection, WoW comparison
- Activity console with log browser + floating live stream widget
- Global search (Cmd+K)
- Settings page + onboarding wizard
- 5-theme CSS system with accent color support
- shadcn/ui components

### ✨ Session Context
- Rich context injection (identity, CLAUDE.md, config, org, skills, cron, connectors, API reference)
- Local environment awareness
- Lazy onboarding (stub session)

### 🏗️ Infrastructure
- pnpm + Turborepo monorepo
- TypeScript throughout
- Web UI bundled into CLI package
- CI workflow (GitHub Actions)
- README, CONTRIBUTING guide, LICENSE
