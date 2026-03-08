import fs from "node:fs";
import path from "node:path";
import type { Employee, JimmyConfig } from "../shared/types.js";
import { JIMMY_HOME, SKILLS_DIR, ORG_DIR, CRON_JOBS, DOCS_DIR } from "../shared/paths.js";

const MAX_CONTEXT_CHARS = 32000;

/**
 * Build a rich system prompt for engine sessions.
 * This is what makes Jimmy "smart" — the engine sees all of this context
 * before responding to the user.
 */
export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
  connectors?: string[];
  config?: JimmyConfig;
  sessionId?: string;
}): string {
  const sections: string[] = [];

  // ── Identity ──────────────────────────────────────────────
  if (opts.employee) {
    sections.push(buildEmployeeIdentity(opts.employee));
  } else {
    sections.push(buildIdentity());
  }

  // ── Self-evolution ────────────────────────────────────────
  if (!opts.employee) {
    sections.push(buildEvolutionContext());
  }

  // ── CLAUDE.md (user-defined instructions) ─────────────────
  const claudeMd = loadClaudeMd();
  if (claudeMd) {
    sections.push(`## User Instructions (CLAUDE.md)\n\n${claudeMd}`);
  }

  // ── Session context ───────────────────────────────────────
  sections.push(buildSessionContext({ ...opts, sessionId: opts.sessionId }));

  // ── Configuration awareness ───────────────────────────────
  if (opts.config) {
    sections.push(buildConfigContext(opts.config));
  }

  // ── Organization ──────────────────────────────────────────
  const orgCtx = buildOrgContext();
  if (orgCtx) sections.push(orgCtx);

  // ── Skills ────────────────────────────────────────────────
  const skillsCtx = buildSkillsContext();
  if (skillsCtx) sections.push(skillsCtx);

  // ── Cron jobs ─────────────────────────────────────────────
  const cronCtx = buildCronContext();
  if (cronCtx) sections.push(cronCtx);

  // ── Knowledge / docs ──────────────────────────────────────
  const knowledgeCtx = buildKnowledgeContext();
  if (knowledgeCtx) sections.push(knowledgeCtx);

  // ── Connectors (Slack, etc.) ──────────────────────────────
  if (opts.connectors && opts.connectors.length > 0) {
    sections.push(buildConnectorContext(opts.connectors));
  }

  // ── Local environment ────────────────────────────────────
  const envCtx = buildEnvironmentContext();
  if (envCtx) sections.push(envCtx);

  // ── Delegation protocol ──────────────────────────────────
  if (!opts.employee) {
    sections.push(buildDelegationProtocol(opts.config));
  }

  // ── Gateway API reference ─────────────────────────────────
  sections.push(buildApiReference());

  // ── Size guard: progressively trim if over budget ─────────
  return trimContext(sections);
}

// ═══════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════

function buildEmployeeIdentity(employee: Employee): string {
  return `# You are ${employee.displayName}

You are an AI employee in the Jimmy gateway system.

## Your persona
${employee.persona}

## Your role
- **Name**: ${employee.name}
- **Display name**: ${employee.displayName}
- **Department**: ${employee.department}
- **Rank**: ${employee.rank}
- **Engine**: ${employee.engine}
- **Model**: ${employee.model}

## System context
You are part of the Jimmy AI gateway — a system that orchestrates AI workers. You have access to the filesystem, can run commands, call APIs, and send messages via connectors. Your working directory is \`~/.jimmy\` (${JIMMY_HOME}).

You can:
- Read and write files in the Jimmy home directory
- Run shell commands
- Call the Jimmy gateway API to interact with other parts of the system
- Send messages via connectors (Slack, etc.)
- Access skills, knowledge base, and documentation
- Collaborate with other employees by mentioning them or creating sessions

Be proactive, take initiative, and deliver results. You're not a chatbot — you're a worker.`;
}

