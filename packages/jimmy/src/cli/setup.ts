import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execSync, spawn } from "node:child_process";
import yaml from "js-yaml";
import {
  JINN_HOME,
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
import { getPackageVersion } from "../shared/version.js";

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

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function whichBin(name: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execSync(`${cmd} ${name}`, { encoding: "utf-8" }).trim().split("\n")[0];
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

/**
 * Detect project context by scanning ~/Projects/ for common project indicators
 * and suggest relevant skills the user might want to install.
 */
function detectProjectContext(portalSlug: string): void {
  const projectsDir = path.join(os.homedir(), "Projects");
  if (!fs.existsSync(projectsDir)) return;

  const indicators: { check: (dir: string) => boolean; query: string; label: string }[] = [
    {
      check: (dir) => {
        try {
          return fs.readdirSync(dir).some((e) => e.endsWith(".xcodeproj"));
        } catch { return false; }
      },
      query: "ios swift xcode",
      label: "iOS",
    },
    {
      check: (dir) => fs.existsSync(path.join(dir, "Package.swift")),
      query: "ios swift xcode",
      label: "iOS/Swift",
    },
    {
      check: (dir) => fs.existsSync(path.join(dir, "Dockerfile")),
      query: "docker container",
      label: "Docker",
    },
    {
      check: (dir) => fs.existsSync(path.join(dir, ".github", "workflows")),
      query: "github actions ci",
      label: "GitHub Actions",
    },
    {
      check: (dir) => {
        try {
          return fs.readdirSync(dir).some((e) => e.startsWith("playwright.config"));
        } catch { return false; }
      },
      query: "playwright testing",
      label: "Playwright",
    },
    {
      check: (dir) => {
        const pkgPath = path.join(dir, "package.json");
        if (!fs.existsSync(pkgPath)) return false;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return deps != null && ("react" in deps || "next" in deps);
        } catch { return false; }
      },
      query: "react nextjs",
      label: "React",
    },
  ];

  const detected = new Map<string, string>(); // label → query

  try {
    const topLevel = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    const projectDirs: string[] = [];
    for (const dir of topLevel) {
      const dirPath = path.join(projectsDir, dir.name);
      projectDirs.push(dirPath);
      // One level deeper for org-style folders (e.g. ~/Projects/Personal/foo)
      try {
        const subDirs = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter((e) => e.isDirectory());
        for (const sub of subDirs) {
          projectDirs.push(path.join(dirPath, sub.name));
        }
      } catch {
        // ignore permission errors
      }
    }

    for (const projDir of projectDirs) {
      for (const ind of indicators) {
        if (detected.has(ind.label)) continue;
        if (ind.check(projDir)) {
          detected.set(ind.label, ind.query);
        }
      }
    }
  } catch {
    return;
  }

  if (detected.size > 0) {
    console.log("");
    for (const [label, query] of detected) {
      console.log(`  💡 Detected ${label} projects. Run ${DIM}${portalSlug} skills find ${query}${RESET} to discover relevant skills.`);
    }
  }
}

const DEFAULT_CONFIG = `jinn:
  version: "${getPackageVersion()}"

gateway:
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

This is the ${portalName} home directory (~/.jinn).
${portalName} orchestrates Claude Code and Codex as AI engines.
`;
}

function defaultAgentsMd(portalName: string) {
  return `# ${portalName} Agents

Agents are configured via employees in the org/ directory.
`;
}

