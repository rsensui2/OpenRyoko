---
name: onboarding
description: Walk a new user through initial {{portalName}} setup and customization
---

# Onboarding Skill

## Trigger

This skill activates on {{portalName}}'s first run, or when the user explicitly asks to go through the onboarding/setup process.

## Steps

### 1. Welcome the User

Greet the user warmly. Introduce {{portalName}} as their AI-powered assistant and gateway. Keep it brief and friendly.

Example: "Hey! I'm {{portalName}}, your AI assistant. Let me learn about you so I can be more useful."

### 2. Ask About the User

Ask the following (all at once, not one by one):
1. **Who are you?** — Name, role, business/company
2. **What should {{portalName}} help with?** — Code reviews, deployments, monitoring, content, research, etc.
3. **Communication style** — Do you prefer concise or detailed responses? Emoji or no emoji? What language?
4. **Active projects** — What are you working on right now? Tech stacks, repos, status?

### 3. Write Knowledge Files

After the user responds, write the answers to the appropriate knowledge files:

**`~/.jimmy/knowledge/user-profile.md`**:
```markdown
# User Profile

- **Name**: [name]
- **Role**: [role]
- **Business**: [business/company]
- **Goals**: [what they want {{portalName}} to help with]
```

**`~/.jimmy/knowledge/preferences.md`**:
```markdown
# Preferences

- **Verbosity**: [concise/detailed]
- **Emoji**: [yes/no/minimal]
- **Language**: [language]
- **Other**: [any other preferences mentioned]
```

**`~/.jimmy/knowledge/projects.md`**:
```markdown
# Active Projects

## [Project Name]
- **Stack**: [tech stack]
- **Repo**: [repo path or URL]
- **Status**: [status]
- **Notes**: [anything relevant]
```

### 4. Check for OpenClaw Migration

Check if `~/.openclaw/` exists.

If it does, offer to migrate:
1. Read `~/.openclaw/openclaw.json` for config
2. Scan `~/.openclaw/cron/jobs.json` for scheduled tasks
3. Scan `~/.openclaw/skills/` for skill playbooks
4. Scan `~/.openclaw/memory/` and `~/.openclaw/knowledge/` for stored context

Present a summary and let the user choose what to migrate. Only migrate approved items.

If no OpenClaw installation, skip this step.

### 5. Scaffold Organization

Based on the user's projects and needs, suggest an initial org structure:
- Solo dev → `engineering` department with a `dev-assistant`
- Content creator → `content` and `research` departments
- Startup founder → `engineering`, `marketing`, `operations`

Confirm with the user before creating anything.

### 6. Suggest Cron Jobs

Suggest useful recurring jobs based on their projects:
- Daily standup summaries
- Weekly reports
- Code review reminders

Only create jobs the user approves.

### 7. Wrap Up

Summarize what was set up and suggest next steps:
- "Try delegating a task to an employee"
- "Ask me to create a custom skill"
- "Set up a Slack connector for notifications"

## Error Handling

- If `~/.jimmy/knowledge/` doesn't exist, create it
- If the user seems overwhelmed, simplify — suggest one department and one employee
- If the user wants to skip onboarding, respect that and exit gracefully
