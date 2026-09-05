import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import {
  JINN_HOME,
  CONFIG_PATH,
  MIGRATIONS_DIR,
  TEMPLATE_DIR,
  SKILLS_DIR,
  CLAUDE_SKILLS_DIR,
  AGENTS_SKILLS_DIR,
} from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import {
  compareSemver,
  getPackageVersion,
  getInstanceVersion,
  getPendingMigrations,
} from "../shared/version.js";
import {
  applyTemplateReplacements,
  isTemplateFile,
  readPortalName,
  buildTemplateReplacements,
} from "../shared/templateReplacements.js";
import { parseConfigPatch, applyPatchOps, type PatchOutcome } from "../shared/configPatch.js";
import { auditGatewayReferences } from "./gateway-audit.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Recursively copy a directory tree, overwriting existing files.
 * Used to stage migration files into the instance home.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.name !== ".gitkeep") {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Ensure symlinks exist for a skill directory in .claude/skills/ and .agents/skills/.
 */
function ensureSkillSymlinks(skillName: string): void {
  const relTarget = path.join("..", "..", "skills", skillName);
  for (const targetDir of [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR]) {
    fs.mkdirSync(targetDir, { recursive: true });
    const linkPath = path.join(targetDir, skillName);
    if (!fs.existsSync(linkPath)) {
      try {
        fs.symlinkSync(relTarget, linkPath);
      } catch {
        // ignore — may fail on some platforms
      }
    }
  }
}

/**
 * Stamp the jinn.version field in config.yaml.
 */
function stampVersion(version: string): void {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = yaml.load(raw) as any;

  if (!config.jinn) config.jinn = {};
  config.jinn.version = version;

  fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: -1 }), "utf-8");
}

/**
 * Apply any `config-patch.json` shipped with the pending migrations to the
 * instance config.yaml. Deterministic and idempotent — evolves shipped default
 * values without clobbering values the user has customized (see configPatch.ts).
 * Returns the number of keys actually changed. Logs each outcome.
 */
function applyConfigPatches(pending: string[]): number {
  const patchFiles = pending
    .map((version) => ({ version, file: path.join(MIGRATIONS_DIR, version, "config-patch.json") }))
    .filter(({ file }) => fs.existsSync(file));

  if (patchFiles.length === 0 || !fs.existsSync(CONFIG_PATH)) return 0;

  let working: unknown;
  try {
    working = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err: any) {
    console.log(`  ${RED}[config-patch: could not read config.yaml: ${err?.message ?? err}]${RESET}`);
    return 0;
  }

  const allOutcomes: PatchOutcome[] = [];
  for (const { version, file } of patchFiles) {
    let ops;
    try {
      ops = parseConfigPatch(fs.readFileSync(file, "utf-8"));
    } catch (err: any) {
      console.log(`  ${RED}[config-patch ${version}: ${err?.message ?? err}]${RESET}`);
      continue;
    }
    const { config: nextConfig, outcomes } = applyPatchOps(working, ops);
    working = nextConfig;
    allOutcomes.push(...outcomes);
  }

  const changed = allOutcomes.filter((o) => o.action === "set" || o.action === "insert").length;
  if (changed > 0) {
    fs.writeFileSync(CONFIG_PATH, yaml.dump(working, { lineWidth: -1 }), "utf-8");
  }

  for (const o of allOutcomes) {
    if (o.action === "set") {
      console.log(`  ${GREEN}[config]${RESET} ${o.path}: ${JSON.stringify(o.from)} → ${JSON.stringify(o.to)}`);
    } else if (o.action === "insert") {
      console.log(`  ${GREEN}[config]${RESET} ${o.path}: (added) ${JSON.stringify(o.to)}`);
    } else if (o.action === "skip" && o.reason === "customized") {
      console.log(`  ${YELLOW}[config skip]${RESET} ${o.path} (customized: ${JSON.stringify(o.current)})`);
    }
    // reason "already" → silent no-op
  }

  return changed;
}

/**
 * Build engine-specific CLI args for running a one-shot migration prompt.
 * Each engine CLI uses different flags for prompt input.
 */
function buildMigrateArgs(engine: string, prompt: string): string[] {
  switch (engine) {
    case "codex":
      return ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt];
    case "gemini":
      return ["--yolo", prompt];
    case "claude":
    default:
      return ["-p", "--dangerously-skip-permissions", prompt];
  }
}

