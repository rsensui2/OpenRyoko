---
name: self-heal
description: Diagnose and fix problems in {{portalName}}'s configuration and runtime
---

# Self-Heal Skill

## Trigger

This skill activates when {{portalName}} is experiencing issues, errors, or unexpected behavior. It also activates when the user asks to diagnose problems, check system health, or fix something that is not working.

## Before You Change Anything

Three rules hold for every repair in this skill.

- **Restore before you rebuild.** By default the gateway backs the home up once a day. A file that an edit broke, and that you cannot repair by fixing the one mistake in it, is put back from a backup. It is never replaced with an empty or default file. See "Restore a File from a Backup" below.
- **Do not delete or empty the gateway's own working state.** `tmp/`, `sessions/`, `cron/runs/`, `backups/` and `.migration-backups/` are not caches to clear.
- **Do not edit the databases.** `sessions/registry.db` and the workflow database belong to the gateway process. A status written into them by hand is not one the gateway understands. Everything you need is available through the API.

All relative paths below are relative to the {{portalName}} home directory, which is always your working directory. Commands are run where the gateway runs. When the home is shared with a container (a bind mount), that is inside the container: a `ryoko` on the host cannot see the gateway that runs in it.

## Diagnostic Steps

Work through these checks in order. Stop and fix issues as you find them.

### 1. Ask the Gateway

```bash
ryoko api GET /api/status
```

- `process`: `unhandledRejections` or `uncaughtExceptions` above 0 means the gateway caught an error nothing handled and kept running. Part of it may not be working until it is restarted. Look for `Unhandled promise rejection` and `Uncaught exception` in the log.
- `backup`: `level` is `ok`, `warning`, `disabled` or `unknown`. With `warning`, `targets` names what failed and why. With `disabled` there may be no recent backup to restore from.
- `engines.<name>.health`: `state: "exhausted"` means the engine's usage limit is on record, and `until` is the reset it stated. New sessions start on the fallback engine in the meantime, when one can take them. This is not a fault to repair.
- `connectors`: the status of each connector.
- `storage`: `level` is `warning` or `critical` when the disk is running out.

If the API does not answer, the gateway is not running, or you are asking another instance. Check with `ryoko status`.

### 2. Check Gateway Logs

Read `logs/gateway.log` (or `ryoko api GET '/api/logs?n=100'`) and look for:
- Error messages or stack traces
- Repeated failures or crash loops
- Connection refused or timeout errors
- Out of memory warnings
- `Failed to reload config`: the last change to `config.yaml` was not loaded. When the file does not parse, the line gives the position of the mistake.
- `Cron reload skipped; keeping previous registrations`: `cron/jobs.json` cannot be read. The jobs registered before it broke are still scheduled.
- `Backup failed`, and warnings about bundled skills that were not synced.

Summarize any problems found to the user.

### 3. Validate Configuration

Read `config.yaml` and verify:
- The file is valid YAML, with no duplicate keys
- `gateway.port` is a number (7777 unless it was changed)
- `engines.default` names an engine that has its own block under `engines` (`claude`, `codex` or `gemini`), and the `bin` of that block is a command that exists
- Connector tokens are present for the connectors that should be running

While the file does not parse, the running gateway keeps the last configuration it loaded, the API refuses to save over the file, and `ryoko start` stops with the line and column of the mistake.

### 4. Verify Engine Availability

Check that the configured AI engine is installed and accessible:
- For Claude: run `claude --version` and confirm it returns a version number
- For Codex: run `codex --version` and confirm it returns a version number
- For Gemini: run `gemini --version` and confirm it returns a version number

If the engine command is not found, inform the user that the engine is not installed or not on their PATH.

If the engine is installed but its turns fail with an authentication error, its login has expired. The operator can log in again on the host with the CLI's own login command, or — where the Slack connector has `providerAuth` enabled — by sending `ログイン` to the bot in their own DM (see `docs/connectors.md`, "Provider Re-login").

### 5. Check Sessions

List sessions through the API, never by opening the database:

```bash
ryoko api GET /api/sessions
```

A status alone does not show that a session is stuck:

- `running`: a turn is in progress. Long turns are normal. When the engine process behind a turn is gone, the gateway notices by itself, within about a minute at most: it records the turn as failed or lost, with the reason, and tells the parent session.
- `waiting`: the turn met a usage limit and waits for it to reset, for up to six hours. It continues by itself, also after a restart.
- `interrupted`: the turn was cut off, usually by a restart. By default the gateway wakes such sessions itself after it starts: up to 10 per start, and only an interruption of the last 120 minutes (see `docs/architecture.md`, "Session Lifecycle"). One that was not woken stays `interrupted` until a new message continues it.
- `error`: the last turn failed, and `lastError` says why. The next message starts a new turn.
- `idle`: nothing is running.

### 6. Check Disk Space

Read `storage` in `/api/status`, or check the free space of the disk the home is on. Do not make room by clearing `tmp/` (see "Leave `tmp/` Alone").

## Common Fixes

### Restart Gateway

If the gateway appears to be in a bad state (crash loops, unresponsive, port conflicts), tell the user to restart it the way it is run:

```bash
ryoko stop
ryoko start
```

