# {{portalName}} Overview

{{portalName}} is a lightweight AI gateway daemon that wraps professional AI CLI tools as "engines." It is published as `@jimmy-ai/cli`.

## Core Principle

**{{portalName}} is a bus, not a brain.** All AI intelligence comes from the engines natively. {{portalName}} adds no custom agentic loop, no prompt engineering layer, no opinions on how AI should behave. It delegates everything to professional tools (Claude Code CLI, Codex SDK) and focuses solely on routing, scheduling, and connectivity.

## What {{portalName}} Does

- **Gateway**: Single Node.js process that accepts messages from multiple sources and routes them to AI engines
- **Connectors**: Modular input/output adapters (Slack, web UI, future: Discord, iMessage)
- **Cron**: Scheduled AI jobs with hot-reloadable configuration
- **Organization**: Employee personas with departments, ranks, and inter-agent communication via boards
- **Skills**: Markdown instruction sets that engines read and follow natively
- **Self-modification**: {{portalName}} can edit its own config, skills, cron jobs, and org structure at runtime

## How It Differs from Custom Agentic Frameworks

Traditional approaches build custom tool-calling loops, manage context windows, and implement retry logic. {{portalName}} does none of that. The engines (Claude Code, Codex) already handle tool use, file editing, command execution, and multi-step reasoning. {{portalName}} just connects them to the outside world.

## Directory Structure

```
~/.jimmy/
  config.yaml          # Gateway configuration
  jimmy.db             # SQLite session registry
  docs/                # These reference docs
  skills/              # Skill directories with SKILL.md files
  cron/
    jobs.json          # Cron job definitions
    runs/              # Run logs (JSONL)
  org/
    <department>/
      department.yaml  # Department config
      board.json       # Task board
      <name>.yaml      # Employee persona
  logs/                # Application logs
```
