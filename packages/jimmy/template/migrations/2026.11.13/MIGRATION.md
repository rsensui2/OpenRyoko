---
auto: false
---

# 2026.11.13: Codex runs follow Codex's exit code

Do not change the response timeout, engine settings, cron jobs, instructions, or memory for this migration. The only permitted configuration edit is the final `jinn.version` update to `2026.11.13`. This migration ships no replacement files or configuration patch; the code change works without new settings.

## Notify the owner

Codex reports its in-turn retries, such as a stream reconnect or the switch from WebSockets to HTTPS, as error messages and then carries on. OpenRyoko used to keep those messages as the turn's error, so a Codex turn that finished could be recorded as failed, reported as a cron failure, or handed to the fallback engine. A Codex run that exits 0 now succeeds unless Codex reported that the turn failed. A run that exits non-zero is still a failure.

By default, Codex reconnects a response stream after 5 minutes of silence, and `sessions.engineNoResponseTimeoutMs` also defaults to 5 minutes, so the timeout usually stops the turn first. Tell the owner that setting `sessions.engineNoResponseTimeoutMs` above 300000, for example to 420000, gives Codex a chance to recover a stalled response itself but does not guarantee it, and that the setting applies to every engine, so a truly stuck turn is then stopped later. Do not change the setting as part of this migration.

After reporting the behavior change, update only `jinn.version`. If the migration prompt says bundled skills were synced, follow its skip/merge instructions; if it says `skills/` is a user-managed symlink, leave it alone. If the prompt has no sync information, do not apply this migration and ask the owner to run `ryoko migrate` in the environment that runs the gateway. There are no bundled skill changes in this release.
