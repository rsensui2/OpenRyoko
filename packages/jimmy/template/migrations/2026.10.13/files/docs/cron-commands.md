# Direct command cron jobs

Use `kind: "command"` for scheduled programs that already perform all required
work. They bypass SessionManager and never create an AI session. Existing prompt
and update-notification jobs continue to work.

Create or update through the authenticated `/api/cron` API so the live scheduler
is reloaded immediately:

```json
{
  "id": "my-patrol",
  "name": "My patrol",
  "enabled": true,
  "schedule": "*/15 * * * *",
  "kind": "command",
  "command": {
    "executable": "/usr/bin/python3",
    "args": ["/absolute/path/patrol.py"],
    "cwd": "/absolute/path",
    "timeoutSeconds": 300
  },
  "failureDelivery": { "connector": "slack", "channel": "YOUR_CHANNEL" }
}
```

Arguments are passed literally, without a shell. Put pipelines, environment
setup, output validation, or conditional notifications in a maintained script.
An exit code of zero is success. Nonzero exits, spawn failures and timeouts are
errors. Success output stays in the private command log; it is never posted by
cron. Failure alerts use `failureDelivery`, falling back to the configured cron
alert destination. They contain the exit reason, not program output.

Runs appear in the existing cron history with `kind`, `exitCode`, `signal`,
`timedOut` and `logFile`. Each job retains up to 100 logs capped at 1 MiB each.
The default timeout is 300 seconds; supported limits are 1–86400 seconds.
On POSIX, the process group is terminated on timeout and remaining descendants
are killed before the run releases its lock.

A durable exclusive lock under `cron/commands/<job-hash>/running.lock` prevents
overlap, including across gateway restarts. If the gateway dies during a command,
the lock deliberately remains. Inspect the recorded gateway PID, child PID,
program state and log before removing that one lock. Do not blindly rerun a
command whose external effects are unknown.

For prompt cron jobs, `effortLevel` is now passed through to the engine, allowing
routine work to use `medium` and difficult work to use `high` independently.

For conditional AI work, run a deterministic detector as a command job and emit
an existing Workflow event only for new candidates. Reuse the event `fireId` on
HTTP retries and keep a durable receipt; check failures instead of silently
marking the underlying work complete.