function buildIdentity(): string {
  return `# You are Jimmy

Jimmy is a personal AI assistant and gateway daemon. You are proactive, helpful, and opinionated — not a passive tool. You anticipate needs, suggest improvements, and take initiative when appropriate.

## Core principles
- **Be proactive**: Don't just answer questions — suggest next steps, flag issues, offer to do related tasks.
- **Be concise**: Respect the user's time. Lead with the answer, not the reasoning.
- **Be capable**: You have access to the filesystem, can run commands, call APIs, send messages via connectors, and manage the Jimmy system.
- **Be honest**: If you don't know something or can't do something, say so clearly.
- **Remember context**: You're part of a persistent system. Sessions can be resumed. Build on previous work.

## Your home directory
Your working directory is \`~/.jimmy\` (${JIMMY_HOME}). This contains:
- \`config.yaml\` — your configuration (engines, connectors, logging)
- \`org/\` — employee definitions (YAML files defining AI workers)
- \`skills/\` — reusable skill prompts
- \`docs/\` — documentation and knowledge base
- \`knowledge/\` — persistent knowledge files
- \`cron/\` — scheduled job definitions and run history
- \`sessions/\` — session database
- \`logs/\` — gateway logs
- \`CLAUDE.md\` — user-defined instructions (always follow these)
- \`AGENTS.md\` — agent/employee documentation

You can read, write, and modify any of these files to configure yourself, create new employees, add skills, etc.`;
}

function loadClaudeMd(): string | null {
  const claudePath = path.join(JIMMY_HOME, "CLAUDE.md");
  try {
    const content = fs.readFileSync(claudePath, "utf-8").trim();
    // Skip if it's just the default template
    if (content.length < 100 && content.includes("Jimmy orchestrates Claude Code")) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}

function buildSessionContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  sessionId?: string;
}): string {
  let ctx = `## Current session\n`;
  if (opts.sessionId) ctx += `- Session ID: ${opts.sessionId}\n`;
  ctx += `- Source: ${opts.source}\n`;
  ctx += `- Channel: ${opts.channel}\n`;
  if (opts.thread) ctx += `- Thread: ${opts.thread}\n`;
  ctx += `- User: ${opts.user}\n`;
  ctx += `- Working directory: ${JIMMY_HOME}`;
  return ctx;
}

function buildConfigContext(config: JimmyConfig): string {
  const lines: string[] = [`## Current configuration`];
  lines.push(`- Gateway: http://${config.gateway.host || "127.0.0.1"}:${config.gateway.port}`);
  lines.push(`- Default engine: ${config.engines.default}`);
  if (config.engines.claude?.model) {
    lines.push(`- Claude model: ${config.engines.claude.model}`);
  }
  if (config.engines.codex?.model) {
    lines.push(`- Codex model: ${config.engines.codex.model}`);
  }
  if (config.logging) {
    lines.push(`- Log level: ${config.logging.level || "info"}`);
  }
  return lines.join("\n");
}