export async function runMigrate(opts: { check?: boolean; auto?: boolean; fix?: boolean }): Promise<void> {
  // Ensure instance exists
  if (!fs.existsSync(JINN_HOME)) {
    console.error(`${RED}エラー:${RESET} ${JINN_HOME} が存在しません。"ryoko setup" を実行してください。`);
    process.exit(1);
  }

  const shouldFixGatewayUrls = opts.fix === true || opts.auto === true;
  const gatewayAudit = auditGatewayReferences(JINN_HOME, { fix: shouldFixGatewayUrls });
  if (gatewayAudit.legacyOccurrences > 0) {
    if (shouldFixGatewayUrls) {
      console.log(`${GREEN}[gateway URL]${RESET} ${gatewayAudit.legacyOccurrences}箇所 / ${gatewayAudit.fixedFiles.length}ファイルをloopback URLへ修正しました。`);
      if (gatewayAudit.backupDir) console.log(`${DIM}バックアップ: ${gatewayAudit.backupDir}${RESET}`);
    } else {
      console.log(`${YELLOW}[gateway URL warning]${RESET} ${gatewayAudit.legacyOccurrences}箇所 / ${gatewayAudit.legacyFiles.length}ファイルに http://0.0.0.0 または http://[::] が残っています。`);
      console.log(`${YELLOW}ryoko migrate --fix${RESET} でバックアップ後にloopback URLへ置換できます。`);
    }
  }
  if (gatewayAudit.unauthenticatedCurlCandidates.length > 0) {
    console.log(`${YELLOW}[gateway auth warning]${RESET} 認証なしで保護APIを呼ぶ可能性があるcurlを ${gatewayAudit.unauthenticatedCurlCandidates.length}ファイルで検出しました。`);
    for (const file of gatewayAudit.unauthenticatedCurlCandidates.slice(0, 10)) console.log(`  - ${file}`);
    if (gatewayAudit.unauthenticatedCurlCandidates.length > 10) console.log(`  ...ほか ${gatewayAudit.unauthenticatedCurlCandidates.length - 10}ファイル`);
    console.log(`${YELLOW}直接curlする代わりに ryoko api METHOD /api/... を使用してください。${RESET}`);
  }

  const packageVersion = getPackageVersion();
  const instanceVersion = getInstanceVersion();

  console.log(`\n${DIM}インスタンスバージョン:${RESET} ${instanceVersion}`);
  console.log(`${DIM}パッケージバージョン:${RESET}  ${packageVersion}\n`);

  // Already up to date
  if (compareSemver(instanceVersion, packageVersion) >= 0) {
    console.log(`${GREEN}最新版です。${RESET} マイグレーションは不要です。\n`);
    return;
  }

  // Find pending migrations
  const pending = getPendingMigrations(instanceVersion, packageVersion);

  if (pending.length === 0) {
    console.log(`${YELLOW}マイグレーションスクリプトが見つかりません${RESET}（${instanceVersion} → ${packageVersion}）。`);

    if (!opts.check) {
      console.log(`バージョン情報を ${packageVersion} に更新中...`);
      stampVersion(packageVersion);
      console.log(`${GREEN}完了しました。${RESET}\n`);
    }
    return;
  }

  // List pending migrations
  console.log(`${YELLOW}保留中のマイグレーション:${RESET}`);
  for (const v of pending) {
    const migrationMd = path.join(TEMPLATE_DIR, "migrations", v, "MIGRATION.md");
    const hasMd = fs.existsSync(migrationMd);
    console.log(`  ${v} ${hasMd ? "" : `${RED}(MIGRATION.md が見つかりません)${RESET}`}`);
  }
  console.log("");

  // --check: just show what's pending, don't apply
  if (opts.check) {
    console.log(`${DIM}ryoko migrate${RESET} で適用してください。\n`);
    return;
  }

  // Stage migration files into ~/.ryoko/migrations/
  console.log("マイグレーションファイルをステージング中...");
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

  for (const version of pending) {
    const src = path.join(TEMPLATE_DIR, "migrations", version);
    const dest = path.join(MIGRATIONS_DIR, version);
    copyDirRecursive(src, dest);
    console.log(`  ${GREEN}[staged]${RESET} ${version}`);
  }

  // Also ensure the migrate skill is available in the instance
  const migrateSkillSrc = path.join(TEMPLATE_DIR, "skills", "migrate");
  const migrateSkillDest = path.join(SKILLS_DIR, "migrate");
  if (fs.existsSync(migrateSkillSrc) && !fs.existsSync(migrateSkillDest)) {
    copyDirRecursive(migrateSkillSrc, migrateSkillDest);
    ensureSkillSymlinks("migrate");
    console.log(`  ${GREEN}[staged]${RESET} migrate スキル`);
  }

  // --auto: apply safe changes deterministically without launching AI
  if (opts.auto) {
    console.log("\n安全な変更を自動適用中...");
    await applyAutoMigrations(pending, instanceVersion, packageVersion);
    return;
  }

  // Launch AI session to apply migrations
  console.log(`\n${pending.length} 件のマイグレーションを AI で適用中...\n`);

  const config = loadConfig();
  const defaultEngine = config.engines.default ?? "claude";
  const engineConfig = config.engines[defaultEngine] ?? config.engines.claude;

  try {
    const prompt = [
      `Apply all pending migrations in ${MIGRATIONS_DIR}.`,
      `Follow the migrate skill instructions at ${path.join(SKILLS_DIR, "migrate", "SKILL.md")}.`,
      `Current instance version: ${instanceVersion}`,
      `Target version: ${packageVersion}`,
      `Pending versions: ${pending.join(", ")}`,
      ``,
      `For each version in order, read its MIGRATION.md and apply the changes.`,
      `After all migrations, update jinn.version in config.yaml to "${packageVersion}".`,
      `Clean up the migrations/ directory when done.`,
    ].join("\n");

    const args = buildMigrateArgs(defaultEngine, prompt);
    console.log(`${DIM}エンジン: ${defaultEngine} (${engineConfig.bin})${RESET}\n`);

    execFileSync(engineConfig.bin, args, {
      stdio: "inherit",
      cwd: JINN_HOME,
    });

    console.log(`\n${GREEN}マイグレーションが完了しました。${RESET}\n`);
  } catch (err: any) {
    console.error(`\n${RED}マイグレーションに失敗しました。${RESET} ryoko migrate で再試行できます。`);
    console.error(`ステージング済みファイルは ${MIGRATIONS_DIR} に残っています。\n`);
    process.exit(1);
  }
}

