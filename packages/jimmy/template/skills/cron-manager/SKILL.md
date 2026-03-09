---
name: cron-manager
description: Create, edit, delete, enable, disable, and list scheduled cron jobs
---

# Cron Manager Skill

## Trigger

This skill activates when the user wants to create, edit, delete, enable, disable, or list scheduled cron jobs.

## Data File

All cron jobs are stored in `~/.jimmy/cron/jobs.json` as a JSON array of job objects. If the file does not exist, create it with an empty array `[]`.

## CronJob Schema

```json
{
  "id": "uuid-v4",
  "name": "daily-standup-summary",
  "enabled": true,
  "schedule": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "engine": "claude",
  "model": "sonnet",
  "employee": "project-manager",
  "prompt": "Review all department boards and summarize progress since yesterday. Highlight blockers and upcoming deadlines.",
  "delivery": {
    "connector": "slack",
    "channel": "#engineering-standup"
  }
}
```

Field details:
- `id` — UUID v4, generated when creating the job
- `name` — kebab-case human-readable identifier, must be unique across all jobs
- `enabled` — boolean, whether the job is active
- `schedule` — standard cron expression (minute hour day month weekday)
- `timezone` — IANA timezone string (e.g., `America/New_York`, `Europe/London`, `UTC`)
- `engine` — AI engine to run the job: `claude` or `codex`
- `model` — model identifier (e.g., `sonnet`, `opus`, `o3`)
- `employee` — optional, the employee persona to use (must match an employee name in the org)
- `prompt` — the instruction to execute when the job fires
- `delivery` — optional object specifying where to send output
  - `connector` — the connector to use (e.g., `slack`, `discord`)
  - `channel` — the target channel or destination

## Operations

### Creating a Job

1. Read the current `~/.jimmy/cron/jobs.json` (or initialize as `[]` if missing).
2. Ask the user for the required fields: name, schedule, engine, model, and prompt.
3. Ask about the timezone. Default to `UTC` if not specified.
4. Ask about the employee persona to use. This is optional.
5. **Always ask the user about the delivery channel** if they did not specify one. Explain that without delivery, the output will only be logged.
6. **Delegation check**: If the job has delivery configured AND targets a non-{{portalSlug}} employee, warn the user. The correct pattern for reporting/analytical jobs is: target `{{portalSlug}}`, and include delegation instructions in the prompt (e.g. "Delegate to @employee-name: ..."). {{portalName}} reviews and filters the output before it reaches the delivery channel. Only simple, no-review tasks (e.g. health checks) should target employees directly with delivery.
7. Generate a UUID for the `id` field.
8. Set `enabled` to `true` by default.
9. Append the new job object to the array.
10. Write the updated array back to `~/.jimmy/cron/jobs.json`.
11. Confirm the creation and summarize the schedule in plain English.

### Editing a Job

1. Read `~/.jimmy/cron/jobs.json`.
2. Find the job by name or id.
3. Show the current values to the user.
4. Apply the requested changes.
5. Write the updated array back.
6. Confirm the changes.

### Deleting a Job

1. Read `~/.jimmy/cron/jobs.json`.
2. Find the job by name or id.
3. Confirm deletion with the user (show job details).
4. Remove the job from the array.
5. Write the updated array back.
6. Confirm deletion.

### Enabling / Disabling a Job

1. Read `~/.jimmy/cron/jobs.json`.
2. Find the job by name or id.
3. Set `enabled` to `true` (enable) or `false` (disable).
4. Write the updated array back.
5. Confirm the status change.

### Listing Jobs

1. Read `~/.jimmy/cron/jobs.json`.
2. Display jobs in a readable format, grouped by enabled/disabled.
3. Include name, schedule (with plain-English interpretation), timezone, engine, and delivery info.

## Cron Schedule Reference

The schedule field uses standard 5-field cron syntax:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Common examples:
- `0 9 * * 1-5` — Every weekday at 9:00 AM
- `0 0 * * *` — Every day at midnight
- `*/15 * * * *` — Every 15 minutes
- `0 9 * * 1` — Every Monday at 9:00 AM
- `0 8,17 * * *` — Every day at 8:00 AM and 5:00 PM
- `0 0 1 * *` — First day of every month at midnight
- `30 14 * * 5` — Every Friday at 2:30 PM

## Error Handling

- If `jobs.json` is malformed, attempt to fix it. If unrecoverable, back it up as `jobs.json.bak` and start fresh with `[]`.
- If a job name already exists when creating, warn the user and ask for a different name.
- Validate the cron expression format before saving. Warn if the expression looks incorrect.
- Validate that the timezone is a valid IANA timezone string.
- If an employee is specified, verify it exists in the org directory.
