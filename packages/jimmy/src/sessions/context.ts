import fs from "node:fs";
import path from "node:path";
import type { Employee, JinnConfig } from "../shared/types.js";
import { gatewayUrlFromConfig } from "../shared/gateway-url.js";
import { JINN_HOME, ORG_DIR, CRON_JOBS, DOCS_DIR } from "../shared/paths.js";
import { isOperatorSpeaker } from "../shared/operator-match.js";
import { logger } from "../shared/logger.js";
import { scanOrg } from "../gateway/org.js";
import { buildServiceRegistry } from "../gateway/services.js";
import { findJobsNeedingAttention } from "../jobs/state.js";

/**
 * Token budget strategy:
 *
 * Sections are split into three tiers that are assembled in order.
 * If the accumulated prompt exceeds the configurable budget (default 100K chars),
 * lower-tier sections are progressively replaced with compact summaries.
 *
 *   ESSENTIAL  – identity, session, config                (always included)
 *   STANDARD   – org summary, cron summary, connectors,
 *                API ref, evolution, language              (included when budget allows)
 *   OPTIONAL   – knowledge listing, environment scan,
 *                delegation protocol                       (trimmed first when over budget)
 *
 * Knowledge and docs files are NEVER inlined — only filenames are listed.
 * The AI can read files on demand, saving ~200K+ chars per session.
 */

const DEFAULT_MAX_CONTEXT_CHARS = 100_000;

// ── Tier enum for progressive trimming ────────────────────────
const enum Tier {
  ESSENTIAL = 0,
  STANDARD = 1,
  OPTIONAL = 2,
}

interface Section {
  tier: Tier;
  marker: string; // leading text used to identify the section in trimContext
  content: string;
  summary: string; // compact fallback when budget is tight
}

/**
 * Build a rich system prompt for engine sessions.
 * This is what makes Jinn "smart" — the engine sees all of this context
 * before responding to the user.
 */
