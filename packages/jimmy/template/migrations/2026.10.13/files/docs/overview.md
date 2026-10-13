# {{portalName}} Overview

{{portalName}} is a lightweight AI gateway daemon that wraps professional AI CLI tools as "engines." It is published as `openryoko`.

## Core Principle

**{{portalName}} is a bus, not a brain.** All AI intelligence comes from the engines natively. {{portalName}} adds no custom agentic loop, no prompt engineering layer, no opinions on how AI should behave. It delegates everything to professional tools (the Claude Code, Codex and Gemini CLIs) and focuses solely on routing, scheduling, and connectivity.

## What {{portalName}} Does

- **Gateway**: Single Node.js process that accepts messages from multiple sources and routes them to AI engines
- **Connectors**: Modular input/output adapters (Slack, Discord, Telegram, WhatsApp, and the web UI)
- **Cron**: Scheduled AI jobs with hot-reloadable configuration
- **Organization**: Employee personas with departments, ranks, and inter-agent communication via boards
- **Skills**: Markdown instruction sets that engines read and follow natively
- **Self-modification**: {{portalName}} can edit its own config, skills, cron jobs, and org structure at runtime
- **Backups**: A daily archive of the home and copies of the databases, so a file an edit broke can be put back with `ryoko backup restore`

## How It Differs from Custom Agentic Frameworks

Traditional approaches build custom tool-calling loops, manage context windows, and implement retry logic. {{portalName}} does none of that. The engines (Claude Code, Codex) already handle tool use, file editing, command execution, and multi-step reasoning. {{portalName}} just connects them to the outside world.

## Directory Structure

```
~/.ryoko/
  config.yaml          # Gateway configuration
  sessions/
    registry.db        # SQLite session registry
  docs/                # These reference docs
  skills/              # Skill directories with SKILL.md files
  knowledge/           # Reference notes, read on demand
  cron/
    jobs.json          # Cron job definitions
    runs/              # Run logs (JSONL)
  org/
    <department>/
      department.yaml  # Department config
      board.json       # Task board
      <name>.yaml      # Employee persona
  logs/                # Application logs
  backups/             # Daily backups the gateway writes (see backup.md)
  tmp/                 # The gateway's working state — not a cache to clear
```
