import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
logging:
  file: true
  stdout: true
  level: info
`;

const DEFAULT_CLAUDE_MD = `# Jimmy AI Gateway

This is the Jimmy home directory (~/.jimmy).
Jimmy orchestrates Claude Code and Codex as AI engines.
`;

const DEFAULT_AGENTS_MD = `# Jimmy Agents

Agents are configured via employees in the org/ directory.
`;

export async function runSetup(): Promise<void> {
  console.log("\nJimmy Setup\n");

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

  const claudeMdPath = path.join(JIMMY_HOME, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    const source = fs.existsSync(templateClaude)
      ? fs.readFileSync(templateClaude, "utf-8")
      : DEFAULT_CLAUDE_MD;
    ensureFile(claudeMdPath, source);
    created.push(claudeMdPath);
  }

  const agentsMdPath = path.join(JIMMY_HOME, "AGENTS.md");
  if (!fs.existsSync(agentsMdPath)) {
    const source = fs.existsSync(templateAgents)
      ? fs.readFileSync(templateAgents, "utf-8")
      : DEFAULT_AGENTS_MD;
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
  if (ensureDir(DOCS_DIR)) created.push(DOCS_DIR);
  if (ensureDir(SKILLS_DIR)) created.push(SKILLS_DIR);
  if (ensureDir(ORG_DIR)) created.push(ORG_DIR);

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