export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
  connectors?: string[];
  config?: JinnConfig;
  sessionId?: string;
  portalName?: string;
  operatorName?: string;
  language?: string;
  channelName?: string;
  /** Display name of the actual speaker (from Slack users.info, etc.) */
  speakerName?: string;
  /** Speaker's real name (profile real_name) */
  speakerRealName?: string;
  /** Speaker's self-chosen display name */
  speakerDisplayName?: string;
  /** Speaker's legacy handle (users.name) */
  speakerHandle?: string;
  /** Raw connector-native user ID (e.g. Slack U12345) */
  speakerSlackId?: string;
  /** Speaker's Discord user ID (snowflake) */
  speakerDiscordId?: string;
  /** Transport-reported DM flag (Discord has no channel-ID prefix convention) */
  isDM?: boolean;
  /** Transport-reported group-DM flag (Discord GroupDM channels) */
  isGroupDM?: boolean;
  /** Whether the speaker is a bot/integration */
  speakerIsBot?: boolean;
  /** Speaker's IANA timezone */
  speakerTz?: string;
  /**
   * How the engine process for this turn lives. "one-shot" (default): a fresh
   * process is spawned per turn and exits — with its whole process group —
   * when the final answer is delivered. "persistent": an interactive PTY that
   * survives across turns (config.engines.claude.interactive, local only).
   */
  processLifetime?: "one-shot" | "persistent";
  hierarchy?: import("../shared/types.js").OrgHierarchy;
}): string {
  const maxChars = opts.config?.context?.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const sections: Section[] = [];

  // Compute gateway URL once — used by multiple sections.
  // MUST go through gatewayUrlFromConfig: `gateway.host` is a *bind* address, and
  // a wildcard bind (0.0.0.0) is not a connectable target — the host guard would
  // 421 every curl example we bake into this prompt.
  const gatewayUrl = gatewayUrlFromConfig(opts.config);

  // Resolve personalized names from config
  const portalName = opts.portalName || opts.config?.portal?.portalName || "Ryoko";
  const operatorName = opts.operatorName || opts.config?.portal?.operatorName;
  const language = opts.language || opts.config?.portal?.language || "English";
  // Single operator-identity decision for the whole prompt (identity block +
  // session block must agree).
  const { speakerIsOperator, operatorIdVerified } = resolveOperatorIdentity({
    speakerNames: [opts.speakerName, opts.speakerRealName, opts.speakerDisplayName, opts.speakerHandle],
    speakerSlackId: opts.speakerSlackId,
    speakerDiscordId: opts.speakerDiscordId,
    source: opts.source,
    operatorName,
    config: opts.config,
  });

  // ── ESSENTIAL: Identity ─────────────────────────────────────
  if (opts.employee) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildEmployeeIdentity(
        opts.employee,
        portalName,
        language,
        opts.hierarchy?.nodes[opts.employee.name],
        opts.hierarchy,
      ),
      summary: `# You are ${opts.employee.displayName}\nEmployee: ${opts.employee.name}, ${opts.employee.department}, ${opts.employee.rank}`,
    });
  } else {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildIdentity(portalName, operatorName, language, opts.speakerName, speakerIsOperator),
      summary: `# You are ${portalName}\nYour working directory is \`~/.ryoko\` (${JINN_HOME}).`,
    });
  }

  // ── ESSENTIAL: Long-term memory — privacy-gated ─────────────
  // MEMORY.md holds the operator's personal facts. Injected only in web
  // sessions and trusted DMs (see isMemoryEligible); employee and cron
  // sessions never receive it.
  if (!opts.employee) {
    const memoryCtx = buildMemoryContext({
      source: opts.source,
      channel: opts.channel,
      speakerSlackId: opts.speakerSlackId,
      speakerDiscordId: opts.speakerDiscordId,
      isDM: opts.isDM,
      isGroupDM: opts.isGroupDM,
      config: opts.config,
    });
    if (memoryCtx) {
      sections.push({
        tier: Tier.ESSENTIAL,
        marker: "## Long-term memory",
        content: memoryCtx,
        summary: "", // privacy-gated content is never replaced by a summary
      });
    }
  }

  // ── Self-evolution (ESSENTIAL while onboarding is pending, so the
  //    BOOTSTRAP pointer can't be trimmed away on a large workspace) ──
  if (!opts.employee) {
    const onboardingPending = fs.existsSync(path.join(JINN_HOME, "BOOTSTRAP.md"));
    sections.push({
      tier: onboardingPending ? Tier.ESSENTIAL : Tier.STANDARD,
      marker: "## Self-evolution",
      content: buildEvolutionContext(portalName, opts.config),
      summary: `## Self-evolution\nRecord short durable facts in \`${JINN_HOME}/MEMORY.md\` and long-form context in \`${JINN_HOME}/knowledge/<topic>.md\` when you learn new info about the user or their projects.`,
    });
  }

  // ── ESSENTIAL: Session context ──────────────────────────────
  sections.push({
    tier: Tier.ESSENTIAL,
    marker: "## Current session",
    content: buildSessionContext({ ...opts, sessionId: opts.sessionId, operatorName, speakerIsOperator, operatorIdVerified }),
    summary: "", // always included, no trimming
  });

  // ── ESSENTIAL: Process lifetime (background tasks die with the process) ──
  sections.push({
    tier: Tier.ESSENTIAL,
    marker: "## Process lifetime",
    content: buildProcessLifetimeContext(opts.processLifetime !== "persistent", opts.sessionId),
    summary: "", // always included
  });

  // ── ESSENTIAL: Detached jobs whose wake-up never arrived ────
  const jobsCtx = buildDetachedJobsContext(opts.sessionId);
  if (jobsCtx) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Detached jobs needing attention",
      content: jobsCtx,
      summary: "", // always included
    });
  }

  // ── ESSENTIAL: Configuration awareness ──────────────────────
  if (opts.config) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Current configuration",
      content: buildConfigContext(opts.config, gatewayUrl),
      summary: "", // always included
    });
  }

  // ── STANDARD: Organization ──────────────────────────────────
  const orgCtx = buildOrgContext(opts.hierarchy);
  if (orgCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Organization",
      content: orgCtx,
      summary: `## Organization\nEmployee files are in \`${ORG_DIR}/\`. Read them directly when needed.`,
    });
  }

  // ── STANDARD: Available services (for employees only) ────────
  if (opts.employee) {
    const svcCtx = buildServicesContext(opts.employee, gatewayUrl);
    if (svcCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Available services",
        content: svcCtx,
        summary: "## Available services\nUse `ryoko api POST /api/org/cross-request --data '{...}'` to request services from other employees.",
      });
    }
  }

  // ── STANDARD: Cron jobs (only enabled, with disabled count) ─
  const cronCtx = buildCronContext();
  if (cronCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Scheduled cron",
      content: cronCtx,
      summary: `## Scheduled cron jobs\nCron definitions are in \`${CRON_JOBS}\`. Read directly when needed.`,
    });
  }

  // ── OPTIONAL: Knowledge / docs (filenames only, never inlined)
  const knowledgeCtx = buildKnowledgeContext();
  if (knowledgeCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Knowledge base",
      content: knowledgeCtx,
      summary: `## Knowledge base\nKnowledge files are in \`${JINN_HOME}/knowledge/\` and \`${DOCS_DIR}/\`. Read them directly when needed.`,
    });
  }

  // ── STANDARD: Language override for skills ──────────────────
  if (language !== "English") {
    sections.push({
      tier: Tier.STANDARD,
      marker: "When following skill",
      content: `When following skill instructions, always communicate with the user in ${language}, even if the skill contains English examples or dialogue.`,
      summary: `Communicate in ${language}.`,
    });
  }

  // ── STANDARD: Connectors (Slack, etc.) ──────────────────────
  if (opts.connectors && opts.connectors.length > 0) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Available connectors",
      content: buildConnectorContext(opts.connectors, gatewayUrl, portalName),
      summary: `## Available connectors: ${opts.connectors.join(", ")}\nReturn your final answer to reply to the current conversation. Use connector messaging only for different conversations.`,
    });
  }

  // ── OPTIONAL: Local environment ─────────────────────────────
  const envCtx = buildEnvironmentContext();
  if (envCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Local environment",
      content: envCtx,
      summary: "## Local environment\nRun `ls ~/` to explore the local filesystem.",
    });
  }

  // ── OPTIONAL: Delegation protocol (COO only) ───────────────
  if (!opts.employee) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Employee Delegation",
      content: buildDelegationProtocol(gatewayUrl, portalName, opts.config),
      summary: "## Employee Delegation Protocol\nDelegate via `ryoko api POST /api/sessions --data '{...}'`. Check children via `ryoko api GET /api/sessions/:id/children`.",
    });
  }

  // ── STANDARD: Gateway API reference ─────────────────────────
  sections.push({
    tier: Tier.STANDARD,
    marker: `## ${portalName} Gateway API`,
    content: buildApiReference(gatewayUrl, portalName),
    summary: `## ${portalName} Gateway API (${gatewayUrl})\nEndpoints: /api/status, /api/sessions, /api/cron, /api/org, /api/skills, /api/config, /api/connectors, /api/logs`,
  });

  // ── Assemble with progressive trimming by tier ──────────────
  return trimContext(sections, maxChars);
}

// ═══════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════

function buildEmployeeIdentity(
  employee: Employee,
  portalName: string,
  language: string,
  node?: import("../shared/types.js").OrgNode,
  hierarchy?: import("../shared/types.js").OrgHierarchy,
): string {
  const languageInstruction = language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.\n`
    : "";

  const chainOfCommand = buildChainOfCommand(employee, portalName, node, hierarchy);

  return `# You are ${employee.displayName}

You are an AI employee in the ${portalName} gateway system.

## Your persona
${employee.persona}
${languageInstruction}
## Your role
- **Name**: ${employee.name}
- **Display name**: ${employee.displayName}
- **Department**: ${employee.department}
- **Rank**: ${employee.rank}
- **Engine**: ${employee.engine}
- **Model**: ${employee.model}
${chainOfCommand}
## System context
You are part of the ${portalName} AI gateway — a system that orchestrates AI workers. You have access to the filesystem, can run commands, call APIs, and send messages via connectors. Your working directory is \`~/.ryoko\` (${JINN_HOME}).

You can:
- Read and write files in the home directory
- Run shell commands
- Call the gateway API to interact with other parts of the system
- Send messages via connectors (Slack, etc.)
- Access skills, knowledge base, and documentation
- Collaborate with other employees by mentioning them or creating sessions

Be proactive, take initiative, and deliver results. You're not a chatbot — you're a worker.`;
}

