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
import { stageMissingBundledSkills } from "./bundled-skills.js";
import { auditGatewayReferences } from "./gateway-audit.js";
import { migrationNeedsSession } from "./migration-declarations.js";
import { syncInstanceBundledSkills } from "../skills-sync/instance.js";
import { printable } from "../skills-sync/names.js";
import type { BundledSkillSync, KeepReason, KeptSkill } from "../skills-sync/types.js";
import { claudeAutoMemoryEnvFor } from "../shared/claude-auto-memory.js";

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
 * Is anything at this path — including a symlink that leads nowhere? `existsSync`
 * follows links and answers "no" for such a one, and a write to the path then goes
 * through it and creates its target, wherever that is. Anything that cannot be
 * looked at counts as taken: the cautious answer is not to write there.
 */
function isTaken(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Does a link that leads nowhere sit on the way to this path, inside the home? A
 * directory the user links elsewhere is their arrangement and is used as it always
 * was; a link whose target is missing is one nothing can be placed under.
 */
function isBehindDanglingLink(file: string): boolean {
  for (let current = path.dirname(file); current.startsWith(JINN_HOME + path.sep); current = path.dirname(current)) {
    if (isTaken(current) && !fs.existsSync(current)) return true;
  }
  return false;
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

/** The only thing that puts back a bundled skill the operator deleted. */
const RESTORE_DELETED_SKILLS = "ryoko migrate --restore-deleted-skills";

/** Skills left alone for a reason the user can act on. Symlinks, and edits with
 *  no shipped update waiting, need nothing from them and are not listed. */
const KEPT_SKILL_NOTES: Partial<Record<KeepReason, (name: string) => string>> = {
  modified: () => "編集済み。同梱版に更新があります。上書きしません",
  unmanaged: () => "どの同梱版とも内容が違います。導入時の記録が無く、古い同梱版か編集済みかを区別できません。上書きしません",
  "retired-modified": () => "同梱から外れましたが、編集済みのため残しました",
  // Named, so the other skills the operator deleted are not brought back with it.
  deleted: (name) => `削除済みのため配置しません。戻すには ${RESTORE_DELETED_SKILLS} ${name}`,
};

/**
 * The bundled skills whose directories belong to the sync after it has run. A
 * migration's files/ for any of them must not be applied: the sync has already put
 * each one in its final state, and a stray file would undo that.
 */
interface SettledSkills {
  /** Skills that now match the shipped version. One more file would make them look edited. */
  inSync: ReadonlySet<string>;
  /** Shipped skills the operator deleted. Nothing in this command may put them back. */
  deleted: ReadonlySet<string>;
  /** Skills the package no longer ships, just moved to the backup directory. */
  retired: ReadonlySet<string>;
  /** Skills left untouched for any other reason: the only ones that may need a merge. */
  kept: readonly KeptSkill[];
}

/**
 * What the sync made of this home, which decides how far this command goes with skills.
 *
 * - "synced": the sync ran, and settled the skills listed.
 * - "user-managed": skills/ is the user's own symlink. The sync never writes into such
 *   a home, so its skills are handled as they were before the sync existed: bundled
 *   skills it lacks are added, and a migration's files/skills/ is copied or merged like
 *   any other file. Nothing is settled.
 * - "blocked": the sync failed, or stood back because a newer OpenRyoko synced the home
 *   last. Nobody knows which skills were deleted, retired or edited, so nothing is
 *   created under skills/ and no migration is recorded as applied — by --auto or by an
 *   AI run, which is not started.
 */
type SyncedSkills = SettledSkills & (
  | { mode: "synced" | "user-managed" }
  /** Why, and what has to happen first: both shown to the operator as they are. */
  | { mode: "blocked"; reason: string; remedy: string }
);

const NOTHING_SETTLED: SettledSkills = { inSync: new Set(), deleted: new Set(), retired: new Set(), kept: [] };
/** --check: nothing is synced, and nothing is written either. */
const NO_SYNCED_SKILLS: SyncedSkills = { ...NOTHING_SETTLED, mode: "synced" };

const NEWER_OWNER = "skills/.shipped-skills.json は、より新しい OpenRyoko がこのホームを同期したと記録しています";
const NEWER_OWNER_REMEDY = "その版の ryoko で migrate を実行してください。より新しい版がこのホームを使っていないなら、このファイルが誤りです。"
  + "修正するか削除してから、ryoko migrate を再実行してください（削除すると、同期が配置したスキルと、削除した同梱スキルの記録も消えます）";
const SYNC_FAILED_REMEDY = "原因を取り除いてから、ryoko migrate を再実行してください";

/** What the AI should do about a bundled skill the sync left untouched, by reason. */
const KEPT_SKILL_GUIDANCE: Record<Exclude<KeepReason, "deleted">, string> = {
  modified: "edited by the user since it was installed, and a newer version ships. Merge the migration's changes into it and keep the user's edits.",
  customized: "edited by the user; the shipped version has not changed since. Leave it as it is.",
  unmanaged: "differs from every version ever shipped, and nothing records how it was installed. "
    + "If it holds no additions of the user's, replace it with the migration's copy as is (when the migration ships one); otherwise merge and keep the additions.",
  symlink: "a symlink, or holds one: the user manages it elsewhere. Do not touch it.",
  "not-directory": "something that is not a directory occupies its name. Leave it.",
  unreadable: "could not be read. Leave it.",
  "too-large": "holds a file, or more files, than any bundled skill does. Leave it.",
  "retired-modified": "no longer shipped, but edited by the user. Leave it.",
};

/**
 * What the AI needs to know about bundled skills. It starts after the sync, never
 * sees this command's output, and may be following a migrate skill written before
 * the sync existed — so the state of every bundled skill is spelled out here.
 */
function bundledSkillPromptLines(skills: SyncedSkills): string[] {
  if (skills.mode === "user-managed") {
    return [
      "skills/ in this home is a symlink the user manages, so the bundled skill sync does not run here and no bundled skill was synced. "
      + "Handle each migration's files/skills/ yourself, as the migrate skill describes for a home without the sync: "
      + "copy a skill that is missing, and merge one that exists, keeping the user's edits.",
    ];
  }
  const listed = (label: string, names: ReadonlySet<string>) => (names.size > 0 ? [`- ${label}: ${[...names].sort().join(", ")}`] : []);
  const settled = [
    ...listed("already up to date", skills.inSync),
    ...listed("deleted by the operator, do not recreate", skills.deleted),
    ...listed("retired and moved to the backup directory, do not recreate", skills.retired),
  ];
  const kept = skills.kept.map(({ name, reason }) => `- ${name}: ${KEPT_SKILL_GUIDANCE[reason as Exclude<KeepReason, "deleted">]}`);
  return [
    // Always said: the migrate skill reads a prompt that is silent about the sync as
    // one that did not come from this command, and then does not touch skills.
    "Bundled skills were synced before this session started.",
    ...(settled.length > 0 ? ["Apply nothing from a migration's files/skills/ to these:", ...settled] : []),
    ...(kept.length > 0
      ? ["The sync left these bundled skills untouched. They are the only bundled skills that may need merging:", ...kept]
      : []),
  ];
}

/**
 * skills/ is the user's own symlink: their skill store, which the sync never writes
 * into. Its skills are handled the way every release before the sync handled them,
 * starting here with the bundled skills the home lacks. Failing to add them is
 * reported and nothing more: the store may be on another volume or read-only, and
 * the migrations do not depend on it.
 */
function addMissingSkillsWithoutSync(): SyncedSkills {
  console.log(`  ${YELLOW}[skills]${RESET} skills/ が symlink（利用者管理）のため、同梱スキルは自動同期しません。無い同梱スキルの追加と migration のスキルファイルは、同期の導入前と同じ扱いです`);
  try {
    for (const name of stageMissingBundledSkills(TEMPLATE_DIR, JINN_HOME, buildTemplateReplacements(readPortalName()))) {
      ensureSkillSymlinks(name);
      console.log(`  ${GREEN}[new skill]${RESET} ${name}`);
    }
  } catch (err: any) {
    console.log(`  ${YELLOW}[skills]${RESET} 無い同梱スキルを追加できませんでした: ${printable(String(err?.message ?? err))}`);
  }
  return { ...NOTHING_SETTLED, mode: "user-managed" };
}

/**
 * Run the bundled skill sync — the same one the gateway runs at start — and
 * report it. A sync that cannot run is reported here; what follows from it is the
 * caller's to decide (see SyncedSkills).
 *
 * Like gateway start, this leaves out a bundled skill the operator deleted:
 * `ryoko update` runs `ryoko migrate --auto`, and an update must not undo a
 * deletion. Only `--restore-deleted-skills` asks for those skills back.
 */
function syncBundledSkillsStep(restoreDeleted: boolean | readonly string[]): SyncedSkills {
  let result: BundledSkillSync;
  try {
    result = syncInstanceBundledSkills({ restoreDeleted });
  } catch (err: any) {
    const reason = printable(String(err?.message ?? err));
    console.log(`  ${YELLOW}[skills]${RESET} 同梱スキルを同期できませんでした: ${reason}`);
    console.log(`  ${YELLOW}[skills]${RESET} スキルの状態が分からないため、この実行では skills/ 配下に何も作成しません`);
    return { ...NOTHING_SETTLED, mode: "blocked", reason, remedy: SYNC_FAILED_REMEDY };
  }
  if (result.skipped === "skills-root-symlink") return addMissingSkillsWithoutSync();
  if (result.skipped) {
    console.log(`  ${YELLOW}[skills]${RESET} ${NEWER_OWNER}。同梱スキルは変更せず、skills/ 配下には何も作成しません`);
    return { ...NOTHING_SETTLED, mode: "blocked", reason: NEWER_OWNER, remedy: NEWER_OWNER_REMEDY };
  }
  for (const name of result.added) {
    ensureSkillSymlinks(name);
    console.log(`  ${GREEN}[new skill]${RESET} ${name}`);
  }
  for (const name of result.updated) console.log(`  ${GREEN}[updated skill]${RESET} ${name}`);
  for (const name of result.retired) console.log(`  ${YELLOW}[retired skill]${RESET} ${name}`);
  if (result.backupDir) console.log(`  ${DIM}置き換え・退役の前の内容: ${printable(result.backupDir)}${RESET}`);
  for (const { name, reason } of result.kept) {
    const note = KEPT_SKILL_NOTES[reason];
    if (note) console.log(`  ${YELLOW}[skill kept]${RESET} ${name} (${note(name)})`);
  }
  // A name that restored nothing was a typo or a skill that was never deleted: say so.
  for (const name of Array.isArray(restoreDeleted) ? restoreDeleted : []) {
    if (!result.added.includes(name)) console.log(`  ${YELLOW}[skills]${RESET} ${printable(name)}: 削除済みの同梱スキルではないため、何も配置していません`);
  }
  for (const { name, error } of result.failed) console.log(`  ${RED}[skill failed]${RESET} ${name}: ${printable(error)}`);
  if (result.receiptError) {
    console.log(`  ${YELLOW}[skills]${RESET} 受領証を保存できませんでした（${printable(result.receiptError)}）。スキル自体は配置済みで、次回の実行で記録されます`);
  }
  return {
    mode: "synced",
    inSync: new Set(result.inSync),
    deleted: new Set(result.kept.filter((skill) => skill.reason === "deleted").map((skill) => skill.name)),
    retired: new Set(result.retired),
    kept: result.kept.filter((skill) => skill.reason !== "deleted"),
  };
}

/**
 * Why a migration file must be left out, when it lies in the directory of a skill
 * the sync has settled; null when the file is none of the sync's business — which is
 * every file in a home whose skills the user manages, where nothing is settled.
 */
function settledSkillNote(relPath: string, skills: SyncedSkills): string | null {
  const parts = relPath.split(path.sep);
  if (parts[0] !== "skills") return null;
  if (skills.mode === "blocked") return "bundled skill sync did not run";
  if (parts.length < 2) return null;
  if (skills.deleted.has(parts[1])) return "bundled skill deleted by the operator";
  if (skills.retired.has(parts[1])) return "bundled skill retired";
  // The instance already has this file or a newer one — or the skill dropped it since.
  if (skills.inSync.has(parts[1])) return "bundled skill already in sync";
  return null;
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

/** Env for the engine run that applies migrations. A Claude run here works in
 *  the instance directory like any gateway session, so it follows the same
 *  auto-memory policy; other engines get the environment untouched. */
export function migrateChildEnv(engine: string, cwd: string): NodeJS.ProcessEnv {
  return engine === "claude" ? { ...process.env, ...claudeAutoMemoryEnvFor(cwd) } : process.env;
}

export async function runMigrate(opts: {
  check?: boolean;
  auto?: boolean;
  fix?: boolean;
  /** Put back bundled skills the operator deleted: every one (`true`) or the ones
   *  named. Without it they stay deleted. */
  restoreDeletedSkills?: boolean | string[];
}): Promise<void> {
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

  // Bundled skills are package content, independent of versioned config
  // migrations. Keep --check read-only; edited skills are never overwritten.
  const skills = opts.check ? NO_SYNCED_SKILLS : syncBundledSkillsStep(opts.restoreDeletedSkills ?? false);

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

  // The AI run ends by recording the version. With the sync blocked it would do that
  // having applied none of what these migrations ship for skills, and for good.
  if (skills.mode === "blocked" && !opts.auto) {
    console.error(`${RED}エラー:${RESET} 同梱スキルを同期できないため、マイグレーションを開始しません。`);
    console.error(`  理由: ${skills.reason}`);
    console.error(`  ${skills.remedy}`);
    console.error(`${DIM}マイグレーションのファイルはステージングしておらず、バージョン情報も更新していません。${RESET}\n`);
    process.exitCode = 1;
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

  // Also ensure the migrate skill is available in the instance — unless the
  // operator deleted it, or the sync could not say whether they did. Then nothing
  // is put there, and an AI run reads the packaged copy: as it does whenever the
  // instance has none it can read, such as behind a link that leads nowhere.
  const migrateSkillSrc = path.join(TEMPLATE_DIR, "skills", "migrate");
  const migrateSkillDest = path.join(SKILLS_DIR, "migrate");
  const stageMigrateSkill = skills.mode !== "blocked" && !skills.deleted.has("migrate") && fs.existsSync(migrateSkillSrc) && !isTaken(migrateSkillDest);
  if (stageMigrateSkill) {
    copyDirRecursive(migrateSkillSrc, migrateSkillDest);
    ensureSkillSymlinks("migrate");
    console.log(`  ${GREEN}[staged]${RESET} migrate スキル`);
  }
  const migrateSkillToRead = stageMigrateSkill || fs.existsSync(migrateSkillDest) ? migrateSkillDest : migrateSkillSrc;

  // --auto: apply safe changes deterministically without launching AI
  if (opts.auto) {
    console.log("\n安全な変更を自動適用中...");
    await applyAutoMigrations(pending, instanceVersion, packageVersion, skills);
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
      `Follow the migrate skill instructions at ${path.join(migrateSkillToRead, "SKILL.md")}.`,
      `Current instance version: ${instanceVersion}`,
      `Target version: ${packageVersion}`,
      `Pending versions: ${pending.join(", ")}`,
      ``,
      `For each version in order, read its MIGRATION.md and apply the changes.`,
      `After all migrations, update jinn.version in config.yaml to "${packageVersion}".`,
      `Clean up the migrations/ directory when done.`,
      ...bundledSkillPromptLines(skills),
    ].join("\n");

    const args = buildMigrateArgs(defaultEngine, prompt);
    console.log(`${DIM}エンジン: ${defaultEngine} (${engineConfig.bin})${RESET}\n`);

    execFileSync(engineConfig.bin, args, {
      stdio: "inherit",
      cwd: JINN_HOME,
      env: migrateChildEnv(defaultEngine, JINN_HOME),
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
 * Nothing is written into the directory of a bundled skill the sync has settled —
 * one it brought up to date, retired, or found deleted by the operator. Only skills
 * the user edited are still left to the AI merge.
 *
 * The version is recorded only when nothing was left for the AI merge and no pending
 * migration declares that it needs an AI session or the owner.
 */
async function applyAutoMigrations(
  pending: string[],
  instanceVersion: string,
  packageVersion: string,
  skills: SyncedSkills,
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

      const settled = settledSkillNote(entry.relPath, skills);
      if (settled) {
        if (entry.type === "file") console.log(`  ${DIM}[skip]${RESET} ${entry.relPath} (${settled})`);
        // Left out because nobody knows the skill's state is not the same as applied.
        if (entry.type === "file" && skills.mode === "blocked") skippedExisting++;
        continue;
      }

      if (isBehindDanglingLink(destPath)) {
        if (entry.type === "file") {
          console.log(`  ${YELLOW}[skip]${RESET} ${entry.relPath} (a link that leads nowhere is in the way — needs AI merge)`);
          skippedExisting++;
        }
        continue;
      }

      if (entry.type === "dir") {
        if (!isTaken(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
          console.log(`  ${GREEN}[new]${RESET} ${entry.relPath}/`);
          applied++;
        }
        continue;
      }

      if (!isTaken(destPath)) {
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

  // What --auto did above is the mechanical part. A migration that declares it needs
  // an AI session or the owner (`auto: false` in MIGRATION.md) is not done by that,
  // whether or not any of its files happened to conflict.
  const needSession = pending.filter((version) => migrationNeedsSession(version));
  if (skippedExisting > 0 || needSession.length > 0) {
    console.log(`\n${YELLOW}Auto-migration partially applied.${RESET} ${applied} file(s) added, ${configChanges} config value(s) updated, ${skippedExisting} existing file(s) need AI merge.`);
    if (needSession.length > 0) {
      console.log(`${YELLOW}These migrations need an AI session or the owner, and --auto does not complete them:${RESET} ${needSession.join(", ")}`);
    }
    if (skills.mode === "blocked") {
      // `ryoko migrate` refuses for the same reason, so it is not the next step yet.
      console.log(`${YELLOW}Version was not updated.${RESET} 同梱スキルを同期できないため、ryoko migrate もこのマイグレーションを開始しません。`);
      console.log(`  理由: ${skills.reason}`);
      console.log(`  ${skills.remedy}`);
    } else {
      console.log(`${YELLOW}Version was not updated.${RESET} Run ${RESET}ryoko migrate${YELLOW} (without --auto) to merge the skipped files and complete the migration.${RESET}`);
    }
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
