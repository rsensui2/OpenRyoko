# 🧞 Jinn

Lightweight AI gateway daemon orchestrating Claude Code and Codex.

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="Jinn Web Dashboard" width="800" />
</p>

## What is Jinn?

Jinn is an open-source AI gateway that wraps the Claude Code CLI and Codex SDK
behind a unified daemon process. It routes tasks to AI engines, manages
connectors like Slack, and schedules background work via cron. Jinn is a bus,
not a brain.

## 💡 Why Jinn?

Most AI agent frameworks reinvent the wheel — custom tool-calling loops, brittle context management, hand-rolled retry logic. Then they charge you per API call on top.

**Jinn takes a different approach.** It wraps battle-tested professional CLI tools (Claude Code, Codex) and adds only what they're missing: routing, scheduling, connectors, and an org system.

### 🔑 Works with your Anthropic Max subscription

Because Jinn uses **Claude Code CLI under the hood** — Anthropic's own first-party tool — it works with the [$200/mo Max subscription](https://www.anthropic.com/pricing). No per-token API billing. No surprise $500 invoices. Flat rate, unlimited usage.

Other frameworks can't do this. Anthropic [banned third-party tools from using Max subscription OAuth tokens](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex#max-plan) in January 2026. Since Jinn delegates to the official CLI, it's fully supported.

### 🧞 Jinn vs OpenClaw

| | Jinn | OpenClaw |
|---|---|---|
| **Architecture** | Wraps professional CLIs (Claude Code, Codex) | Custom agentic loop |
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

- 🔌 **Dual engine support** — Claude Code CLI + Codex SDK
- 💬 **Slack integration** — thread-aware routing with reaction workflow
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
      | Claude | Codex | |   Slack     |  | localhost:7777|
      +----------------+ +-------------+  +---------------+
              |                 |
      +-------v-------+ +------v------+
      |     Cron      | |    Org      |
      |   Scheduler   | |   System    |
      +---------------+ +-------------+
```

The CLI sends commands to the gateway daemon. The daemon dispatches work to AI
engines (Claude Code, Codex), manages connector integrations, runs scheduled
cron jobs, and serves the web dashboard.

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
pnpm build
pnpm dev
```

### Available Scripts

| Command          | Description                     |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build all packages              |
| `pnpm dev`       | Start development mode          |
| `pnpm typecheck` | Run TypeScript type checking    |
| `pnpm lint`      | Lint all packages               |
| `pnpm clean`     | Clean build artifacts           |

## 🙏 Acknowledgments

The web dashboard UI is built on components from [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice, adapted for Jinn's architecture. ClawPort provides the foundation for the theme system, shadcn components, org map, kanban board, cost dashboard, and activity console.

## 📄 License

[MIT](LICENSE)

## 🤝 Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines on setting up
your development environment and submitting pull requests.