export async function runSetup(opts?: { force?: boolean }): Promise<void> {
  console.log("\nJinn Setup\n");

  if (opts?.force && fs.existsSync(JINN_HOME)) {
    console.log(`  ${YELLOW}[force]${RESET} Removing ${JINN_HOME}...`);
    fs.rmSync(JINN_HOME, { recursive: true, force: true });
    console.log(`  ${GREEN}[ok]${RESET} Removed ${JINN_HOME}\n`);
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

  // 5. Interactive setup (only when stdin is a TTY and config doesn't exist yet)
  const isFreshSetup = !fs.existsSync(CONFIG_PATH);
  const isInteractive = process.stdin.isTTY && isFreshSetup;

  // Derive default COO name from instance name if set, otherwise "Ryoko"
  const instanceName = process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE;
  const defaultName = instanceName
    ? instanceName.charAt(0).toUpperCase() + instanceName.slice(1)
    : "Ryoko";

  let chosenName = defaultName;
  let chosenEngine: "claude" | "codex" = "claude";

  if (isInteractive) {
    console.log("");
    chosenName = await prompt("What should your AI assistant be called?", defaultName);

    // Determine available engines
    const engines: string[] = [];
    if (claudePath) engines.push("claude");
    if (codexPath) engines.push("codex");

    if (engines.length === 2) {
      const engineAnswer = await prompt("Preferred engine? (claude/codex)", "claude");
      chosenEngine = engineAnswer === "codex" ? "codex" : "claude";
    } else if (engines.length === 1) {
      chosenEngine = engines[0] as "claude" | "codex";
      ok(`Using ${chosenEngine} as default engine (only engine installed)`);
    }
  }

  // 6. Create ~/.jinn directory structure
  console.log("");
  const created: string[] = [];

  if (ensureDir(JINN_HOME)) created.push(JINN_HOME);

  // Copy or create config files
  const templateConfig = path.join(TEMPLATE_DIR, "config.yaml");
  const templateClaude = path.join(TEMPLATE_DIR, "CLAUDE.md");
  const templateAgents = path.join(TEMPLATE_DIR, "AGENTS.md");

  if (!fs.existsSync(CONFIG_PATH)) {
    let source = fs.existsSync(templateConfig)
      ? fs.readFileSync(templateConfig, "utf-8")
      : DEFAULT_CONFIG;
    // Stamp the current package version into the config
    source = source.replace(/version:\s*"[^"]*"/, `version: "${getPackageVersion()}"`);
    // Apply interactive choices
    source = source.replace(/default:\s*claude/, `default: ${chosenEngine}`);
    if (chosenName !== "Ryoko") {
      // Template already has `portalName: Ryoko` under portal. Substitute.
      // Also handle the legacy `portal: {}` form for back-compat.
      if (source.includes("portalName: Ryoko")) {
        source = source.replace("portalName: Ryoko", `portalName: "${chosenName}"`);
      } else {
        source = source.replace("portal: {}", `portal:\n  portalName: "${chosenName}"`);
      }
    }
    ensureFile(CONFIG_PATH, source);
    created.push(CONFIG_PATH);
  }

  // Read portal name from config for template replacements
  const portalName = (() => {
    try {
      const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
      return cfg?.portal?.portalName || "Ryoko";
    } catch { return "Ryoko"; }
  })();
  const portalSlug = portalName.toLowerCase().replace(/\s+/g, "-");

  const templateReplacements: Record<string, string> = {
    "{{portalName}}": portalName,
    "{{portalSlug}}": portalSlug,
  };

  const claudeMdPath = path.join(JINN_HOME, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    let source = fs.existsSync(templateClaude)
      ? fs.readFileSync(templateClaude, "utf-8")
      : defaultClaudeMd(portalName);
    source = applyTemplateReplacements(source, templateReplacements);
    ensureFile(claudeMdPath, source);
    created.push(claudeMdPath);
  }

  const agentsMdPath = path.join(JINN_HOME, "AGENTS.md");
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
  const connectorsDir = path.join(JINN_HOME, "connectors");
  if (ensureDir(connectorsDir)) created.push(connectorsDir);

  // 10. Create knowledge/
  const knowledgeDir = path.join(JINN_HOME, "knowledge");
  if (ensureDir(knowledgeDir)) created.push(knowledgeDir);

  // 11. Create tmp/
  if (ensureDir(TMP_DIR)) created.push(TMP_DIR);

  // Other standard dirs
  if (ensureDir(LOGS_DIR)) created.push(LOGS_DIR);

  // Copy template contents for docs, skills, and org (skips existing files)
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "docs"), DOCS_DIR, templateReplacements));
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "skills"), SKILLS_DIR, templateReplacements));
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "org"), ORG_DIR, templateReplacements));

  // Copy skills.json manifest
  const templateSkillsJson = path.join(TEMPLATE_DIR, "skills.json");
  const destSkillsJson = path.join(JINN_HOME, "skills.json");
  if (fs.existsSync(templateSkillsJson) && !fs.existsSync(destSkillsJson)) {
    fs.copyFileSync(templateSkillsJson, destSkillsJson);
    created.push(destSkillsJson);
  }

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
  const settingsPath = path.join(JINN_HOME, ".claude", "settings.local.json");
  if (ensureFile(settingsPath, JSON.stringify({
    permissions: {
      allow: [
        "Bash(npm:*)", "Bash(pnpm:*)", "Bash(node:*)", "Bash(jinn:*)",
        "Bash(curl:*)", "Bash(cat:*)", "Bash(ls:*)", "Bash(mkdir:*)",
        "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(git:*)",
        "Read", "Write", "Edit", "Glob", "Grep",
      ],
    },
  }, null, 2) + "\n")) {
    created.push(settingsPath);
  }

  // Pre-cache skills CLI for instant searches later
  spawn('npx', ['skills', '--version'], { stdio: 'ignore', detached: true }).unref();

  // Detect project context and suggest relevant skills
  detectProjectContext(portalSlug);

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

  console.log(`\n${GREEN}Setup complete.${RESET} Run ${DIM}jinn start${RESET} to launch the gateway.\n`);
}