function buildChainOfCommand(
  employee: Employee,
  portalName: string,
  node?: import("../shared/types.js").OrgNode,
  hierarchy?: import("../shared/types.js").OrgHierarchy,
): string {
  if (!node || !hierarchy) return "";

  const lines: string[] = ["## Chain of command"];
  lines.push(`- **Department**: ${employee.department}`);

  // Your manager
  if (node.parentName) {
    const parent = hierarchy.nodes[node.parentName];
    if (parent) {
      lines.push(`- **Your manager**: ${parent.employee.displayName} (${parent.employee.rank})`);
    } else {
      lines.push(`- **Your manager**: ${node.parentName}`);
    }
  } else {
    lines.push(`- **Your manager**: ${portalName} (COO)`);
  }

  // Direct reports
  if (node.directReports.length > 0) {
    const reports = node.directReports.map((name) => {
      const r = hierarchy.nodes[name];
      return r ? `${r.employee.displayName} (${r.employee.rank})` : name;
    });
    lines.push(`- **Your direct reports**: ${reports.join(", ")}`);
  }

  // Escalation path
  const escalation: string[] = [];
  let current = node.parentName;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const mgr = hierarchy.nodes[current];
    escalation.push(mgr ? mgr.employee.displayName : current);
    current = mgr?.parentName ?? null;
  }
  escalation.push(`${portalName} (COO)`);
  const unique = [...new Set(escalation)];
  lines.push(`- **Escalation path**: ${unique.join(" → ")}`);

  return "\n" + lines.join("\n") + "\n";
}

function buildServicesContext(employee: Employee, _gatewayUrl: string): string | null {
  try {
    const registry = scanOrg();
    const services = buildServiceRegistry(registry);
    if (services.size === 0) return null;

    const lines: string[] = ["## Available services"];
    lines.push("Other employees provide the following services. To request one, use the cross-request API:");
    lines.push(`\`ryoko api POST /api/org/cross-request --data '{"fromEmployee": "${employee.name}", "service": "<name>", "prompt": "<what you need>"}'\``);
    lines.push("");

    for (const [svcName, entry] of services) {
      // Skip services from own department
      if (entry.provider.department === employee.department) continue;
      lines.push(`- **${svcName}** — ${entry.declaration.description} (provided by ${entry.provider.displayName}, ${entry.provider.department})`);
    }

    // If no external services remain after filtering, skip
    if (lines.length <= 4) return null;

    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildIdentity(
  portalName: string,
  operatorName?: string,
  language?: string,
  speakerName?: string,
  speakerIsOperator = false,
): string {
  const operatorLine = operatorName
    ? speakerIsOperator || !speakerName
      ? `\nYour operator (the person who runs this Jinn instance) is **${operatorName}**. Address them by name when appropriate.`
      : `\nYour operator (the person who runs this Jinn instance) is **${operatorName}** — but the current speaker is someone else.\nAlways identify the person you are addressing via \`## Current session → Speaker\`. Never call the current speaker "${operatorName}" unless confirmed — that name belongs to the operator, not to every person you talk to.`
    : "";

  const languageInstruction = language && language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.`
    : "";

  return `# You are ${portalName}

${portalName} is a personal AI assistant and gateway daemon. You are proactive, helpful, and opinionated — not a passive tool. You anticipate needs, suggest improvements, and take initiative when appropriate.${operatorLine}

## Core principles
- **Be proactive**: Don't just answer questions — suggest next steps, flag issues, offer to do related tasks.
- **Be concise**: Respect the user's time. Lead with the answer, not the reasoning.
- **Be capable**: You have access to the filesystem, can run commands, call APIs, send messages via connectors, and manage the system.
- **Be honest**: If you don't know something or can't do something, say so clearly.
- **Remember context**: You're part of a persistent system. Sessions can be resumed. Build on previous work.
${languageInstruction}
## Your home directory
Your working directory is \`~/.ryoko\` (${JINN_HOME}). This contains:
- \`config.yaml\` — your configuration (engines, connectors, logging)
- \`IDENTITY.md\` / \`SOUL.md\` — who you are and how you behave
- \`MEMORY.md\` — long-term memory: short durable facts, preferences, decisions
- \`TOOLS.md\` — tool usage notes and gotchas
- \`org/\` — employee definitions (YAML files defining AI workers)
- \`skills/\` — reusable skill prompts
- \`docs/\` — documentation and knowledge base
- \`knowledge/\` — long-form reference memory, one topic per file
- \`memory/\` — daily notes (\`YYYY-MM-DD.md\`)
- \`cron/\` — scheduled job definitions and run history
- \`sessions/\` — session database
- \`logs/\` — gateway logs
- \`CLAUDE.md\` — user-defined instructions (always follow these)
- \`AGENTS.md\` — agent/employee documentation

You can read, write, and modify any of these files to configure yourself, create new employees, add skills, etc.`;
}

function buildSessionContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  sessionId?: string;
  channelName?: string;
  speakerName?: string;
  speakerRealName?: string;
  speakerDisplayName?: string;
  speakerHandle?: string;
  speakerSlackId?: string;
  speakerDiscordId?: string;
  speakerIsBot?: boolean;
  speakerTz?: string;
  operatorName?: string;
  speakerIsOperator?: boolean;
  operatorIdVerified?: boolean;
}): string {
  let ctx = `## Current session\n`;
  if (opts.sessionId) ctx += `- Session ID: ${opts.sessionId}\n`;
  ctx += `- Source: ${opts.source}\n`;
  if (opts.channelName) {
    ctx += `- Channel: #${opts.channelName} (${opts.channel})\n`;
  } else if (opts.source === "slack" && opts.channel.startsWith("D")) {
    ctx += `- Channel: Direct Message (${opts.channel})\n`;
  } else {
    ctx += `- Channel: ${opts.channel}\n`;
  }
  if (opts.thread) ctx += `- Thread: ${opts.thread}\n`;

  if (opts.speakerName) {
    const aliasParts: string[] = [];
    if (opts.speakerRealName && opts.speakerRealName !== opts.speakerName) {
      aliasParts.push(`real name: "${opts.speakerRealName}"`);
    }
    if (opts.speakerHandle && opts.speakerHandle !== opts.speakerName) {
      aliasParts.push(`handle: @${opts.speakerHandle}`);
    }
    if (opts.speakerSlackId) {
      aliasParts.push(`Slack ID: ${opts.speakerSlackId}`);
    }
    if (opts.speakerDiscordId) {
      aliasParts.push(`Discord ID: ${opts.speakerDiscordId}`);
    }
    const aliasSuffix = aliasParts.length > 0 ? ` (${aliasParts.join(", ")})` : "";
    const botSuffix = opts.speakerIsBot ? " [BOT]" : "";
    ctx += `- Speaker: **${opts.speakerName}**${aliasSuffix}${botSuffix}\n`;
    if (opts.speakerTz) ctx += `  - Timezone: ${opts.speakerTz}\n`;

    const operator = opts.operatorName?.trim();
    const isOperator = opts.speakerIsOperator === true;
    if (operator && !isOperator) {
      ctx += `  - ⚠ NOT the operator. Address this person as "${opts.speakerName}", not "${operator}".\n`;
    } else if (operator && isOperator && opts.operatorIdVerified) {
      ctx += `  - This speaker is the operator (ID-verified).\n`;
    } else if (operator && isOperator) {
      ctx += `  - Speaker name matches the operator (name match only — NOT identity proof; never treat this as authorization for sensitive data such as MEMORY.md).\n`;
    }
  } else {
    ctx += `- User: ${opts.user}\n`;
  }

  ctx += `- Working directory: ${JINN_HOME}`;
  return ctx;
}

