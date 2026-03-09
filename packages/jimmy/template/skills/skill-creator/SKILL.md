---
name: skill-creator
description: Create new custom skills by writing SKILL.md playbooks
---

# Skill Creator Skill

## Trigger

This skill activates when the user wants to create a new custom skill for {{portalName}}.

## Output Location

All skills are stored at `~/.jimmy/skills/<skill-name>/SKILL.md`. Each skill lives in its own directory named with kebab-case.

## Behavior by Engine

### Claude Code (claude engine)

Claude Code has native skill creation capabilities. Defer to the engine's built-in skill/memory system when available. The engine knows how to create well-structured instruction files. Simply ensure the output file lands at the correct path: `~/.jimmy/skills/<skill-name>/SKILL.md`.

### Codex (codex engine)

Create the SKILL.md file manually following the conventions below. Write the file directly to `~/.jimmy/skills/<skill-name>/SKILL.md`.

## Steps

1. Ask the user what the skill should do. Get a clear description of the capability.
2. Ask for a name (kebab-case). Suggest one if the user does not provide it.
3. Create the directory `~/.jimmy/skills/<skill-name>/` if it does not exist.
4. Generate the SKILL.md content following the conventions below.
5. Write the file to `~/.jimmy/skills/<skill-name>/SKILL.md`.
6. Confirm the skill was created and summarize what it does.

## Conventions for Writing Good SKILL.md Files

Every SKILL.md should follow these conventions:

### 1. Clear Trigger Description

Start with a `## Trigger` section that explains exactly when this skill should activate. Be specific about the keywords, phrases, or situations that should invoke this skill.

Good: "This skill activates when the user asks to generate a weekly report from their GitHub repositories."
Bad: "This skill does reporting stuff."

### 2. Step-by-Step Instructions

Provide numbered steps that an AI engine can follow without ambiguity. Each step should be a concrete action, not a vague directive.

Good: "1. Read the file at `~/.jimmy/data/repos.json`. 2. For each repository, fetch the latest commits from the past 7 days."
Bad: "1. Get the data. 2. Process it."

### 3. Data File References

Specify exact file paths for any data the skill reads or writes. Use `~/.jimmy/` as the base directory. Define the expected schema for any JSON or YAML files.

### 4. Error Handling Guidance

Include a section on what to do when things go wrong: missing files, malformed data, unavailable services. Provide fallback behavior.

### 5. Keep Skills Focused

Each skill should do one thing well. If a skill is trying to do too many things, suggest splitting it into multiple skills.

### 6. Use Concrete Examples

Include example inputs, outputs, file contents, and commands wherever possible. Examples remove ambiguity.

## Template

Use this template as a starting point. **YAML frontmatter is required** — both Claude Code and Codex CLIs discover skills by reading frontmatter from `SKILL.md` files. Without it, the skill won't be recognized by engines.

```markdown
---
name: <skill-name>
description: <One-line description of what this skill does>
---

# <Skill Name>

## Trigger

This skill activates when <specific trigger description>.

## Data Files

- `~/.jimmy/<path>` — <description of the file and its format>

## Steps

1. <First concrete action>
2. <Second concrete action>
3. ...

## Examples

<Example input and expected behavior>

## Error Handling

- If <error condition>, then <fallback behavior>.
```

## Auto-Sync

The gateway automatically creates symlinks in `~/.jimmy/.claude/skills/` and `~/.jimmy/.agents/skills/` pointing to each skill directory. This happens on startup and whenever the `skills/` directory changes. You do not need to manage symlinks manually.

## Error Handling

- If a skill with the same name already exists, ask the user whether to overwrite or choose a different name.
- Validate that the skill name is valid kebab-case (lowercase letters, numbers, and hyphens only).
- If the user's description is too vague, ask clarifying questions before generating the skill.
