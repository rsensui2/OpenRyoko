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
- **management**: Hiring, firing, promotions, delegation, and board reviews for the org
- **cron-manager**: Create, edit, enable/disable, and troubleshoot cron jobs
- **skill-creator**: Write a SKILL.md playbook to create a new skill
- **find-and-install**: Discover skills via `npx skills find` and install them
- **self-heal**: Diagnose and repair {{portalName}}'s own configuration and runtime
- **migrate**: Apply pending version migrations
- **sync** / **new** / **status**: Slash-command playbooks (`/sync`, `/new`, `/status`)

## Key Points

- Skills are just files. Engines read them as context.
- No compilation, no imports, no runtime hooks.
- Any file format works as supporting data (JSON, YAML, CSV, plain text).
- Skills can reference other skills by path.
- Engines decide when and how to apply skill instructions based on the trigger description.
