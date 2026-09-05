import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execSync, spawn } from "node:child_process";
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
  MIGRATIONS_DIR,
} from "../shared/paths.js";
import { initDb } from "../sessions/registry.js";
import {
  applyTemplateReplacements,
  isTemplateFile,
  readPortalName,
  buildTemplateReplacements,
} from "../shared/templateReplacements.js";
import { ensureOwnerOnlyDirectory } from "../shared/owner-only.js";
import { buildInitialConfig } from "./initial-config.js";

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
      if (replacements && isTemplateFile(entry.name)) {
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
      console.log(`  💡 ${label} プロジェクトを検出。${DIM}${portalSlug} skills find ${query}${RESET} で関連スキルを探せます。`);
    }
  }
}

function defaultClaudeMd(portalName: string) {
  return `# ${portalName} AI Gateway

This is the ${portalName} home directory (~/.ryoko).
${portalName} orchestrates Claude Code and Codex as AI engines.
`;
}

function defaultAgentsMd(portalName: string) {
  return `# ${portalName} Agents

Agents are configured via employees in the org/ directory.
`;
}

export async function runSetup(opts?: { force?: boolean }): Promise<void> {
  console.log("\nRyoko セットアップ\n");

  if (opts?.force && fs.existsSync(JINN_HOME)) {
    console.log(`  ${YELLOW}[force]${RESET} ${JINN_HOME} を削除中...`);
    fs.rmSync(JINN_HOME, { recursive: true, force: true });
    console.log(`  ${GREEN}[ok]${RESET} ${JINN_HOME} を削除しました\n`);
  }

  // 1. Check Node.js version
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion >= 22) {
    ok(`Node.js v${process.versions.node}`);
  } else {
    warn(`Node.js v${process.versions.node} -- v22 以上を推奨`);
  }

  // 2. Check for claude binary
  const claudePath = whichBin("claude");
  if (claudePath) {
    ok(`claude を検出: ${claudePath}`);
  } else {
    fail("claude が見つかりません");
    info("インストール: npm install -g @anthropic-ai/claude-code");
  }

  // 3. Check for codex binary
  const codexPath = whichBin("codex");
  if (codexPath) {
    ok(`codex を検出: ${codexPath}`);
  } else {
    fail("codex が見つかりません");
    info("インストール: npm install -g @openai/codex");
  }

  // 4. Check auth / versions
  console.log("");
  if (claudePath) {
    const ver = runVersion("claude");
    if (ver) ok(`claude --version: ${ver}`);
    else warn("claude --version の実行に失敗");
  }
  if (codexPath) {
    const ver = runVersion("codex");
    if (ver) ok(`codex --version: ${ver}`);
    else warn("codex --version の実行に失敗");
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
    chosenName = await prompt("AIアシスタントの名前は？", defaultName);

    // Determine available engines
    const engines: string[] = [];
    if (claudePath) engines.push("claude");
    if (codexPath) engines.push("codex");

    if (engines.length === 2) {
      const engineAnswer = await prompt("使用するエンジンは？ (claude/codex)", "claude");
      chosenEngine = engineAnswer === "codex" ? "codex" : "claude";
    } else if (engines.length === 1) {
      chosenEngine = engines[0] as "claude" | "codex";
      ok(`${chosenEngine} をデフォルトエンジンに設定（唯一のインストール済みエンジン）`);
    }
  }

  // 6. Create ~/.ryoko directory structure
  console.log("");
  const created: string[] = [];

  const homePermission = ensureOwnerOnlyDirectory(JINN_HOME);
  if (homePermission.warning) warn(`インスタンスディレクトリの権限を制限できませんでした: ${homePermission.warning}`);
  if (homePermission.changed) created.push(JINN_HOME);

  // Copy or create config files
  const templateClaude = path.join(TEMPLATE_DIR, "CLAUDE.md");
  const templateAgents = path.join(TEMPLATE_DIR, "AGENTS.md");

  if (!fs.existsSync(CONFIG_PATH)) {
    ensureFile(CONFIG_PATH, buildInitialConfig(chosenEngine, chosenName));
    created.push(CONFIG_PATH);
  }

  // Read portal name from config for template replacements
  const portalName = readPortalName();
  const portalSlug = portalName.toLowerCase().replace(/\s+/g, "-");
  const templateReplacements = buildTemplateReplacements(portalName);

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

  // Copy persona / memory skeleton MDs (OpenClaw-style).
  // Each file is created once on first init; never overwritten on later runs.
  //
  // BOOTSTRAP.md is the one-time first-run ritual file. The agent deletes it
  // after onboarding completes, and `ryoko setup` must NOT recreate it on
  // subsequent runs. We treat "no persona files present" as the trigger to
  // place BOOTSTRAP.md — this covers BOTH:
  //   1. Brand-new workspaces (first `ryoko setup` ever)
  //   2. Existing pre-persona-layer workspaces upgrading from older OpenRyoko
  // Both cases legitimately need onboarding to populate IDENTITY/SOUL/MEMORY.
  // After the agent deletes BOOTSTRAP.md, persona files exist, so future
  // `ryoko setup` runs skip BOOTSTRAP creation.
  const personaFiles = ["IDENTITY.md", "SOUL.md", "MEMORY.md", "TOOLS.md"];
  const needsBootstrap = personaFiles.every((f) => !fs.existsSync(path.join(JINN_HOME, f)));

  for (const filename of personaFiles) {
    const destPath = path.join(JINN_HOME, filename);
    const templatePath = path.join(TEMPLATE_DIR, filename);
    if (fs.existsSync(destPath)) continue;
    if (!fs.existsSync(templatePath)) continue;
    let source = fs.readFileSync(templatePath, "utf-8");
    source = applyTemplateReplacements(source, templateReplacements);
    ensureFile(destPath, source);
    created.push(destPath);
  }

  if (needsBootstrap) {
    const bootstrapDest = path.join(JINN_HOME, "BOOTSTRAP.md");
    const bootstrapTemplate = path.join(TEMPLATE_DIR, "BOOTSTRAP.md");
    if (!fs.existsSync(bootstrapDest) && fs.existsSync(bootstrapTemplate)) {
      let source = fs.readFileSync(bootstrapTemplate, "utf-8");
      source = applyTemplateReplacements(source, templateReplacements);
      ensureFile(bootstrapDest, source);
      created.push(bootstrapDest);
    }
  }

  // Daily-notes directory for memory/YYYY-MM-DD.md
  const memoryDir = path.join(JINN_HOME, "memory");
  if (ensureDir(memoryDir)) created.push(memoryDir);

  // 6. Initialize SQLite database
  try {
    initDb();
    ok("セッションDBを初期化しました");
  } catch (err) {
    warn(`セッションDBの初期化に失敗: ${err}`);
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

  // Migrations are copied so the migrate skill can list pending versions from
  // ~/.ryoko/migrations/. Existing applied migrations stay (skip-if-exists),
  // and new versions become available next time the user upgrades the package.
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "migrations"), MIGRATIONS_DIR, templateReplacements));

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
    ok("すでにセットアップ済みです");
  } else {
    ok(`${created.length} 件を作成しました:`);
    for (const item of created) {
      info(item);
    }
  }

  // Offer the interactive (PTY, Max-subsidized) Claude engine. config.yaml now
  // exists; promptInteractive() is a no-op outside a TTY and when already decided.
  try {
    const { promptInteractive } = await import("./interactive-config.js");
    await promptInteractive();
  } catch {
    /* best-effort — never block setup on the optional prompt */
  }

  console.log(`\n${GREEN}セットアップ完了。${RESET} ${DIM}ryoko start${RESET} でゲートウェイを起動できます。\n`);
}
