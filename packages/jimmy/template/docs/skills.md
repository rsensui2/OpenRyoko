# Skills

Skills are markdown instruction sets that engines read and follow. There is no runtime, no loading system, no plugin API. Engines handle skills natively by reading the SKILL.md file.

## How Skills Work

Each skill is a directory in `~/.ryoko/skills/` containing at minimum a `SKILL.md` file. When an engine starts a session, it has access to the skills directory and can read any skill's instructions.

The `SKILL.md` file contains:
- **Trigger description**: When this skill should be activated
- **Instructions**: Step-by-step directions for the engine
- **Data file references**: Paths to any supporting files in the skill directory

## Creating a Skill

```
~/.ryoko/skills/
  my-skill/
    SKILL.md          # Required: instructions
    data.json         # Optional: supporting data
    template.txt      # Optional: templates, examples, etc.
```

### Example SKILL.md

```markdown
# Deploy Notification Skill

## Trigger
When the user says "deploy" or asks about deployment status.

## Instructions
1. Read the deployment config from `data/deploy-targets.json` in this skill directory
2. Check the current git branch and latest commit
3. Format a deployment summary with target environment, branch, and commit hash
4. Ask for confirmation before proceeding

## Data Files
- `deploy-targets.json`: List of deployment targets with URLs and environment names
```

## Pre-packaged Skills

{{portalName}} ships with these default skills (see `~/.ryoko/skills/`):

- **onboarding**: First-run setup — fills IDENTITY.md / SOUL.md / MEMORY.md interactively
- **openryoko-config**: Explain and configure the platform, including version-aware Claude Code/Codex fallback and Jev triage; verify runtime application
- **management**: Hiring, firing, promotions, delegation, and board reviews for the org
- **cron-manager**: Create, edit, enable/disable, and troubleshoot cron jobs
- **skill-creator**: Write a SKILL.md playbook to create a new skill
- **find-and-install**: Discover skills via `npx skills find` and install them
- **self-heal**: Diagnose and repair {{portalName}}'s own configuration and runtime
- **migrate**: Apply pending version migrations
- **sync** / **new** / **status**: Slash-command playbooks (`/sync`, `/new`, `/status`)

### Keeping bundled skills up to date

`ryoko setup` copies bundled skills on a new installation. After that they are synced
each time the gateway starts and each time `ryoko migrate` runs (including `--auto`, as
used by `ryoko update`), with or without pending version migrations. `--check` changes
nothing.

The sync replaces a skill only when it can prove the copy is unmodified. It keeps a
receipt, `~/.ryoko/skills/.shipped-skills.json`, with a sha256 for every file of every
bundled skill it placed.

| The skill in `~/.ryoko/skills/` | What the sync does |
|---|---|
| Missing, and the sync has no record of placing it | Installs it |
| Missing, but the sync placed it earlier (you deleted it) | Gateway start leaves it out and says so once per release. `ryoko migrate` puts it back |
| Unedited since the sync placed it, and a newer version ships | Replaces it and keeps the previous copy |
| Edited, or holding files you added | Leaves it alone; tells you once per release when a newer version ships |
| A symlink, or holding a symlink | Leaves it alone |
| Identical to the shipped version, not yet in the receipt | Leaves it alone and starts tracking it |
| Different from the shipped version, not in the receipt | Leaves it alone and tells you once per release |
| No longer shipped, unedited | Moves it to the backup directory |
| No longer shipped, edited | Leaves it alone |

- **Your changes are never overwritten.** To customize a bundled skill, edit it in place;
  it stops following releases. To return to the shipped version, move the skill's
  directory aside and run `ryoko migrate`.
- **A bundled skill you delete stays deleted.** Restarting the gateway does not bring it
  back; the receipt keeps a `"deleted": true` mark for it. `ryoko migrate` (and so
  `ryoko update`, which runs it) reinstalls it. To keep a skill out even then, leave an
  empty directory with its name.
- **Nothing is deleted.** A replaced or retired skill is moved to
  `~/.ryoko/.migration-backups/<version>-<time>/skills/<name>/`. Remove old backups by
  hand when you no longer need them.
- On the first start after upgrading to a release with this sync there is no receipt
  yet, so nothing is replaced: missing skills are added (including any you had deleted
  before, once) and skills identical to the shipped version are recorded. Updates start
  with the release after that.
- If `~/.ryoko/skills` is itself a symlink, nothing is synced into it.
- Do not edit `.shipped-skills.json`. Deleting it is safe, though it also forgets which
  skills you deleted: missing bundled skills are installed again, skills identical to the
  shipped version are tracked again, and everything else is left alone.
- `skills.autoSync: false` in `config.yaml` stops the sync at gateway start.
  `ryoko migrate` syncs either way.

## Key Points

- Skills are just files. Engines read them as context.
- No compilation, no imports, no runtime hooks.
- Any file format works as supporting data (JSON, YAML, CSV, plain text).
- Skills can reference other skills by path.
- Engines decide when and how to apply skill instructions based on the trigger description.