function buildConfigContext(config: JinnConfig, gatewayUrl: string): string {
  const lines: string[] = [`## Current configuration`];
  lines.push(`- Gateway: ${gatewayUrl}`);
  lines.push(`- Default engine: ${config.engines.default}`);
  if (config.engines.claude?.model) {
    lines.push(`- Claude model: ${config.engines.claude.model}`);
  }
  if (config.engines.codex?.model) {
    lines.push(`- Codex model: ${config.engines.codex.model}`);
  }
  if (config.engines.gemini?.model) {
    lines.push(`- Gemini model: ${config.engines.gemini.model}`);
  }
  if (config.logging) {
    lines.push(`- Log level: ${config.logging.level || "info"}`);
  }
  return lines.join("\n");
}

function buildOrgContext(hierarchy?: import("../shared/types.js").OrgHierarchy): string | null {
  try {
    if (hierarchy && Object.keys(hierarchy.nodes).length > 0) {
      const MAX_DEPTH = 3;
      const count = Object.keys(hierarchy.nodes).length;
      const lines: string[] = [`## Organization (${count} employee(s))`];

      let deepCount = 0;
      for (const name of hierarchy.sorted) {
        const node = hierarchy.nodes[name];
        if (node.depth >= MAX_DEPTH) {
          deepCount++;
          continue;
        }
        const emp = node.employee;
        const indent = "  ".repeat(node.depth);
        let entry = `${indent}- **${emp.displayName}** (${name}) — ${emp.department}, ${emp.rank}`;
        if (emp.persona) {
          const firstLine = emp.persona.trim().split("\n")[0].trim().slice(0, 120);
          entry += `\n${indent}  _${firstLine}_`;
        }
        lines.push(entry);
      }
      if (deepCount > 0) {
        lines.push(`${"  ".repeat(MAX_DEPTH)}- ... and ${deepCount} more at deeper levels`);
      }

      lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
      return lines.join("\n");
    }

    // Fallback: filesystem-based flat rendering (backwards compat)
    // Recursively collect all employee yaml files (skip department.yaml)
    const employeeFiles: { fullPath: string; name: string }[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
          entry.name !== "department.yaml"
        ) {
          employeeFiles.push({ fullPath, name: entry.name.replace(/\.ya?ml$/, "") });
        }
      }
    }

    scanDir(ORG_DIR);
    if (employeeFiles.length === 0) return null;

    const lines: string[] = [`## Organization (${employeeFiles.length} employee(s))`];
    for (const { fullPath, name } of employeeFiles) {
      const content = fs.readFileSync(fullPath, "utf-8");
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

/**
 * Cron context: shows only enabled jobs inline, with a count of disabled jobs.
 * Previously listed all 77+ jobs; now only active ones are shown to save tokens.
 */
function buildCronContext(): string | null {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const enabled = jobs.filter((j: any) => j.enabled !== false);
    const disabledCount = jobs.length - enabled.length;

    const lines: string[] = [`## Scheduled cron jobs (${enabled.length} active, ${disabledCount} disabled)`];
    for (const job of enabled) {
      lines.push(`- **${job.name}**: \`${job.schedule}\`${job.employee ? ` → ${job.employee}` : ""}`);
    }
    if (disabledCount > 0) {
      lines.push(`\n_${disabledCount} disabled jobs not shown. See \`${CRON_JOBS}\` for the full list._`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Knowledge context: lists filenames and sizes only — never inlines content.
 * The AI reads files on demand. This saves ~200K+ chars compared to full inlining.
 */
function buildKnowledgeContext(): string | null {
  const dirs = [
    { dir: DOCS_DIR, label: "docs" },
    { dir: path.join(JINN_HOME, "knowledge"), label: "knowledge" },
  ];
  const entries: { name: string; dir: string; sizeKb: string }[] = [];

  for (const { dir, label } of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f =>
        f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"),
      );
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(dir, f));
          entries.push({
            name: f,
            dir: label,
            sizeKb: (stat.size / 1024).toFixed(1),
          });
        } catch {
          entries.push({ name: f, dir: label, sizeKb: "?" });
        }
      }
    } catch {
      // dir doesn't exist
    }
  }

  if (entries.length === 0) return null;

  const lines: string[] = [
    `## Knowledge base`,
    `Knowledge files are in \`${JINN_HOME}/knowledge/\` and \`${DOCS_DIR}/\`. Read them directly when needed.`,
    ``,
  ];

  // Group by directory
  for (const label of ["docs", "knowledge"]) {
    const group = entries.filter(e => e.dir === label);
    if (group.length === 0) continue;
    lines.push(`**${label}/** (${group.length} files):`);
    for (const e of group) {
      lines.push(`- \`${e.name}\` (${e.sizeKb} KB)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildProcessLifetimeContext(oneShot: boolean, sessionId?: string): string {
  const sid = sessionId || "<SESSION_ID from Current session>";
  const jobRunner = [
    `- For a job that must outlive the turn, use the self-waking job runner — FIRST choice, do not hand-roll detach + polling:`,
    `  \`ryoko job run --name <job> --session ${sid} -- '<command>'\``,
    `  It detaches the job (survives turn end, engine kills and gateway restarts), logs to \`~/.ryoko/jobs/logs/\`, and when the job exits — success OR failure — it wakes THIS session with the exit code and the log tail. Add \`--timeout <sec>\` to bound runaway jobs (you still get woken).`,
    `- When a job notification wakes you: finish the deferred work (assemble, upload, …) and reply to the ORIGINAL conversation — it is still waiting on you. On failure, recover or tell the user; never leave the thread silent.`,
    `- Only if \`ryoko job run\` is unavailable, fall back to manual detach (\`setsid nohup <cmd> > /tmp/<job>.log 2>&1 &\` on Linux; \`nohup … &\` + \`disown\` on macOS which has no \`setsid\`) or a cron job (gateway \`/api/cron\`). With manual detach you will NOT be woken when it finishes — you must arrange the follow-up yourself.`,
    `- Verify BEFORE reporting done: read the logfile and check the expected artifact (uploaded file, build output, etc.). If the logfile is missing or incomplete, say so — never claim completion you have not verified.`,
  ];

  if (!oneShot) {
    return [
      `## Process lifetime`,
      `This session runs in a persistent interactive process: background tasks survive across turns, but they are killed when the session ends, times out, or the gateway restarts.`,
      ``,
      `- For a job that must survive session shutdown, prefer the self-waking job runner below over a plain background task.`,
      ...jobRunner,
    ].join("\n");
  }

  return [
    `## Process lifetime (background tasks die when your turn ends)`,
    `Your process is one-shot: it is spawned for this turn and exits as soon as you deliver your final answer. Anything you started in the background (\`&\`, run_in_background Bash tasks) lives in the SAME process group and dies with it — silently, with no error and no notification.`,
    ``,
    `- NEVER start a plain background job and reply "I'll report back when it's done" — the job dies the moment your turn ends, and nobody is told. This is different from an interactive CLI, where the CLI outlives the turn.`,
    `- If a job fits within this turn, run it in the FOREGROUND and wait for it to finish before answering.`,
    ...jobRunner,
  ].join("\n");
}

/**
 * Detached jobs whose wake-up never arrived: the notification failed after
 * retries (gateway was down) or the monitor died (reboot, kill -9). Surfacing
 * them here guarantees "the next turn detects it" — a finished job can be
 * delayed, but never silently lost (issue #38 follow-up).
 */
export function buildDetachedJobsContext(sessionId?: string, jobsDir?: string): string | null {
  // Strictly scoped to THIS session's own jobs: another customer's job names,
  // log paths and session ids must never leak into this prompt.
  if (!sessionId) return null;
  let attention: import("../jobs/state.js").JobAttention[];
  try {
    attention = findJobsNeedingAttention(jobsDir).filter((a) => a.state.sessionId === sessionId);
  } catch {
    return null;
  }
  if (attention.length === 0) return null;

  // Job names/paths come from earlier agent turns; keep them inert in the
  // prompt (no backticks/newlines that could break out of the list format).
  const inert = (s: string) => s.replace(/[`\r\n]+/g, " ").slice(0, 200);

  const lines = [
    `## Detached jobs needing attention`,
    `These detached jobs OF THIS SESSION finished (or their monitor died) but their wake-up notification never arrived. Handle them FIRST — the conversation that started them may still be waiting:`,
  ];
  for (const { kind, state } of attention) {
    const outcome = kind === "orphaned"
      ? "monitor died while running"
      : state.timedOut
        ? `timed out after ${state.timeoutSec}s`
        : `exit ${state.exitCode ?? "?"}`;
    lines.push(`- \`${state.id}\` (${inert(state.name)}) — ${outcome}; log: \`${inert(state.logFile)}\``);
  }
  lines.push(`Read each log, complete or recover the deferred work, then delete the job's state file under \`~/.ryoko/jobs/\` so this list clears.`);
  return lines.join("\n");
}

function buildConnectorContext(connectors: string[], _gatewayUrl: string, portalName: string): string {
  const lines: string[] = [`## Available connectors: ${connectors.join(", ")}`];
  lines.push(`You can send messages and interact with external services via the ${portalName} gateway API.`);
  lines.push("Use connector messaging only for proactive messages to a different channel or conversation.\n");

  for (const name of connectors) {
    lines.push(`### ${name}`);
    lines.push("- **Send message**: use the `send_message` tool or `/api/connectors/:name/send` only for a channel/conversation other than the one that triggered this session");
    lines.push("- **Send threaded message**: include `thread` only when targeting a different existing thread");
    lines.push("- Good uses: notifying another channel about completed tasks, errors, or status updates");
  }

  lines.push("");
  lines.push("### Replying to the current conversation");
  lines.push("- The text you return as your final answer is delivered to the current conversation/thread. Treat it as PUBLIC to the current speaker and channel.");
  lines.push("- Do not call `/send`, `curl`, or the `send_message` tool for the current conversation. That creates duplicate or meta replies.");
  lines.push("- Your final answer is shown verbatim, so make it the actual reply — NOT work narration, status reports to the operator, or internal deliberation.");
  lines.push("- Never put operator notes, file IDs, internal drafts, approval waits (\"GO待ち\"), or instructions meant for another audience in the public body — especially in externally-shared channels.");
  lines.push("- To keep an operator-only note out of the channel, append a trailer whose LAST non-empty line is exactly this (base64url-encoded JSON):");
  lines.push("  `<!--RYOKO-DISPOSITION:v1:<base64url of {\"internal\":\"...\",\"react\":\":emoji:\",\"suppressPublic\":false}>-->`");
  lines.push("  The `internal` field is never posted publicly (saved for the operator). `react` makes the public reply a single emoji reaction; `suppressPublic` omits the public body.");
  lines.push("- When you are directly addressed (mentioned / asked), ALWAYS give a non-empty public reply. Use react-only for pure acknowledgments or social confirmations — never as the answer to a substantive question.");

  lines.push("\n- **List all connectors**: `ryoko api GET /api/connectors`");
  lines.push(`- Channel IDs and connector config can be found in \`${JINN_HOME}/config.yaml\``);
  return lines.join("\n");
}

function buildEnvironmentContext(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const lines: string[] = [`## Local environment`];
  let hasContent = false;

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

/** Warn once per config key, not once per session build. */
const warnedIdentityConfig = new Set<string>();

/** Read a configured platform user ID, accepting STRINGS ONLY. Discord
 *  snowflakes exceed Number.MAX_SAFE_INTEGER, so an unquoted YAML value has
 *  already lost precision by parse time — comparing the mangled value could
 *  match the WRONG user. A numeric value is ignored (it can never match)
 *  with a one-time warning telling the operator to quote it. */
function configuredIdString(value: unknown, label: string): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && !warnedIdentityConfig.has(label)) {
    warnedIdentityConfig.add(label);
    logger.warn(
      `[identity] ${label} is a YAML number — IDs this long lose precision before we ever see them. Quote the value ("...") in config.yaml; until then it is ignored and can never match.`,
    );
  }
  return undefined;
}

/** trustedSpeakers entries, STRINGS ONLY (same precision hazard as above). */
function trustedSpeakerIds(config?: JinnConfig): string[] {
  const raw = config?.portal?.trustedSpeakers ?? [];
  const strings = raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (strings.length < raw.length && !warnedIdentityConfig.has("portal.trustedSpeakers")) {
    warnedIdentityConfig.add("portal.trustedSpeakers");
    logger.warn(
      `[identity] portal.trustedSpeakers contains non-string entries — unquoted Discord snowflakes lose precision as YAML numbers. Quote each ID; non-string entries are ignored.`,
    );
  }
  return strings;
}

/** Operator identification. When portal.operatorSlackId and/or
 *  portal.operatorDiscordId is configured, identification is strict ID
 *  equality, bound to the platform the speaker actually came from (`source`)
 *  — display names are freely editable and must never establish operator
 *  identity on their own, and a Slack ID smuggled into a Discord payload
 *  must not count either. A speaker from a platform with no configured
 *  operator ID is then simply not the operator (fail closed; configure the
 *  missing platform's ID rather than relying on names). Without any
 *  configured ID we fall back to alias/name matching (kept for addressing
 *  UX), and the session block phrases that as an UNVERIFIED name match. */
export function resolveOperatorIdentity(opts: {
  speakerNames: Array<string | undefined>;
  speakerSlackId?: string;
  speakerDiscordId?: string;
  /** Where the message physically arrived ("slack" | "discord" | …). When
   *  given, only that platform's operator ID can verify the speaker. */
  source?: string;
  operatorName?: string;
  config?: JinnConfig;
}): { speakerIsOperator: boolean; operatorIdVerified: boolean } {
  const rawSlackId = opts.config?.portal?.operatorSlackId;
  const rawDiscordId = opts.config?.portal?.operatorDiscordId;
  const operatorSlackId = configuredIdString(rawSlackId, "portal.operatorSlackId");
  const operatorDiscordId = configuredIdString(rawDiscordId, "portal.operatorDiscordId");
  // The PRESENCE of a strict ID engages strict mode, even when the value is
  // unusable (numeric) — degrading to name matching on a config mistake
  // would reopen exactly the spoofing hole strict mode exists to close.
  if (rawSlackId != null || rawDiscordId != null) {
    const slackApplies = opts.source === undefined || opts.source === "slack";
    const discordApplies = opts.source === undefined || opts.source === "discord";
    const verified =
      (slackApplies &&
        !!operatorSlackId &&
        !!opts.speakerSlackId &&
        opts.speakerSlackId === operatorSlackId) ||
      (discordApplies &&
        !!operatorDiscordId &&
        !!opts.speakerDiscordId &&
        opts.speakerDiscordId === operatorDiscordId);
    return { speakerIsOperator: verified, operatorIdVerified: verified };
  }
  return {
    speakerIsOperator: isOperatorSpeaker(
      opts.speakerNames,
      opts.operatorName,
      opts.config?.portal?.operatorAliases,
    ),
    operatorIdVerified: false,
  };
}

/** Privacy gate for MEMORY.md injection.
 *
 *  Eligible: authenticated web-UI sessions, and Slack / Discord DIRECT
 *  MESSAGES whose speaker's platform ID is listed in portal.trustedSpeakers
 *  (the operator lists their own IDs there too).
 *
 *  Deliberately NOT eligible:
 *  - Shared channels, even for trusted speakers — the engine session is
 *    reused per thread, so injected memory would linger in history that later
 *    untrusted participants build on.
 *  - Display-name/handle operator matching — names are freely editable, so
 *    they must never open a privacy gate. Only immutable platform IDs count.
 *  - Employee and cron sessions (no trusted human speaker present). */
export function isMemoryEligible(opts: {
  source: string;
  channel?: string;
  speakerSlackId?: string;
  speakerDiscordId?: string;
  /** Transport-reported DM flag (Discord has no channel-ID prefix convention). */
  isDM?: boolean;
  /** Transport-reported group-DM flag. */
  isGroupDM?: boolean;
  config?: JinnConfig;
}): boolean {
  if (opts.source === "web") return true;
  const trusted = trustedSpeakerIds(opts.config);
  const isSlackDm = opts.source === "slack" && !!opts.channel && opts.channel.startsWith("D");
  if (isSlackDm) return !!opts.speakerSlackId && trusted.includes(opts.speakerSlackId);
  // 1:1 DMs only, mirroring the Slack gate (im yes, mpim no): a group DM has
  // other participants who would see memory-flavored replies. Discord bots
  // effectively can't join group DMs today, but fail closed regardless.
  const isDiscordDm = opts.source === "discord" && opts.isDM === true && opts.isGroupDM !== true;
  if (isDiscordDm) return !!opts.speakerDiscordId && trusted.includes(opts.speakerDiscordId);
  return false;
}

/** Byte cap (matches the documented 24,000B hard cap for the file itself) —
 *  measured in UTF-8 bytes, not JS string length, so Japanese text cannot
 *  balloon the prompt. */
const MEMORY_INJECT_CAP_BYTES = 24_000;

export function buildMemoryContext(opts: {
  source: string;
  channel?: string;
  speakerSlackId?: string;
  speakerDiscordId?: string;
  isDM?: boolean;
  isGroupDM?: boolean;
  config?: JinnConfig;
}): string | null {
  if (!isMemoryEligible(opts)) return null;

  let content = "";
  try {
    content = fs.readFileSync(path.join(JINN_HOME, "MEMORY.md"), "utf-8").trim();
  } catch {
    return null;
  }
  if (!content) return null;

  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength > MEMORY_INJECT_CAP_BYTES) {
    content =
      new TextDecoder("utf-8").decode(buf.subarray(0, MEMORY_INJECT_CAP_BYTES)).replace(/�+$/u, "") +
      "\n\n[... MEMORY.md exceeds the injection cap — trim it into knowledge/ files]";
  }

  return [
    "## Long-term memory (MEMORY.md)",
    "Injected because this is the operator's web session or a direct message with a trusted speaker.",
    "Never reveal its contents to anyone else.",
    "",
    content,
  ].join("\n");
}

