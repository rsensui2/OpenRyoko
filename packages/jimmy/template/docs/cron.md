# Cron

Jimmy supports scheduled AI jobs defined in `~/.jimmy/cron/jobs.json`.

## Job Schema

```typescript
interface CronJob {
  id: string;            // Unique identifier
  name: string;          // Human-readable name
  enabled: boolean;      // Whether the job is active
  schedule: string;      // Cron expression (standard 5-field)
  timezone?: string;     // IANA timezone (default: system timezone)
  engine: string;        // "claude" or "codex"
  model?: string;        // Override default model
  employee?: string;     // Employee persona to use
  prompt: string;        // The prompt to send to the engine
  delivery?: {           // Optional output delivery
    connector: string;   // Connector name (e.g., "slack")
    channel: string;     // Target channel or user
  };
}
```

## Schedule Format

Standard 5-field cron expressions:

```
┌────────── minute (0-59)
│ ┌──────── hour (0-23)
│ │ ┌────── day of month (1-31)
│ │ │ ┌──── month (1-12)
│ │ │ │ ┌── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Examples:
- `0 9 * * 1-5` — 9:00 AM, Monday through Friday
- `*/30 * * * *` — Every 30 minutes
- `0 0 1 * *` — Midnight on the 1st of each month

## Hot Reload

The gateway watches `cron/jobs.json` with chokidar. When the file changes:
1. All existing scheduled jobs are cancelled
2. The new file is parsed and validated
3. Enabled jobs are rescheduled with the updated definitions

No restart required. Engines can edit `jobs.json` directly to create or modify scheduled jobs.

## Run Logs

Each job execution is logged to `~/.jimmy/cron/runs/<jobId>.jsonl`. Each line is a JSON object:

```json
{
  "runId": "run_abc123",
  "jobId": "daily-standup",
  "startedAt": "2026-01-15T09:00:00.000Z",
  "completedAt": "2026-01-15T09:00:45.000Z",
  "status": "success",
  "output": "..."
}
```

## Delegation Pattern

When a cron job produces analytical, reporting, or decision-informing output, it should **always target jimmy** (the COO), not the employee directly. Jimmy then delegates to the employee via a child session, reviews the output, filters noise, and delivers the final result.

**Correct** — cron → jimmy → employee (via child session) → jimmy reviews → delivery:
```json
{
  "id": "daily-pulse",
  "name": "Daily Pulse Analytics",
  "enabled": true,
  "schedule": "0 8 * * *",
  "engine": "claude",
  "employee": "jimmy",
  "prompt": "Delegate to @pulse: pull analytics for all products. Review the output, filter noise, and deliver a concise summary of what matters.",
  "delivery": {
    "connector": "slack",
    "channel": "#analytics"
  }
}
```

**Incorrect** — cron → employee → delivery (bypasses COO review):
```json
{
  "id": "daily-pulse",
  "name": "Daily Pulse Analytics",
  "enabled": true,
  "schedule": "0 8 * * *",
  "engine": "claude",
  "employee": "pulse",
  "prompt": "Pull analytics for all products and summarize.",
  "delivery": {
    "connector": "slack",
    "channel": "#analytics"
  }
}
```

Direct employee-to-user delivery is only acceptable for simple, no-review-needed tasks (e.g. a health check ping). The gateway will log a warning if it detects a non-jimmy employee with delivery configured.

## Example Configuration

```json
[
  {
    "id": "daily-standup",
    "name": "Daily Standup Summary",
    "enabled": true,
    "schedule": "0 9 * * 1-5",
    "timezone": "America/New_York",
    "engine": "claude",
    "employee": "jimmy",
    "prompt": "Delegate to @project-manager: review yesterday's board activity across all departments. Review the output and write a concise standup summary.",
    "delivery": {
      "connector": "slack",
      "channel": "#engineering"
    }
  },
  {
    "id": "weekly-cleanup",
    "name": "Weekly Skill Review",
    "enabled": true,
    "schedule": "0 18 * * 5",
    "timezone": "America/New_York",
    "engine": "claude",
    "employee": "jimmy",
    "prompt": "Review all skills in ~/.jimmy/skills/ and suggest improvements or removals for unused skills."
  }
]
```
