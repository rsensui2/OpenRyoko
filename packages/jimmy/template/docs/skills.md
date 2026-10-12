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
| Missing, but the sync placed it earlier (you deleted it) | Leaves it out and says so once per release. Only `ryoko migrate --restore-deleted-skills [name...]` puts it back |
| Unedited since the sync placed it, and a newer version ships | Replaces it and keeps the previous copy |
| Edited, or holding files you added | Leaves it alone; tells you once per release when a newer version ships |
| A symlink, or holding a symlink | Leaves it alone |
| Unreadable, or larger than any bundled skill is (a file over 1 MiB, over 2 MiB in all, or over 500 files and directories) | Leaves it alone, unread, and tells you once per release |
| Identical to the shipped version, not yet in the receipt | Leaves it alone and starts tracking it |
| An untouched copy of a version an earlier release shipped, not in the receipt | Replaces it and keeps the previous copy |
| Different from every version ever shipped, not in the receipt | Leaves it alone and tells you once per release |
| No longer shipped, unedited | Moves it to the backup directory |
| No longer shipped, edited | Leaves it alone |

- **Your changes are never overwritten.** To customize a bundled skill, edit it in place;
  it stops following releases. To return to the shipped version, move the skill's
  directory aside and run `ryoko migrate --restore-deleted-skills <name>`. (A skill the
  notice describes as having no record of how it was installed is not in the receipt:
  for that one, moving it aside and restarting is enough.)
- **A bundled skill you delete stays deleted.** Neither restarting the gateway, nor
  `ryoko migrate`, nor `ryoko update` brings it back; the receipt keeps a
  `"deleted": true` mark for it. `ryoko migrate --restore-deleted-skills <name>...`
  reinstalls the skills you name and leaves the other deleted ones deleted. Without a
  name it reinstalls every bundled skill you deleted.
- **Nothing is deleted.** A replaced or retired skill is moved to
  `~/.ryoko/.migration-backups/<version>-<time>/skills/<name>/`. Remove old backups by
  hand when you no longer need them.
- A sync that is cut short (the machine goes down, the process is killed) can leave a
  `.bundled-skill-XXXXXX` directory in `~/.ryoko`. A later sync removes it once it is an
  hour old, provided it holds nothing but bundled skills, and says that it did.
- On the first start after upgrading to a release with this sync there is no receipt
  yet. Missing skills are added (including any you had deleted before, once). For the
  rest, the package carries fingerprints of every version of every bundled skill that
  earlier releases shipped: a skill that is exactly one of those, file for file, is
  untouched and is brought up to date. Anything else is left alone — a skill you
  edited, or one installed under an assistant name other than the current one or the
  installer's default.
- If `~/.ryoko/skills` is itself a symlink, it is your own skill store and nothing is
  synced into it: no receipt, no updates, no retirements. `ryoko migrate` says so, and
  handles skills there as it did before the sync existed: it adds bundled skills that
  are missing, copies a migration's new skill files, and leaves the ones that exist to
  the AI merge.
- Do not edit `.shipped-skills.json`. Deleting it is safe, though it also forgets which
  skills you deleted: missing bundled skills are installed again, skills identical to the
  shipped version are tracked again, and everything else is left alone.
- When the receipt was written by a newer OpenRyoko than the one running (an older CLI
  pointed at the same home, say), the older one changes no skill and says so at every
  start. If no newer version uses the home, the receipt is wrong and can be fixed or
  deleted.
- When the sync cannot run at all — the receipt is unreadable, say, or was written by a
  newer OpenRyoko — `ryoko migrate` does not start a migration: it would end up recorded
  as applied with its skill changes left out. It names the cause; fix that and run it
  again. `ryoko migrate --auto` still applies what has nothing to do with skills, and
  records the version only when that was everything.
- `skills.autoSync: false` in `config.yaml` stops the sync at gateway start.
  `ryoko migrate` syncs either way.

## Key Points

- Skills are just files. Engines read them as context.
- No compilation, no imports, no runtime hooks.
- Any file format works as supporting data (JSON, YAML, CSV, plain text).
- Skills can reference other skills by path.
- Engines decide when and how to apply skill instructions based on the trigger description.
