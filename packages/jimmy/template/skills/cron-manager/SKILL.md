---
name: cron-manager
description: "OpenRyoko の定期ジョブの作成・更新・停止・一覧確認。AIなしのコマンド実行とジョブ別モデル・思考量の設定にも使う。"
---

# Cron Manager

Use this skill to create, edit, enable, disable, delete, or inspect scheduled jobs.
Direct command cron and per-job effort are available from OpenRyoko 2026.9.11. Read `docs/cron-commands.md` and any operator-specific cost policy before choosing execution settings.

## Inspect and choose the execution kind

Use authenticated `GET /api/cron` for current definitions. The backing file is `~/.ryoko/cron/jobs.json`; read it for diagnostics or backup. Use the API for normal mutations so the running scheduler is reloaded immediately.

- `kind: "command"`: an existing program performs the work. OpenRyoko creates no AI session. A program that itself calls AI can still consume AI usage.
- `kind: "prompt"` or omitted kind: the job starts an AI session. Select the model and effort for the actual work.
- For a deterministic detector followed by AI judgment, use command cron to emit an existing Workflow event only when new work exists. Keep stable event IDs and durable receipts.
- Preserve internal kinds such as `update-notification`; do not convert them while editing unrelated fields.

Use existing authorization, schedule, timezone, and delivery requirements. Ask only for information or external-action authorization that is still missing. The command migration does not authorize new recipients or publication actions.

## API and authentication

On this instance, connect to `http://127.0.0.1:7777`. All `/api/*` requests require `Authorization: Bearer <token>` using the token read from `~/.ryoko/gateway-auth.json`. Never print or embed the token in examples, prompts, or logs. For another installation, verify its loopback URL first.

| Action | Endpoint |
|---|---|
| List definitions | `GET /api/cron` |
| Create | `POST /api/cron` |
| Update or enable/disable | `PUT /api/cron/<id>` |
| Delete | `DELETE /api/cron/<id>` |
| Inspect history | `GET /api/cron/<id>/runs` |
| Run now | `POST /api/cron/<id>/trigger` |

Before mutation, retain the affected definitions in a private backup. Identify a job by ID after matching its name; IDs may be UUIDs or descriptive strings. Send only the intended fields on update. Preserve unrelated command, model, effort, schedule, delivery, and state settings. Read the saved definition back through the API, then inspect the next authorized run and its actual result.

Manual trigger can execute even a disabled job. Do not use it merely to test a job that publishes, sends, invites, charges, or deletes. Use an existing read-only dry-run option in a separate probe when appropriate, or inspect its next authorized scheduled run.

## Command job schema

This harmless example is disabled until intentionally registered and tested:

```json
{
  "id": "native-command-probe",
  "name": "native-command-probe",
  "enabled": false,
  "kind": "command",
  "schedule": "0 0 1 1 *",
  "timezone": "Asia/Tokyo",
  "command": {
    "executable": "/usr/bin/true",
    "args": [],
    "cwd": "/tmp",
    "timeoutSeconds": 30
  },
  "failureDelivery": null
}
```

- `command.executable`: absolute executable path.
- `command.args`: optional array of literal strings; no shell expansion, pipes, `$HOME`, or `~` expansion. Put multi-step behavior in a maintained script.
- `command.cwd`: optional absolute working directory. Preserve the directory needed by the script's relative paths.
- `command.timeoutSeconds`: optional integer from 1 to 86400; default 300.
- `failureDelivery`: optional `{ "connector": "slack", "channel": "approved-destination" }`. Omitted uses the configured cron alert destination; `null` disables cron failure alerts.

Command cron does not use `prompt`, `engine`, `model`, or `employee` to start AI, even if legacy values remain in the saved job. Edit `command` to change execution. Success output stays in the private log and is not delivered by cron. The script may itself send authorized notifications. Cron failure alerts contain the exit reason, not raw command output.

## Prompt job fields

Common fields are `id`, `name`, `enabled`, five-field `schedule`, and IANA `timezone`. For an AI job, add:

```json
{
  "kind": "prompt",
  "engine": "codex",
  "model": "gpt-5.6-terra",
  "effortLevel": "medium",
  "prompt": "Read the approved input and prepare the requested summary."
}
```

The example model must be available to the configured account. Use the installed model registry for supported effort levels. Terra/medium is an example starting point for routine work; preserve the operator's selected model and use a stronger model only where the job needs it. Adjust the affected job when quality requires it; do not reset the global model to a costly default as routine maintenance.

`employee` is optional and must match an existing persona. `delivery` is an optional approved destination for prompt output. Reporting and analytical output should follow the established review route. Preserve existing delivery requirements; lack of a destination does not require adding one.

The AI instruction is `prompt`. Legacy `payload.message` is ignored. A cron's explicit `effortLevel` now takes precedence over the engine default for that cron session; confirm the resulting session's model and effort when verifying a change.

## Verify results and recover safely

For command success, history should show `kind: "command"`, `status: "success"`, `exitCode: 0`, and no AI `sessionId`. Nonzero exit, spawn failure, or timeout is failure. `logFile`, `signal`, `timedOut`, and `durationMs` provide diagnostic evidence. An exit code is not proof of an external delivery; inspect the actual result as required by the workflow.

Logs live under `~/.ryoko/cron/commands/<job-hash>/`, with up to 100 logs per job and a 1 MiB limit per file. A durable `running.lock` prevents overlap. After abnormal termination, inspect its recorded PIDs, process state, logs, and completed external effects before removing only that lock or retrying. Do not clear all locks or state files.

Malformed `jobs.json` must be backed up and repaired in a separate candidate. Never replace an unreadable existing store with `[]`. Compare all IDs before any recovery and retain execution history. API failure should not cause a silent fallback to writing the live file.

When reporting, distinguish saved configuration, actual scheduler execution, verified output, and runs still waiting for their next scheduled time.
