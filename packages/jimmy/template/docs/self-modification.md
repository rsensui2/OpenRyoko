# Self-Modification

{{portalName}}'s engines operate within `~/.ryoko/` and can modify any file in that directory. This enables {{portalName}} to update its own configuration, create skills, manage cron jobs, and restructure the organization at runtime.

## What {{portalName}} Can Edit

| File/Directory | Effect of Modification |
|---|---|
| `config.yaml` | File watcher reloads config; boot-time components may still need restart |
| `cron/jobs.json` | File watcher reschedules the jobs that changed |
| `org/**/*.yaml` | File watcher triggers employee registry rebuild |
| `org/**/board.json` | Read on demand by employees; no watcher needed |
| `skills/*/SKILL.md` | Read on demand by engines; no watcher needed |
| `skills/**/*` | Supporting skill data; read on demand |

## File Watcher Reactions

The gateway uses chokidar to watch for changes:

- **config.yaml** → Parse YAML and reload the config reference used by session dispatch; reload changed connectors. Parsing does not guarantee full schema validation or application to already-constructed components.
- **cron/jobs.json** → Parse JSON and validate it, then reschedule the jobs that changed and unschedule the ones that were removed or disabled. A file that cannot be read changes nothing: the jobs registered before stay scheduled
- **org/\*\*/\*.yaml** → Rebuild the employee registry from all persona and department YAML files

Ordinary session defaults, cron files, employees and skills reload at runtime. Changes
to gateway port/host, Claude interactive PTY construction settings, enabling workflows,
or process environment require restart (or container recreation for environment changes).
Existing sessions may retain engine/model overrides. Confirm the effective behavior,
not just the saved config. Use `skills/openryoko-config/SKILL.md` and its references for
version-specific settings, Jev triage and execution-engine fallback.

## Safety Guidelines

Engines have full file access within `~/.ryoko/`. To avoid breaking the gateway:

### Do

- Validate YAML before writing to `config.yaml` (must be valid YAML with expected schema)
- Validate JSON before writing to `jobs.json` or `board.json`
- Use atomic writes (write to temp file, then rename) for critical files
- Back up files before making destructive changes
- Test cron expressions before adding them to `jobs.json`
- If an edit breaks one of these files, restore yesterday's copy instead of rebuilding it by hand: `ryoko backup list`, then `ryoko backup restore <id> --only <kind> --dry-run`. See `docs/backup.md`

### Do Not

- Break `config.yaml` structure — invalid YAML will prevent config reload
- Corrupt `sessions/registry.db` — the SQLite database is managed by the gateway process
- Write an empty list `[]` to `jobs.json` to "reset" it — a valid empty list unschedules every job. Invalid JSON does not: the scheduler keeps the jobs it had and logs that the reload was skipped, so the broken file is easy to miss
- Delete the `docs/` directory — these reference docs are needed for self-awareness
- Modify files outside `~/.ryoko/` unless explicitly instructed by the user

## Example: Creating a Cron Job at Runtime

An engine creates a new cron job through the API, which validates the job, writes `cron/jobs.json` in one step and reloads the scheduler:

```
1. Read the current jobs: ryoko api GET /api/cron
2. Build the new job object with a unique id, schedule, prompt, etc.
3. Create it: ryoko api POST /api/cron --data '<the job as JSON>'
4. Read it back with ryoko api GET /api/cron and check its `scheduler` state
```

Edit `cron/jobs.json` directly only for offline recovery, when the gateway is not running. The `cron-manager` skill has the rules.

## Example: Adding a New Employee

```
1. Create ~/.ryoko/org/<department>/<name>.yaml with required fields
2. The file watcher detects the new file and rebuilds the employee registry
3. The new employee is immediately available for @mention routing
```