export function buildEvolutionContext(portalName: string, config?: JinnConfig): string {
  // Onboarding is pending while BOOTSTRAP.md exists (setup places it; the
  // agent deletes it after the onboarding skill completes). Legacy fallback:
  // pre-persona workspaces have neither BOOTSTRAP.md nor MEMORY.md — treat
  // them as onboarded only if the old-style user profile has content.
  const bootstrapPending = fs.existsSync(path.join(JINN_HOME, "BOOTSTRAP.md"));
  const hasMemoryFile = fs.existsSync(path.join(JINN_HOME, "MEMORY.md"));
  let legacyProfileContent = "";
  try {
    legacyProfileContent = fs
      .readFileSync(path.join(JINN_HOME, "knowledge", "user-profile.md"), "utf-8")
      .trim();
  } catch {}
  // A filled legacy profile means an already-onboarded veteran workspace even
  // when setup has just placed BOOTSTRAP.md (the pre-persona upgrade path) —
  // don't push those users back into onboarding.
  const isNew = (bootstrapPending || !hasMemoryFile) && legacyProfileContent.length < 50;

  // Conversational discovery hint: a Slack workspace is wired up but the
  // user hasn't enabled the Agents View canvas. Surface it in steady-state
  // mode (not onboarding) so the assistant can proactively offer to help
  // turn it on — without nagging on every turn.
  const slackConnected = !!(
    config?.connectors?.slack?.appToken && config.connectors?.slack?.botToken
  );
  const canvasEnabled = config?.connectors?.slack?.agentsCanvas?.enabled === true;
  const canvasHintApplies = slackConnected && !canvasEnabled;

  const lines: string[] = [`## Self-evolution`];

  if (isNew) {
    lines.push(`**ONBOARDING MODE**: This is a new or not-yet-onboarded ${portalName} installation.`);
    if (bootstrapPending) {
      lines.push(`Before answering the user's request, read \`${JINN_HOME}/BOOTSTRAP.md\` and follow it to completion — it walks you through the onboarding skill (filling IDENTITY.md / SOUL.md / MEMORY.md) and is deleted when done.`);
    } else {
      lines.push(`Before answering the user's request, introduce yourself briefly and ask who they are, what ${portalName} should help with, their communication preferences, and any active projects.`);
      lines.push(`Write short durable facts, preferences, and decisions to \`${JINN_HOME}/MEMORY.md\`; put long-form context in \`${JINN_HOME}/knowledge/<topic>.md\`.`);
    }
    lines.push(`Then proceed to help with their original request.`);
    if (canvasHintApplies) {
      lines.push(
        `\nIf the conversation goes well and Slack is set up, you may also mention that you can mirror all your running sessions to a Slack canvas (the "Agents View Canvas") — but only once, briefly, and only if it feels natural.`,
      );
    }
  } else {
    lines.push(`You learn and evolve over time. Memory is two-layered — keep the layers separate:`);
    lines.push(`- Short durable facts, preferences, and decisions (1-3 lines each) → \`${JINN_HOME}/MEMORY.md\` (read every session; keep it lean)`);
    lines.push(`- Long-form context (research results, project background, org info) → \`${JINN_HOME}/knowledge/<topic>.md\` (fetched on demand)`);
    lines.push(`- Personality / tone feedback → \`${JINN_HOME}/SOUL.md\`; name or self-image changes → \`${JINN_HOME}/IDENTITY.md\``);
    lines.push(`\nDo this silently — don't announce every file update. Just evolve.`);
    if (canvasHintApplies) {
      lines.push(
        `\n### Available feature the user hasn't enabled: Agents View Canvas`,
      );
      lines.push(
        `Slack is connected but \`slack.agentsCanvas.enabled\` is off in config.yaml. The Agents View Canvas mirrors every running ${portalName} session to a Slack canvas — running / waiting / errored / idle, updated every 30 seconds.`,
      );
      lines.push(
        `**Do NOT proactively pitch this on every turn.** Only suggest it when ALL of these hold:`,
      );
      lines.push(
        `- The user just asked something that benefits from seeing live session state (e.g. "what is Ryoko doing right now?", "I want a dashboard of your work", "is there a way to see all the agents?")`,
      );
      lines.push(
        `- OR the user just successfully connected Slack and is exploring what to do next.`,
      );
      lines.push(
        `When you do bring it up, keep it to one sentence and point them to **Settings → Slack → Agents View Canvas** in the Web UI. The user can also delegate the toggling to you (Bash tool: \`ryoko api PUT /api/config --data '{...}'\`) if they ask.`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Delegation protocol: condensed version focusing on the essential API patterns.
 * Verbose examples and multi-paragraph explanations have been trimmed.
 */
function buildDelegationProtocol(_gatewayUrl: string, _portalName: string, config?: JinnConfig): string {
  const defaultEngine = config?.engines.default || "claude";
  const engineConfig = defaultEngine === "codex"
    ? config?.engines.codex
    : defaultEngine === "gemini"
      ? config?.engines.gemini ?? config?.engines.claude
      : config?.engines.claude;
  const childOverride = engineConfig?.childEffortOverride;

  const effortOverrideNote = childOverride
    ? `\n> **Note**: \`childEffortOverride\` is set to \`"${childOverride}"\`. All child sessions use this effort level.`
    : "";

  return `## Employee Delegation Protocol

You are the COO. You orchestrate employees by creating **linked child sessions**.

### How delegation works

1. **Detect**: Spot \`@employee-name\` tags or infer the right employee from context.

2. **Check for existing children first**:
\`\`\`bash
ryoko api GET /api/sessions/<your-session-id>/children
\`\`\`
If a child exists for this employee, reuse it (skip to step 5).

3. **Brief**: Craft clear, targeted instructions — translate user words into actionable briefs.

4. **Spawn**:
\`\`\`bash
ryoko api POST /api/sessions \\
  --data '{"prompt": "<brief>", "employee": "<name>", "parentSessionId": "<your-session-id>"}'
\`\`\`

5. **Follow up** (existing child):
\`\`\`bash
ryoko api POST /api/sessions/<child-id>/message \\
  --data '{"message": "<follow-up>"}'
\`\`\`

6. **Respond immediately**: tell the user you have delegated and will follow up when the child reports back, then end your turn. **Do NOT poll or sleep-loop inside your turn** waiting for the child — a turn has a hard time limit, and a blocked turn cannot answer anyone.

7. **onComplete notification** (the primary wake-up — attempted, not guaranteed): when the child finishes, the gateway posts a notification into your session and you are woken with a preview and the child's session id. The notification is skipped silently when any of these hold:
   - the child was spawned without your \`parentSessionId\` (an unlinked child never notifies anyone)
   - the employee sets \`alwaysNotify: false\`
   - your session is already in \`error\`
   If the POST itself fails (gateway restart, auth), a warning goes to the gateway log — not to you.

8. **Safety net**: if the user asks about progress, or a reply is overdue, read the child yourself:
\`\`\`bash
ryoko api GET /api/sessions/<child-id>?last=5
\`\`\`
For a delegation that must not stall unnoticed, arm a watchdog. The job runner guarantees a wake-up on exit (success or failure), so you are woken on the deadline at the latest:
\`\`\`bash
ryoko job run --name watchdog-<employee> --session <your-session-id> -- 'sleep 1800'
\`\`\`
When the watchdog wakes you, check the child: if you already relayed its result, nothing more is needed — otherwise relay it, or tell the user what is still pending.

9. **Review**: when the notification (or the watchdog) wakes you, read the child's messages and assess the work using oversight levels (TRUST / VERIFY / THOROUGH) based on complexity and risk, then relay the result to the user.

### Key rules
- **Always pass \`parentSessionId\`** when spawning. Without it the child is unlinked and no notification is even attempted.
- **Never poll or sleep-loop inside your turn** waiting for a child. Reply, end your turn, and let the notification wake you.
- **The notification is not a guarantee** (step 7). If you have not heard back when the user asks, read the child yourself; for a hard deadline, arm the watchdog.
- **Always reuse** child sessions — never create duplicates for the same employee.
- **Parallel spawning**: For independent sub-tasks, spawn multiple employees simultaneously.
- **Cross-reference**: Compare results from multiple employees before responding.
- **Effort levels**: Include \`"effortLevel"\` in the API body: \`"low"\` (lookups), \`"medium"\` (routine), \`"high"\` (code/architecture).

### Oversight Levels

| Level | When | You do |
|-------|------|--------|
| **TRUST** | Simple lookups, status checks | Skim, relay directly |
| **VERIFY** | Code changes, routine work | Read fully, spot-check key files |
| **THOROUGH** | Architecture, breaking changes, security | Full review, multi-turn follow-up, verify changes |

### Manager Delegation

When a department has 3+ employees, promote a senior to **manager**. Managers handle their own delegation; you review their summaries, not individual work.

### Your session ID

Your current session ID is in the "Current session" section above. Use it as \`parentSessionId\`.${effortOverrideNote}`;
}

function buildApiReference(gatewayUrl: string, portalName: string): string {
  return `## ${portalName} Gateway API (${gatewayUrl})

Use \`ryoko api GET /api/status\` (or \`POST ... --data '{...}'\`) for local API calls.
It chooses a connectable loopback URL, adds the instance's bearer token, refuses external URLs,
and reports non-2xx responses instead of failing silently. For tools that cannot invoke the CLI,
the connectable URL is exported as \`$RYOKO_GATEWAY_URL\`; those callers must still add the bearer
token. Never turn the bind address from config (\`gateway.host\`) into a URL: a wildcard bind like
\`0.0.0.0\` is not a client destination and the gateway answers \`421 host_not_allowed\`.

You can call these endpoints with \`ryoko api\` to inspect and manage the gateway:

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
| \`/api/connectors/:name/send\` | POST | Proactively send to a different connector conversation; never use it to reply to the current conversation |
| \`/api/logs\` | GET | Recent log lines |`;
}

/**
 * Progressive trimming by tier: OPTIONAL sections are replaced with summaries first,
 * then STANDARD, then (as a last resort) ESSENTIAL sections.
 */
function trimContext(sections: Section[], maxChars: number): string {
  let parts = sections.map(s => s.content);
  let result = parts.join("\n\n");
  if (result.length <= maxChars) return result;

  // Trim OPTIONAL sections first, then STANDARD
  for (const tier of [Tier.OPTIONAL, Tier.STANDARD]) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (result.length <= maxChars) break;
      if (sections[i].tier === tier && sections[i].summary) {
        parts[i] = sections[i].summary;
        result = parts.join("\n\n");
      }
    }
  }

  return result;
}