function buildOrgContext(): string | null {
  try {
    const files = fs.readdirSync(ORG_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    if (files.length === 0) return null;

    const lines: string[] = [`## Organization (${files.length} employee(s))`];
    for (const file of files) {
      const content = fs.readFileSync(path.join(ORG_DIR, file), "utf-8");
      const name = file.replace(/\.ya?ml$/, "");
      // Extract display name, department, rank, and persona first line from YAML
      const displayMatch = content.match(/displayName:\s*(.+)/);
      const deptMatch = content.match(/department:\s*(.+)/);
      const rankMatch = content.match(/rank:\s*(.+)/);
      const personaMatch = content.match(/persona:\s*[|>]?\s*\n?\s*(.+)/);
      let entry = `- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`;
      if (personaMatch?.[1]) {
        entry += `\n  _${personaMatch[1].trim().slice(0, 120)}_`;
      }
      lines.push(entry);
    }
    lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildSkillsContext(): string | null {
  try {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory());
    if (dirs.length === 0) return null;

    const lines: string[] = [`## Available skills (${dirs.length})`];
    for (const dir of dirs) {
      const skillPath = path.join(SKILLS_DIR, dir.name, "SKILL.md");
      try {
        const content = fs.readFileSync(skillPath, "utf-8").trim();
        if (content.length <= 500) {
          lines.push(`### ${dir.name}\n${content}`);
        } else {
          lines.push(`### ${dir.name}\n${content.slice(0, 500)}...\n_(full instructions: ${skillPath})_`);
        }
      } catch {
        lines.push(`- ${dir.name} (no SKILL.md found)`);
      }
    }
    return lines.join("\n\n");
  } catch {
    return null;
  }
}

function buildCronContext(): string | null {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const lines: string[] = [`## Scheduled cron jobs (${jobs.length})`];
    for (const job of jobs) {
      const status = job.enabled === false ? " (disabled)" : "";
      lines.push(`- **${job.name}**: \`${job.schedule}\`${status}${job.employee ? ` → ${job.employee}` : ""}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildKnowledgeContext(): string | null {
  const dirs = [DOCS_DIR, path.join(JIMMY_HOME, "knowledge")];
  const allFiles: string[] = [];

  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"));
      allFiles.push(...files.map(f => path.join(dir, f)));
    } catch {
      // dir doesn't exist
    }
  }

  if (allFiles.length === 0) return null;

  const MAX_PER_FILE = 1000;
  const MAX_TOTAL = 4000;
  let totalChars = 0;

  const lines: string[] = [`## Knowledge base (${allFiles.length} file(s))`];
  for (const file of allFiles) {
    if (totalChars >= MAX_TOTAL) {
      lines.push(`\n_(${allFiles.length - lines.length + 1} more files — read them directly from \`${DOCS_DIR}/\` or \`~/.jimmy/knowledge/\`)_`);
      break;
    }
    try {
      const content = fs.readFileSync(file, "utf-8").trim();
      const basename = path.basename(file);
      if (content.length <= MAX_PER_FILE) {
        lines.push(`### ${basename}\n${content}`);
        totalChars += content.length;
      } else {
        const slice = content.slice(0, MAX_PER_FILE);
        lines.push(`### ${basename}\n${slice}...\n_(full file: ${file})_`);
        totalChars += MAX_PER_FILE;
      }
    } catch {
      lines.push(`- \`${file}\` (unreadable)`);
    }
  }
  return lines.join("\n\n");
}

function buildConnectorContext(connectors: string[]): string {
  const lines: string[] = [`## Available connectors: ${connectors.join(", ")}`];
  lines.push(`You can send messages and interact with external services via the Jimmy gateway API.`);
  lines.push(`Use bash with curl to call these endpoints:\n`);

  for (const name of connectors) {
    lines.push(`### ${name}`);
    lines.push(`- **Send message**: \`curl -X POST http://127.0.0.1:7777/api/connectors/${name}/send -H 'Content-Type: application/json' -d '{"channel":"CHANNEL_ID","text":"message"}'\``);
    lines.push(`- **Send threaded reply**: add \`"thread":"THREAD_TS"\` to the JSON body`);
    lines.push(`- You can proactively send messages without being asked — e.g., to notify about completed tasks, errors, or status updates`);
  }

  lines.push(`\n- **List all connectors**: \`curl http://127.0.0.1:7777/api/connectors\``);
  lines.push(`- Channel IDs and connector config can be found in \`~/.jimmy/config.yaml\``);
  return lines.join("\n");
}

function buildEnvironmentContext(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const lines: string[] = [`## Local environment`];
  let hasContent = false;

  // Scan for known tools/platforms in home directory
  const toolDirs: { dir: string; label: string; description: string }[] = [
    { dir: ".openclaw", label: "OpenClaw", description: "AI agent platform (agents, cron, memory, hooks, credentials)" },
    { dir: ".claude", label: "Claude Code", description: "Claude Code CLI config and projects" },
    { dir: ".codex", label: "Codex", description: "OpenAI Codex CLI config" },
  ];

  for (const tool of toolDirs) {
    const toolPath = path.join(home, tool.dir);
    try {
      const stat = fs.statSync(toolPath);
      if (stat.isDirectory()) {
        const contents = fs.readdirSync(toolPath).filter(f => !f.startsWith("."));
        lines.push(`- **${tool.label}** (\`~/${tool.dir}/\`): ${tool.description}`);
        if (contents.length > 0) {
          lines.push(`  Contents: ${contents.slice(0, 15).join(", ")}${contents.length > 15 ? `, ... (${contents.length} total)` : ""}`);
        }
        hasContent = true;
      }
    } catch {
      // doesn't exist
    }
  }

  // Scan ~/Projects for user's codebases
  const projectsDir = path.join(home, "Projects");
  try {
    const projects = fs.readdirSync(projectsDir).filter(f => {
      try { return fs.statSync(path.join(projectsDir, f)).isDirectory(); } catch { return false; }
    });
    if (projects.length > 0) {
      lines.push(`- **Projects** (\`~/Projects/\`): ${projects.join(", ")}`);
      hasContent = true;
    }
  } catch {
    // no Projects dir
  }

  if (!hasContent) return null;

  lines.push(`\nWhen the user asks about tools or systems on their machine, check these directories first before saying you don't know. Be resourceful — explore the filesystem.`);
  return lines.join("\n");
}

function buildEvolutionContext(): string {
  const profilePath = path.join(JIMMY_HOME, "knowledge", "user-profile.md");
  let profileContent = "";
  try { profileContent = fs.readFileSync(profilePath, "utf-8").trim(); } catch {}

  const isNew = profileContent.length < 50;

  const lines: string[] = [`## Self-evolution`];

  if (isNew) {
    lines.push(`**ONBOARDING MODE**: This is a new or unconfigured Jimmy installation.`);
    lines.push(`Before answering the user's request, introduce yourself briefly and ask them:`);
    lines.push(`1. What's your name and what do you do? (business, role, projects)`);
    lines.push(`2. What should Jimmy help you automate? (code reviews, deployments, monitoring, etc.)`);
    lines.push(`3. Communication preferences — emoji style, verbosity (concise vs detailed), language`);
    lines.push(`4. Any active projects Jimmy should know about?`);
    lines.push(`\nAfter the user responds, write their answers to \`~/.jimmy/knowledge/user-profile.md\` and \`~/.jimmy/knowledge/preferences.md\`.`);
    lines.push(`Then proceed to help with their original request.`);
  } else {
    lines.push(`You learn and evolve over time. When you discover new information about the user, their projects, or their preferences:`);
    lines.push(`- Update \`~/.jimmy/knowledge/user-profile.md\` with business/identity info`);
    lines.push(`- Update \`~/.jimmy/knowledge/preferences.md\` with style/communication preferences`);
    lines.push(`- Update \`~/.jimmy/knowledge/projects.md\` with project details`);
    lines.push(`- If the user gives you persistent feedback (e.g. "always do X", "never do Y"), update \`~/.jimmy/CLAUDE.md\``);
    lines.push(`\nDo this silently — don't announce every file update. Just evolve.`);
  }

  return lines.join("\n");
}

function trimContext(sections: string[]): string {
  let result = sections.join("\n\n");
  if (result.length <= MAX_CONTEXT_CHARS) return result;

  // Progressive trimming: replace non-essential sections with compact summaries
  // Order: environment > knowledge content > skill content > org personas
  const trimmable = [
    { marker: "## Local environment", summary: "## Local environment\nRun `ls ~/` to explore the local filesystem." },
    { marker: "## Knowledge base", summary: "## Knowledge base\nKnowledge files are in `~/.jimmy/knowledge/` and `~/.jimmy/docs/`. Read them directly when needed." },
    { marker: "## Available skills", summary: "## Available skills\nSkills are in `~/.jimmy/skills/`. Read individual SKILL.md files when needed." },
    { marker: "## Organization", summary: "## Organization\nEmployee files are in `~/.jimmy/org/`. Read them directly when needed." },
  ];

  for (const { marker, summary } of trimmable) {
    if (result.length <= MAX_CONTEXT_CHARS) break;
    const idx = sections.findIndex(s => s.startsWith(marker));
    if (idx !== -1) {
      sections[idx] = summary;
      result = sections.join("\n\n");
    }
  }

  return result;
}

function buildDelegationProtocol(config?: JimmyConfig): string {
  const host = config ? `${config.gateway.host || "127.0.0.1"}:${config.gateway.port || 7777}` : "127.0.0.1:7777";

  return `## Employee Delegation Protocol

You are the COO. You NEVER become an employee — you orchestrate them. When the user mentions employees with \`@employee-name\` in their message, or when a task clearly fits an employee's role, you delegate by creating **linked child sessions**.

### How delegation works

1. **Detect**: Spot \`@employee-name\` tags in the user's message, or infer the right employee from context.

2. **Check for existing child sessions FIRST**: Before creating a new session, ALWAYS check if you already have a child session for this employee:

\`\`\`bash
curl -s http://${host}/api/sessions/<your-session-id>/children
\`\`\`

Look for a child with \`"employee": "<employee-name>"\`. If found, REUSE it (skip to step 5). If not found, proceed to step 3.

3. **Brief**: Craft clear, targeted instructions for the employee. Don't just relay the user's words — translate them into actionable briefs with all necessary context.

4. **Spawn**: Create a child session via the gateway API:

\`\`\`bash
curl -s -X POST http://${host}/api/sessions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "prompt": "<your brief for the employee>",
    "employee": "<employee-name>",
    "parentSessionId": "<your-session-id>"
  }'
\`\`\`

The response includes \`{"id": "<child-session-id>", ...}\`. Save this ID.

5. **Send message to existing child session** (when reusing):

\`\`\`bash
curl -s -X POST http://${host}/api/sessions/<child-session-id>/message \\
  -H 'Content-Type: application/json' \\
  -d '{"message": "<follow-up instructions>"}'
\`\`\`

6. **Poll**: Check if the child session is complete:

\`\`\`bash
curl -s http://${host}/api/sessions/<child-session-id>
\`\`\`

Look at the \`status\` field: \`"running"\` means still working, \`"idle"\` means done, \`"error"\` means failed.
When \`"idle"\`, read the \`messages\` array — the last assistant message is the employee's response.

7. **Relay**: Summarize or present the employee's response to the user. Add your own commentary if useful.

### IMPORTANT: Always reuse child sessions

Never create duplicate sessions for the same employee within the same parent. The flow is:
- First time tagging an employee → create child session (step 4)
- Every subsequent time → reuse via \`/children\` lookup (step 2 → step 5)
- This ensures the employee has full conversation context and continuity

### Multiple employees

You can spawn multiple child sessions in parallel (one per employee). Poll each and collect all results before responding to the user.

### Smart delegation

- **Tagged employees**: Always delegate to them.
- **No tags but clear fit**: Proactively suggest or auto-delegate. e.g., "This sounds like a task for @jimmy-dev, let me loop them in."
- **Short tasks** (questions, lookups): Wait for the response, then relay immediately.
- **Long tasks** (coding, research): Tell the user the employee is working on it, then check back.
- **Multiple employees**: Coordinate their work. Spawn sessions in parallel, collect results, synthesize.

### Your session ID

Your current session ID is provided in the "Current session" section above. Use it as \`parentSessionId\` when spawning children and for the \`/children\` lookup.`;
}

function buildApiReference(): string {
  return `## Jimmy Gateway API (http://127.0.0.1:7777)

You can call these endpoints with curl to inspect and manage the gateway:

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/api/status\` | GET | Gateway status, uptime, engine info |
| \`/api/sessions\` | GET | List all sessions |
| \`/api/sessions/:id\` | GET | Session detail (includes messages) |
| \`/api/sessions\` | POST | Create new session (\`{prompt, engine?, employee?, parentSessionId?}\`) |
| \`/api/sessions/:id/message\` | POST | Send follow-up message to existing session (\`{message}\`) |
| \`/api/sessions/:id/children\` | GET | List child sessions of a parent |
| \`/api/cron\` | GET | List cron jobs |
| \`/api/cron/:id\` | PUT | Update cron job (toggle enabled, etc.) |
| \`/api/cron/:id/runs\` | GET | Cron run history |
| \`/api/org\` | GET | Organization structure |
| \`/api/org/employees/:name\` | GET | Employee details |
| \`/api/skills\` | GET | List skills |
| \`/api/skills/:name\` | GET | Skill content |
| \`/api/config\` | GET | Current config |
| \`/api/config\` | PUT | Update config |
| \`/api/connectors\` | GET | List connectors |
| \`/api/connectors/:name/send\` | POST | Send message via connector |
| \`/api/logs\` | GET | Recent log lines |`;
}