When it runs as a service or in a container, the service or the container is restarted instead. A restart ends every turn that is running, yours included. Do not restart the gateway yourself unless the user asked you to. By default, sessions that were cut off are woken after the next start, within the limits given under "Check Sessions".

### Restore a File from a Backup

For `config.yaml`, `cron/jobs.json`, persona and memory files, `org/`, `skills/`, `docs/` and `knowledge/`:

```bash
ryoko backup list                                     # newest first; the first column is the id
ryoko backup restore <id> --only <kind> --dry-run     # shows what would change, writes nothing
ryoko backup restore <id> --only <kind>               # restores
```

`<kind>` is one or more of `config`, `cron`, `cron-history`, `persona`, `memory`, `org`, `skills`, `docs`, `knowledge`, `workflows`, separated by commas. Use an `id` that starts with `home-`.

- A restore only writes. It puts back the files the backup holds and removes nothing. What it overwrites is saved first as `pre-restore-…`.
- Restoring files is safe while the gateway runs. It reloads `config.yaml`, `cron/jobs.json`, `org/` and `skills/` by itself.
- `config` also puts back `.env`, and the tokens as they were when the backup was taken.

**Never restore a database yourself.** The ids that start with `sessions-` or `workflows-` are database copies. Restoring one needs the gateway stopped, which ends your own turn. If a database has to be restored, give the operator these steps from `docs/backup.md`: stop the gateway, wait a minute, run `ryoko backup restore sessions-<date> --gateway-stopped` where the gateway runs (inside the container when it runs in one), then start the gateway.

Before a risky edit, `ryoko backup run` archives those files on the spot; it leaves the databases alone, which the gateway copies itself once a day.

### Fix Malformed JSON

If a JSON file (`cron/jobs.json`, a department's `board.json`) is malformed:
1. Read the raw file content.
2. Identify the syntax error (missing comma, bracket, quote).
3. Fix that error in a copy and parse the copy to verify it.
4. Replace the file with the verified copy: write a temporary file beside it and rename it.
5. If you cannot repair it, restore it from a backup (`--only cron` for `jobs.json`, `--only org` for a board).
6. If no backup helps, keep the broken file under another name, tell the user what could not be recovered, and stop.

Never replace `cron/jobs.json` with an empty list `[]`. While the file cannot be read, the scheduler keeps the jobs it had registered. A valid empty list removes every one of them. The `cron-manager` skill has the rules for editing jobs.

### Fix Malformed YAML

If a YAML file (`config.yaml`, employee personas) is malformed:
1. Read the raw file content.
2. Identify the syntax error (indentation, missing colon, bad quoting).
3. Fix that error in a copy and validate the copy.
4. Replace the file with the validated copy: write a temporary file beside it and rename it.
5. If you cannot repair it, restore it from a backup (`--only config` for `config.yaml`, `--only org` for a persona).
6. If no backup helps, keep the broken file under another name and tell the user which settings need to be entered again. Do not write a new `config.yaml` from memory: it holds the connector tokens.

### Sessions That Look Stuck

Do not change a session's status in `sessions/registry.db`. Check first whether the session is stuck at all (see "Check Sessions"), then use what the gateway provides:

- To stop a turn that should not go on: `ryoko api POST /api/sessions/<id>/stop`. It stops the engine process of that session and clears the messages queued behind it. The conversation continues with the next message.
- When a session keeps failing because its engine-side conversation can no longer be resumed: `ryoko api POST /api/sessions/<id>/reset`. It also forgets the engine-side conversation, so the next turn starts a new one. The transcript the gateway keeps is not deleted.
- From chat, the user can send `/new`: the session of that conversation is deleted, and the next message starts a new one.

Leave `waiting` sessions and long `running` turns alone. Never stop or reset the session you are running in. Report which sessions you acted on.

### Leave `tmp/` Alone

Do not delete the contents of `tmp/`. It holds what running work depends on:

- `tmp/attachments/`: the files of turns that are queued or running. A turn that waits for a usage limit keeps its files for hours.
- `tmp/engine-health.json`: which engine is out of allowance. New sessions are started by it.
- `tmp/settings/` and `tmp/mcp/`: the settings that running Claude sessions were started with.
- `tmp/pty-snapshots/`: the terminal history of interactive sessions.
- `tmp/restore-…`: the working directory of a restore in progress.

The gateway cleans up after itself. Attachments are removed when their turn ends, and leftovers older than 24 hours are swept every hour.

### Fix Port Conflicts

If the gateway cannot bind to its configured port:
1. Check if another process is using the port: `lsof -i :<port>`
2. If another {{portalName}} instance is running, tell the user to stop it first.
3. If a different process is using the port, suggest changing `gateway.port` in `config.yaml`. A changed port takes effect after a restart.

## Reference

For understanding {{portalName}}'s architecture and component relationships, refer to the documentation in `docs/`. `docs/backup.md` describes what a backup holds, what it leaves out, and how a restore works.

## Error Handling

- If log files do not exist, note that logging may not be configured and skip that check.
- If `config.yaml` does not exist, this is likely a fresh install — suggest running the onboarding process instead.
- Keep a copy of every file you modify during a repair.
- Report all findings clearly to the user, even if no issues are found (a clean bill of health is useful information).
