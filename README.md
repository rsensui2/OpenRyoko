# 🧞 Jinn

Lightweight AI gateway daemon orchestrating Claude Code, Codex, and Gemini CLI.

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="Jinn Web Dashboard" width="800" />
</p>

## What is Jinn?

Jinn is an open-source AI gateway that wraps the Claude Code CLI, Codex SDK,
and Gemini CLI behind a unified daemon process. It routes tasks to AI engines,
manages connectors like Slack, and schedules background work via cron. Jinn is
a bus, not a brain.

## 💡 Why Jinn?

Most AI agent frameworks reinvent the wheel — custom tool-calling loops, brittle context management, hand-rolled retry logic. Then they charge you per API call on top.

**Jinn takes a different approach.** It wraps battle-tested professional CLI tools (Claude Code, Codex, Gemini CLI) and adds only what they're missing: routing, scheduling, connectors, and an org system.

### 🔑 Works with your Anthropic Max subscription

Because Jinn uses **Claude Code CLI under the hood** — Anthropic's own first-party tool — it works with the [$200/mo Max subscription](https://www.anthropic.com/pricing). No per-token API billing. No surprise $500 invoices. Flat rate, unlimited usage.

Other frameworks can't do this. Anthropic [banned third-party tools from using Max subscription OAuth tokens](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex#max-plan) in January 2026. Since Jinn delegates to the official CLI, it's fully supported.

### 🧞 Jinn vs OpenClaw