/**
 * Auto-migration: deterministically apply safe changes without AI.
 * Copies new files, adds new config keys. Does NOT modify user-customized files.
 */
async function applyAutoMigrations(
  pending: string[],
  instanceVersion: string,
  packageVersion: string,
): Promise<void> {
  let applied = 0;

  // Resolve portal name once so template files (.md/.yaml) get the same
  // {{portalName}} substitution as `ryoko setup` would apply.
  const portalName = readPortalName();
  const replacements = buildTemplateReplacements(portalName);
  let skippedExisting = 0;

  for (const version of pending) {
    const migrationDir = path.join(MIGRATIONS_DIR, version);
    const filesDir = path.join(migrationDir, "files");

    if (!fs.existsSync(filesDir)) {
      console.log(`  ${DIM}${version}: no files to auto-apply${RESET}`);
      continue;
    }

    // Walk the migration's files/ tree and apply each entry.
    // Directories are ensured (mkdir -p) so that empty dirs declared via
    // .gitkeep are also propagated to the instance home.
    const entries = collectEntries(filesDir, filesDir);
    for (const entry of entries) {
      const destPath = path.join(JINN_HOME, entry.relPath);

      if (entry.type === "dir") {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
          console.log(`  ${GREEN}[new]${RESET} ${entry.relPath}/`);
          applied++;
        }
        continue;
      }

      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const srcPath = path.join(filesDir, entry.relPath);
        if (isTemplateFile(entry.relPath)) {
          const content = fs.readFileSync(srcPath, "utf-8");
          fs.writeFileSync(destPath, applyTemplateReplacements(content, replacements), "utf-8");
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
        console.log(`  ${GREEN}[new]${RESET} ${entry.relPath}`);
        applied++;

        // If it's a skill, create symlinks
        const parts = entry.relPath.split(path.sep);
        if (parts[0] === "skills" && parts.length >= 2) {
          ensureSkillSymlinks(parts[1]);
        }
      } else {
        console.log(`  ${YELLOW}[skip]${RESET} ${entry.relPath} (exists — needs AI merge)`);
        skippedExisting++;
      }
    }
  }

  // Deterministic config.yaml value updates (respects user customizations).
  // Idempotent, so it is safe to run even when files are skipped below.
  const configChanges = applyConfigPatches(pending);

  if (skippedExisting > 0) {
    console.log(`\n${YELLOW}Auto-migration partially applied.${RESET} ${applied} file(s) added, ${configChanges} config value(s) updated, ${skippedExisting} existing file(s) need AI merge.`);
    console.log(`${YELLOW}Version was not updated.${RESET} Run ${RESET}ryoko migrate${YELLOW} (without --auto) to merge the skipped files and complete the migration.${RESET}`);
    console.log(`${DIM}Staged migration files remain in ${MIGRATIONS_DIR}.${RESET}\n`);
    return;
  }

  stampVersion(packageVersion);
  console.log(`\n  ${GREEN}[version]${RESET} ${instanceVersion} → ${packageVersion}`);
  console.log(`\n${GREEN}Auto-migration complete.${RESET} ${applied} file(s) added, ${configChanges} config value(s) updated.`);

  fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
}

type FsEntry = { type: "file" | "dir"; relPath: string };

/**
 * Recursively walk a directory and return both file and directory entries.
 * Files named `.gitkeep` are skipped (they exist only to retain empty dirs
 * in git); the parent directory is still emitted so the empty dir is created.
 */
function collectEntries(baseDir: string, currentDir: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      out.push({ type: "dir", relPath });
      out.push(...collectEntries(baseDir, fullPath));
    } else if (entry.name !== ".gitkeep") {
      out.push({ type: "file", relPath });
    }
  }
  return out;
}
