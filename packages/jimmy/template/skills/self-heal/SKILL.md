---
name: self-heal
description: Diagnose and fix problems in {{portalName}}'s configuration and runtime
---

# Self-Heal Skill

## Trigger

This skill activates when {{portalName}} is experiencing issues, errors, or unexpected behavior. It also activates when the user asks to diagnose problems, check system health, or fix something that is not working.

## Diagnostic Steps

Work through these checks in order. Stop and fix issues as you find them.

### 1. Check Gateway Logs

Read `~/.jimmy/logs/gateway.log` and look for:
- Error messages or stack traces
- Repeated failures or crash loops
- Connection refused or timeout errors
- Out of memory warnings
- Unhandled promise rejections

Summarize any problems found to the user.

### 2. Validate Configuration

Read `~/.jimmy/config.yaml` and verify:
- The file is valid YAML (no syntax errors)
- The `port` field is a valid number (typically 3777)
- Required fields are present: `port`, `engine`, `model`
- Engine value is one of: `claude`, `codex`
- No duplicate keys or malformed values

### 3. Verify Engine Availability

Check that the configured AI engine is installed and accessible:
- For Claude: run `claude --version` and confirm it returns a version number
- For Codex: run `codex --version` and confirm it returns a version number

If the engine command is not found, inform the user that the engine is not installed or not on their PATH.

### 4. Check Session Database

Look at the session registry for stuck sessions:
- Read `~/.jimmy/sessions.db` or the session storage
- Look for sessions with status `running` that have not been updated recently (more than 30 minutes old)
- These may be stuck and need to be reset

### 5. Check Disk and Temp Files

- Check if `~/.jimmy/tmp/` contains stale files that should be cleaned up
- Large or numerous temp files can cause issues

## Common Fixes

### Restart Gateway

If the gateway appears to be in a bad state (crash loops, unresponsive, port conflicts):

Tell the user to run:
```bash
jimmy stop && jimmy start
```

### Clear Temp Directory

If temp files are stale or causing issues:

Delete all contents of `~/.jimmy/tmp/` but keep the directory itself.

### Fix Malformed JSON

If any JSON file (board.json, jobs.json, etc.) is malformed:
1. Read the raw file content.
2. Attempt to identify the syntax error (missing comma, bracket, quote).
3. Fix the error and parse to verify.
4. Write the corrected JSON back to the file.
5. If the file is unrecoverable, back it up as `<filename>.bak` and create a fresh default (empty array `[]` for boards and job files).

### Fix Malformed YAML

If any YAML file (config.yaml, employee personas) is malformed:
1. Read the raw file content.
2. Attempt to identify the syntax error (indentation, missing colon, bad quoting).
3. Fix the error and validate.
4. Write the corrected YAML back to the file.
5. If unrecoverable, back it up and inform the user what fields need to be re-entered.

### Reset Stuck Sessions

If sessions are stuck in `running` status:
1. Identify the stuck sessions (running for more than 30 minutes with no updates).
2. Update their status to `failed` or `cancelled` in the session registry.
3. Report which sessions were reset.

### Fix Port Conflicts

If the gateway cannot bind to its configured port:
1. Check if another process is using the port: `lsof -i :<port>`
2. If another {{portalName}} instance is running, tell the user to stop it first.
3. If a different process is using the port, suggest changing the port in `config.yaml`.

## Reference

For understanding {{portalName}}'s architecture and component relationships, refer to the documentation in `~/.jimmy/docs/` if available.

## Error Handling

- If log files do not exist, note that logging may not be configured and skip that check.
- If config.yaml does not exist, this is likely a fresh install — suggest running the onboarding process instead.
- Always back up files before modifying them during repair.
- Report all findings clearly to the user, even if no issues are found (a clean bill of health is useful information).