| | Jinn | OpenClaw |
|---|---|---|
| **Architecture** | Wraps professional CLIs (Claude Code, Codex, Gemini) | Custom agentic loop |
| **Max subscription** | ✅ Works (uses official Claude Code CLI) | ❌ Banned since Jan 2026 |
| **Typical cost** | $200/mo flat (Max) or pay-per-use | $300–750/mo API bills ([reported by users](https://www.reddit.com/r/OpenClaw/)) |
| **Security** | Inherits Claude Code's security model | 512 vulnerabilities found by CrowdStrike |
| **Memory & context** | Handled natively by Claude Code | Custom implementation with [known context-drop bugs](https://github.com/openclaw/openclaw/issues/5429) |
| **Cron scheduling** | ✅ Built-in, hot-reloadable | ❌ [Fires in wrong agent context](https://github.com/openclaw/openclaw/issues/16053) |
| **Slack integration** | ✅ Thread-aware, reaction workflow | ❌ [Drops agent-to-agent messages](https://github.com/openclaw/openclaw/issues/15836) |
| **Multi-agent org** | Departments, ranks, managers, boards | Flat agent list |
| **Self-modification** | Agents can edit their own config at runtime | Limited |

### 🧠 The "bus, not brain" philosophy

Jinn adds **zero custom AI logic**. No prompt engineering layer. No opinions on how agents should think. All intelligence comes from the engines themselves — Claude Code already handles tool use, file editing, multi-step reasoning, and memory. Jinn just connects it to the outside world.

When Claude Code gets better, Jinn gets better — automatically.

## ✨ Features

- 🔌 **Triple engine support** — Claude Code CLI + Codex SDK + Gemini CLI
- 💬 **Connectors** — Slack (threads + reactions), WhatsApp (QR auth), Discord (bot)
- 📎 **File attachments** — drag & drop files into web chat, passed through to engines
- 📱 **Mobile-responsive** — collapsible sidebar and mobile-friendly dashboard
- ⏰ **Cron scheduling** — hot-reloadable background jobs
- 👥 **AI org system** — departments, ranks, managers, employees, task boards
- 🌐 **Web dashboard** — chat, org map, kanban, cost tracking, cron visualizer
- 🔄 **Hot-reload** — change config, cron, or org files without restarting
- 🛠️ **Self-modification** — agents can edit their own config, skills, and org at runtime
- 📦 **Skills system** — reusable markdown playbooks that engines follow natively
- 🏢 **Multi-instance** — run multiple isolated Jinn instances side by side
- 🔗 **MCP support** — connect to any MCP server

## 🚀 Quick Start

```bash
npm install -g jinn-cli
jinn setup
jinn start
```

Then open [http://localhost:7777](http://localhost:7777).

## 🏗️ Architecture

```
                          +----------------+
                          |   jinn CLI     |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |    Gateway     |
                          |    Daemon      |
                          +--+--+--+--+---+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                  |
      +-------v-------+ +------v------+  +-----------v---+
      |    Engines     | | Connectors  |  |    Web UI     |
      |Claude|Codex|Gem| | Slack|WA|DC |  | localhost:7777|
      +----------------+ +-------------+  +---------------+
              |                 |
      +-------v-------+ +------v------+
      |     Cron      | |    Org      |
      |   Scheduler   | |   System    |
      +---------------+ +-------------+
```

The CLI sends commands to the gateway daemon. The daemon dispatches work to AI
engines (Claude Code, Codex, Gemini CLI), manages connector integrations, runs
scheduled cron jobs, and serves the web dashboard.

## ⚙️ Configuration

Jinn reads its configuration from `~/.jinn/config.yaml`. An example:

```yaml
gateway:
  port: 7777

engines:
  claude:
    enabled: true
  codex:
    enabled: false

connectors:
  slack:
    enabled: true
    app_token: xapp-...
    bot_token: xoxb-...

cron:
  jobs:
    - name: daily-review
      schedule: "0 9 * * *"
      task: "Review open PRs"

org:
  agents:
    - name: reviewer
      role: code-review
```

## 📁 Project Structure

```
jinn/
  packages/
    jimmy/          # Core gateway daemon + CLI
    web/            # Web dashboard (frontend)
  turbo.json        # Turborepo build configuration
  pnpm-workspace.yaml
  tsconfig.base.json
```

## 🧑‍💻 Development

```bash
git clone https://github.com/hristo2612/jinn.git
cd jinn
pnpm install
pnpm setup   # one-time: builds all packages and creates ~/.jinn
pnpm dev     # starts gateway + Next.js dev server with hot reload
```

Open [http://localhost:3000](http://localhost:3000) to use the web dashboard.

`pnpm dev` starts two servers behind the scenes: the **gateway daemon** on
`:7777` (API, WebSocket, connectors) and the **Next.js dev server** on `:3000`
(web dashboard with hot reload). Next.js rewrites proxy `/api/*` and `/ws`
requests from `:3000` to the gateway, so you only need to visit `:3000`. The
gateway auto-restarts when you edit backend source files via Node's built-in
`--watch` mode. To use a non-default gateway port, set `GATEWAY_PORT=<port>`
before running `pnpm dev`.

> **Prerequisites:** Node.js 22+, pnpm 10+, and the
> [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`).

### Available Scripts

| Command            | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `pnpm setup`       | Build all packages and initialize `~/.jinn` (one-time)              |
| `pnpm dev`         | Start gateway (`:7777`) + Next.js dev server (`:3000`) with hot reload |
| `pnpm start`       | Production-style clean build + start gateway on `:7777`             |
| `pnpm stop`        | Stop the running gateway daemon                                     |
| `pnpm status`      | Check if the gateway daemon is running                              |
| `pnpm build`       | Build all packages                                                  |
| `pnpm typecheck`   | Run TypeScript type checking                                        |
| `pnpm lint`        | Lint all packages                                                   |
| `pnpm clean`       | Clean build artifacts                                               |

## 🗺️ Roadmap

Jinn is under active development. Here's what's coming:

### 🔌 Connectors
- [x] **Discord** — bot integration via discord.js
- [x] **WhatsApp** — Baileys-based connector with QR auth and media support
- [x] **Telegram** — bot API connector with polling and user allowlist
- [ ] **iMessage** — macOS-native via AppleScript bridge
- [ ] **Email** — IMAP/SMTP connector for inbox monitoring and replies
- [ ] **Webhooks** — generic inbound/outbound HTTP webhooks

### 🧠 Engines
- [x] **Gemini CLI** — Google's Gemini as a third engine option
- [ ] **Local models** — Ollama / llama.cpp integration for offline use
- [ ] **Engine fallback chains** — auto-failover when primary engine is unavailable

### 👥 Org System
- [x] **Agent-to-agent messaging** — direct communication without board intermediary
- [x] **Shared memory** — cross-session knowledge that persists across employees
- [ ] **Performance tracking** — automatic quality scoring per employee over time
- [x] **Auto-promotion** — promote employees to manager based on track record

### 🌐 Web Dashboard
- [x] **Mobile-responsive UI** — collapsible sidebar, mobile-friendly chat
- [x] **Live streaming** — watch agent responses stream in real-time
- [x] **File attachments** — drag & drop files into chat with engine passthrough
- [ ] **Approval workflows** — approve/reject agent actions from the dashboard
- [ ] **Cost analytics** — per-employee, per-department cost breakdowns

### 🛠️ Platform
- [ ] **Plugin system** — installable plugins for common integrations (Stripe, Linear, GitHub)
- [ ] **REST API auth** — API keys for secure remote access
- [ ] **Multi-user support** — team access with roles and permissions
- [ ] **Docker image** — one-command deployment with `docker run`

### 📦 Skills
- [ ] **Skills marketplace** — browse and install community skills from [skills.sh](https://skills.sh)
- [ ] **Skill versioning** — pin skill versions, auto-update with changelogs
- [ ] **Skill templates** — scaffolding for common patterns (blog pipeline, support inbox, etc.)

Want to suggest a feature? [Open an issue](https://github.com/hristo2612/jinn/issues).

## 🙏 Acknowledgments

The web dashboard UI is built on components from [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice, adapted for Jinn's architecture. ClawPort provides the foundation for the theme system, shadcn components, org map, kanban board, cost dashboard, and activity console.

## 📄 License

[MIT](LICENSE)

## 🤝 Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines on setting up
your development environment and submitting pull requests.
