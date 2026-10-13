# Cron

{{portalName}} supports scheduled AI jobs and direct command jobs defined in `~/.ryoko/cron/jobs.json`.

## Job Schema

```typescript
interface CronJob {
  id: string;            // Unique identifier
  name: string;          // Human-readable name
  enabled: boolean;      // Whether the job is active
  schedule: string;      // Cron expression (standard 5-field)
  kind?: "prompt" | "update-notification" | "command"; // Default: prompt
  maintenance?: { mode: "off" | "review" | "apply" }; // Update notifications; default review
  timezone?: string;     // IANA timezone (default: system timezone)
  engine?: string;       // "claude", "codex" or "gemini". Omitted: the employee's engine, else engines.default
  effortLevel?: string; // Per-job reasoning effort for prompt jobs
  command?: { executable: string; args?: string[]; cwd?: string; timeoutSeconds?: number };
  failureDelivery?: { connector: string; channel: string } | null;
  model?: string;        // Override default model
  employee?: string;     // Employee persona to use
  prompt: string;        // The prompt to send to the engine
  delivery?: {           // Optional output delivery
    connector: string;   // Connector name (e.g., "slack")
    channel: string;     // Target channel or user
  };
}
```

`kind: "update-notification"` is a built-in low-cost update watcher. It checks
the fixed OpenRyoko npm registry endpoint on schedule without invoking an AI.
Only when a newer, not-yet-notified version exists does it ask the configured
engine to write a short notice and deliver it to the selected connector. Each
job notifies a given version once. It also runs a local deterministic maintenance
inspection against installed capabilities. With `maintenance.mode: review` (the
default), new opportunities trigger an AI inspection and suggestions; `apply`
also permits bounded local cron/script improvements, and `off` disables maintenance.
Unchanged reviewed inputs and empty findings do not start AI. Pending result delivery
is retried without repeating edits. See `skills/openryoko-config/references/maintenance.md`
and `ryoko maintenance --help`. A newly installed release is inspected on the next
enabled update-notification run, even when npm reports no newer version.

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

The gateway watches the directory that holds `cron/jobs.json`, and every 30 seconds compares the file with what is scheduled, in case a change was missed. When the file changes:
1. The new file is parsed and validated
2. Jobs that are new or changed are rescheduled, and jobs that were removed or disabled are unscheduled. A job that did not change keeps its registration
3. If the file cannot be read — invalid JSON, a duplicate id, a file caught half-written, a file that is missing — nothing changes. The jobs registered before stay scheduled, and the gateway logs `Cron reload skipped; keeping previous registrations`

A valid empty list `[]` is a change like any other: it unschedules every job. Deleting the file does not.

No restart is required. Create and update through the authenticated `/api/cron` API so the running scheduler is reloaded immediately. Direct file edits are for offline recovery, with a backup.

The `cron` section of `config.yaml` (`alertConnector`, `alertChannel`, `alertThrottleMinutes`, `defaultDelivery`) and the engine defaults are read each time a job fires. A change to them applies from the next fire, without a restart.

## Which Engine a Job Runs On

A job that names neither `engine` nor `model` runs on its employee's engine, or on `engines.default`. While that engine's usage limit is on record and a fallback engine can take the job, it starts there straight away, and goes back after the reset. A job that names its `engine` or `model` is taken at its word and is not moved: during the same limit every fire first fails a turn on the named engine, and is switched only then. Name them where the job needs that engine or model, and leave them out otherwise.

For `kind: "command"`, the gateway executes `command` without creating an AI session. Legacy prompt/model fields are ignored by this kind. See [Direct command jobs](cron-commands.md) for timeout, output, failure delivery, and lock recovery.

## Run Logs

Each job execution is logged to `~/.ryoko/cron/runs/<jobId>.jsonl`. Each line is a JSON object:

```json
{
  "timestamp": "2026-01-15T09:00:00.000Z",
  "sessionKey": "cron:daily-standup:1768467600000",
  "sessionId": "8b1f0c1e-7a52-4a0e-9d55-2f1f5a0c9b11",
  "status": "success",
  "durationMs": 45000,
  "error": null,
  "resultPreview": null
}
```

`status` is `success`, `error` or `skipped` (with a `reason`). The `kind: "maintenance"` lines an update-notification job writes for its inspection use `notified`, not `success`, once the inspection report has been delivered. A prompt run is an `error`, with the reason in `error`, when its session ended in error, when its result was not delivered (the delivery connector was not running, or refused the message), or when the job names an engine the gateway does not have. It is not a `success` merely because the turn returned. `GET /api/cron/<id>/runs` lists runs oldest first; add `?limit=N` for only the newest N.

A prompt run is `skipped`, with `reason: "previous-run-waiting-for-usage-limit"`, when an earlier fire of the same job is still waiting for an engine's usage limit to reset. `waitingSessionId` names the session that is waiting and `resetsAt`, when the wait knows it, the reset it is waiting for. That fire runs the job once when the limit resets; the fires skipped in the meantime are not made up. A job that is simply still running when its next fire comes is not skipped.

## Failure Alerts

A failed prompt run is always written to the run log, and alerts `cron.alertConnector` / `cron.alertChannel` in `config.yaml` when both are set. While the same failure of a job repeats, the alert is sent once and then held back for `cron.alertThrottleMinutes` (default 60; `0` alerts on every failure). A new reason, or a success in between, alerts again at once. No new alert therefore does not mean the job recovered: check its run log. What was already alerted is kept in memory only, so the first failure after a gateway restart alerts again. Command jobs alert as described in [Direct command jobs](cron-commands.md).

When an engine's usage limit will not reset within six hours and no fallback engine can take the job, each fire fails at once instead of waiting, and is logged as an `error` that names the reset. That failure is alerted once per limit period (an engine and the reset it stated) rather than once per `cron.alertThrottleMinutes`; `0` still alerts on every failure. The job's delivery channel is told once per limit period as well, not on every fire. Silence in either place does not mean the job recovered: check its run log.

## Delegation Pattern

When a cron job produces analytical, reporting, or decision-informing output, it should **always target {{portalSlug}}** (the COO), not the employee directly. {{portalName}} then delegates to the employee via a child session, reviews the output, filters noise, and delivers the final result.

> Note: `"employee": "{{portalSlug}}"` here refers to the COO portal session itself — it is NOT an `org/` employee (org.md: `org/` starts empty and {{portalName}} is not defined there). The runner resolves an unknown employee name to a portal session, which is exactly the intended routing.

**Correct** — cron → {{portalSlug}} → employee (via child session) → {{portalSlug}} reviews → delivery:
```json
{
  "id": "daily-pulse",
  "name": "Daily Pulse Analytics",
  "enabled": true,
  "schedule": "0 8 * * *",
  "engine": "claude",
  "employee": "{{portalSlug}}",
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

Direct employee-to-user delivery is only acceptable for simple, no-review-needed tasks (e.g. a health check ping). Nothing stops such a job: the gateway only notes in its debug log that the job delivers for an employee other than {{portalSlug}}.

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
    "employee": "{{portalSlug}}",
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
    "employee": "{{portalSlug}}",
    "prompt": "Review all skills in ~/.ryoko/skills/ and suggest improvements or removals for unused skills."
  }
]
```
