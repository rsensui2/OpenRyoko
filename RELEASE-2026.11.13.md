# OpenRyoko 2026.11.13

This release stops recording Codex runs as failed when Codex completed them.

`codex exec` reports its own in-turn retries as errors: a stream reconnect as an `error` event (`Reconnecting... 1/5 (…)` or `Reconnecting... waiting for network (…)`), and the switch from WebSockets to HTTPS as an `error` item (`Falling back from WebSockets to HTTPS transport. …`). Codex then carries on, and exits 0 if the turn completes. OpenRyoko kept these messages as the turn's error, so a finished turn could be recorded as failed, reported as a cron failure, or handed to the fallback engine.

The outcome now follows Codex's exit code. A run that exits 0 succeeds unless Codex reported `turn.failed`. A run that exits non-zero is still a failure, explained by `turn.failed`, then the last error other than a retry notice, then the exit code. A stream reconnect or the switch to HTTPS is streamed as status, and still counts as activity for the response timeout. Codex's open-ended wait for the network no longer counts, so the timeout can still stop a turn during an outage.

## Response timeout

By default, Codex reconnects a response stream that has been silent for 5 minutes. `sessions.engineNoResponseTimeoutMs` also defaults to 5 minutes, so it usually stops the turn before Codex can reconnect. To give Codex a chance to recover a stalled response itself, set the timeout above 300000:

```yaml
sessions:
  engineNoResponseTimeoutMs: 420000
```

This gives Codex a chance but does not guarantee it. Codex measures silence on its own stream, including reasoning that OpenRyoko does not see, and its first reconnect over WebSockets prints nothing. The setting applies to every engine, so a turn that is truly stuck is also stopped later. This release does not change the default.

## Upgrade

Use Node.js `^22.23.4`, `^24.22.1`, or `^26.12.1`. Install `openryoko@2026.11.13` using your existing deployment method, run `ryoko migrate` in the environment running the gateway, and restart it through its existing service manager. For Docker installations, rebuild and recreate the service with the new package; preserve the instance home and other mounted data.

The migration reports the behavior change and updates only `jinn.version`. It does not change the response timeout, jobs, instructions, or memory.

Fix: [#122](https://github.com/rsensui2/OpenRyoko/pull/122).
