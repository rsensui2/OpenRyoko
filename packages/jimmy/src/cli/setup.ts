import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import {
  JIMMY_HOME,
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  TMP_DIR,
  TEMPLATE_DIR,
  LOGS_DIR,
  DOCS_DIR,
  SKILLS_DIR,
  ORG_DIR,
  CLAUDE_SKILLS_DIR,
  AGENTS_SKILLS_DIR,
} from "../shared/paths.js";
import { initDb } from "../sessions/registry.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function ok(msg: string) {
  console.log(`  ${GREEN}[ok]${RESET} ${msg}`);
}

function warn(msg: string) {
  console.log(`  ${YELLOW}[warn]${RESET} ${msg}`);
}

function fail(msg: string) {
  console.log(`  ${RED}[missing]${RESET} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

function whichBin(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function runVersion(bin: string): string | null {
  try {
    return execSync(`${bin} --version`, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function ensureDir(dir: string): boolean {
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

function ensureFile(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

/**
 * Apply template placeholder replacements to file content.
 * Only applies to .md and .yaml files.
 */
function applyTemplateReplacements(
  content: string,
  replacements: Record<string, string>,
): string {
  let result = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

/**
 * Recursively copy template directory contents into dest, skipping files that already exist.
 * Applies template placeholder replacements to .md and .yaml files.
 * Returns list of created file paths.
 */
function copyTemplateDir(
  srcDir: string,
  destDir: string,
  replacements?: Record<string, string>,
): string[] {
  const created: string[] = [];
  if (!fs.existsSync(srcDir)) return created;

  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      created.push(...copyTemplateDir(srcPath, destPath, replacements));
    } else if (entry.name === ".gitkeep") {
      // skip .gitkeep — directory already created
      continue;
    } else if (!fs.existsSync(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ext = path.extname(entry.name).toLowerCase();
      if (replacements && (ext === ".md" || ext === ".yaml" || ext === ".yml")) {
        const content = fs.readFileSync(srcPath, "utf-8");
        fs.writeFileSync(destPath, applyTemplateReplacements(content, replacements), "utf-8");
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      created.push(destPath);
    }
  }
  return created;
}

const DEFAULT_CONFIG = `gateway:
  port: 7777
  host: "127.0.0.1"
engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.4
connectors: {}
portal: {}
logging:
  file: true
  stdout: true
  level: info
`;

function defaultClaudeMd(portalName: string) {
  return `# ${portalName} AI Gateway

This is the ${portalName} home directory (~/.jimmy).
${portalName} orchestrates Claude Code and Codex as AI engines.
`;
}

function defaultAgentsMd(portalName: string) {
  return `# ${portalName} Agents

Agents are configured via employees in the org/ directory.
`;
}

export async function runSetup(opts?: { force?: boolean }): Promise<void> {
  console.log("\nJimmy Setup\n");

  if (opts?.force && fs.existsSync(JIMMY_HOME)) {
    console.log(`  ${YELLOW}[force]${RESET} Removing ${JIMMY_HOME}...`);
    fs.rmSync(JIMMY_HOME, { recursive: true, force: true });
    console.log(`  ${GREEN}[ok]${RESET} Removed ${JIMMY_HOME}\n`);
  }

  // 1. Check Node.js version
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion >= 22) {
    ok(`Node.js v${process.versions.node}`);
  } else {
    warn(`Node.js v${process.versions.node} -- v22+ recommended`);
  }

  // 2. Check for claude binary
  const claudePath = whichBin("claude");
  if (claudePath) {
    ok(`claude found at ${claudePath}`);
  } else {
    fail("claude not found");
    info("Install with: npm install -g @anthropic-ai/claude-code");
  }

  // 3. Check for codex binary
  const codexPath = whichBin("codex");
  if (codexPath) {
    ok(`codex found at ${codexPath}`);
  } else {
    fail("codex not found");
    info("Install with: npm install -g @openai/codex");
  }

  // 4. Check auth / versions
  console.log("");
  if (claudePath) {
    const ver = runVersion("claude");
    if (ver) ok(`claude --version: ${ver}`);
    else warn("claude --version failed");
  }
  if (codexPath) {
    const ver = runVersion("codex");
    if (ver) ok(`codex --version: ${ver}`);
    else warn("codex --version failed");
  }

  // 5. Create ~/.jimmy directory structure
  console.log("");
  const created: string[] = [];

  if (ensureDir(JIMMY_HOME)) created.push(JIMMY_HOME);

  // Copy or create config files
  const templateConfig = path.join(TEMPLATE_DIR, "config.yaml");
  const templateClaude = path.join(TEMPLATE_DIR, "CLAUDE.md");
  const templateAgents = path.join(TEMPLATE_DIR, "AGENTS.md");

  if (!fs.existsSync(CONFIG_PATH)) {
    const source = fs.existsSync(templateConfig)
      ? fs.readFileSync(templateConfig, "utf-8")
      : DEFAULT_CONFIG;
    ensureFile(CONFIG_PATH, source);
    created.push(CONFIG_PATH);
  }

  // Read portal name from config for template replacements
  const portalName = (() => {
    try {
      const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
      return cfg?.portal?.portalName || "Jimmy";
    } catch { return "Jimmy"; }
  })();
  const portalSlug = portalName.toLowerCase().replace(/\s+/g, "-");

  const templateReplacements: Record<string, string> = {
    "{{portalName}}": portalName,
    "{{portalSlug}}": portalSlug,
  };

  const claudeMdPath = path.join(JIMMY_HOME, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    let source = fs.existsSync(templateClaude)
      ? fs.readFileSync(templateClaude, "utf-8")
      : defaultClaudeMd(portalName);
    source = applyTemplateReplacements(source, templateReplacements);
    ensureFile(claudeMdPath, source);
    created.push(claudeMdPath);
  }

  const agentsMdPath = path.join(JIMMY_HOME, "AGENTS.md");
  if (!fs.existsSync(agentsMdPath)) {
    let source = fs.existsSync(templateAgents)
      ? fs.readFileSync(templateAgents, "utf-8")
      : defaultAgentsMd(portalName);
    source = applyTemplateReplacements(source, templateReplacements);
    ensureFile(agentsMdPath, source);
    created.push(agentsMdPath);
  }

  // 6. Initialize SQLite database
  try {
    initDb();
    ok("Sessions database initialized");
  } catch (err) {
    warn(`Failed to initialize sessions database: ${err}`);
  }

  // 7. Create cron/jobs.json
  if (ensureFile(CRON_JOBS, "[]")) created.push(CRON_JOBS);

  // 8. Create cron/runs/
  if (ensureDir(CRON_RUNS)) created.push(CRON_RUNS);

  // 9. Create connectors/
  const connectorsDir = path.join(JIMMY_HOME, "connectors");
  if (ensureDir(connectorsDir)) created.push(connectorsDir);

  // 10. Create knowledge/
  const knowledgeDir = path.join(JIMMY_HOME, "knowledge");
  if (ensureDir(knowledgeDir)) created.push(knowledgeDir);

  // 11. Create tmp/
  if (ensureDir(TMP_DIR)) created.push(TMP_DIR);

  // Other standard dirs
  if (ensureDir(LOGS_DIR)) created.push(LOGS_DIR);

  // Copy template contents for docs, skills, and org (skips existing files)
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "docs"), DOCS_DIR, templateReplacements));
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "skills"), SKILLS_DIR, templateReplacements));
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "org"), ORG_DIR, templateReplacements));

  // Ensure dirs exist even if template had nothing to copy
  ensureDir(DOCS_DIR);
  ensureDir(SKILLS_DIR);
  ensureDir(ORG_DIR);

  // Create .claude/skills/ and .agents/skills/ with symlinks to skills/
  ensureDir(CLAUDE_SKILLS_DIR);
  ensureDir(AGENTS_SKILLS_DIR);

  if (fs.existsSync(SKILLS_DIR)) {
    const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of skillDirs) {
      const relTarget = path.join("..", "..", "skills", name);
      for (const targetDir of [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR]) {
        const linkPath = path.join(targetDir, name);
        if (!fs.existsSync(linkPath)) {
          try {
            fs.symlinkSync(relTarget, linkPath);
          } catch {
            // ignore — may fail on some platforms
          }
        }
      }
    }
  }

  // Create .claude/settings.local.json for engine permissions
  const settingsPath = path.join(JIMMY_HOME, ".claude", "settings.local.json");
  if (ensureFile(settingsPath, JSON.stringify({
    permissions: {
      allow: [
        "Bash(npm:*)", "Bash(pnpm:*)", "Bash(node:*)", "Bash(jimmy:*)",
        "Bash(curl:*)", "Bash(cat:*)", "Bash(ls:*)", "Bash(mkdir:*)",
        "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(git:*)",
        "Read", "Write", "Edit", "Glob", "Grep",
      ],
    },
  }, null, 2) + "\n")) {
    created.push(settingsPath);
  }

  // 12. Print summary
  console.log("");
  if (created.length === 0) {
    ok("Everything already set up -- nothing to do");
  } else {
    ok(`Created ${created.length} item(s):`);
    for (const item of created) {
      info(item);
    }
  }

  console.log(`\n${GREEN}Setup complete.${RESET} Run ${DIM}jimmy start${RESET} to launch the gateway.\n`);
}
