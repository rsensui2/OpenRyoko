import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { JINN_HOME, SKILLS_DIR } from "../shared/paths.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const SKILLS_JSON = path.join(JINN_HOME, "skills.json");

/** Well-known directories where `npx skills add -g` may install skills. */
const GLOBAL_SKILL_DIRS = [
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".codex", "skills"),
];

// ── Manifest helpers ──────────────────────────────────────────────

export interface SkillManifestEntry {
  name: string;
  source: string;
  installedAt: string;
}

/** skills.json is written freely by the agent (see find-and-install), so
 *  `source` is untrusted input that later reaches `npx skills add`. Only
 *  accept the "owner/repo" / "owner/repo@skill" shapes — each segment must
 *  start alphanumeric, so `./x`, `../x`, and `.hidden/x` (local-path forms
 *  the skills CLI would resolve) are rejected. */
const SOURCE_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(@[\w.-]+)?$/;

/** POSIX spawns npx directly (argv is never shell-parsed — that is the
 *  injection boundary for agent-written sources). Windows needs a shell to
 *  resolve npx.cmd; safe there because every source is SOURCE_RE-validated. */
const NPX_SPAWN_OPTS = process.platform === "win32" ? { shell: true as const } : {};

function sanitizeSource(v: unknown): string {
  return typeof v === "string" && SOURCE_RE.test(v) ? v : "";
}

export function isValidSource(pkg: string): boolean {
  return SOURCE_RE.test(pkg);
}

/** Free-text search terms may still cross the win32 shell:true path — strip
 *  anything cmd.exe could reinterpret. Harmless for search relevance. */
export function sanitizeFindQuery(query: string): string {
  // \p{L}\p{N} keeps every script (Japanese queries included) while still
  // stripping shell metacharacters for the win32 shell:true path.
  return query.replace(/[^\p{L}\p{N}_ .@/-]+/gu, " ").replace(/\s+/g, " ").trim();
}

interface RawManifest {
  installed: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Canonical skills.json shape — must match template/skills.json and the
 *  find-and-install skill, which write `{"installed": {<name>: {...}}}`.
 *  The legacy flat-array form is still accepted on read. Fields this CLI
 *  doesn't know about (per entry or top-level) are preserved on write. */
function readRawManifest(): RawManifest {
  if (!fs.existsSync(SKILLS_JSON)) return { installed: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILLS_JSON, "utf-8"));
    if (Array.isArray(parsed)) {
      const installed = Object.fromEntries(
        parsed
          .filter((e) => !!e && typeof e.name === "string")
          .map(({ name, ...rest }) => [name, rest as Record<string, unknown>]),
      );
      return { installed };
    }
    if (
      parsed && typeof parsed === "object" &&
      parsed.installed && typeof parsed.installed === "object" &&
      !Array.isArray(parsed.installed)
    ) {
      return parsed as RawManifest;
    }
    return { installed: {} };
  } catch {
    return { installed: {} };
  }
}

function writeRawManifest(raw: RawManifest): void {
  fs.writeFileSync(SKILLS_JSON, JSON.stringify(raw, null, 2) + "\n");
}

export function readManifest(): SkillManifestEntry[] {
  return Object.entries(readRawManifest().installed).map(([name, meta]) => {
    const m = (meta ?? {}) as Record<string, unknown>;
    return {
      name,
      source: sanitizeSource(m.source),
      installedAt: typeof m.installedAt === "string" ? m.installedAt : "",
    };
  });
}

/** Full replace in canonical form. Prefer upsertManifest/removeFromManifest,
 *  which preserve fields other writers may have added. */
export function writeManifest(entries: SkillManifestEntry[]): void {
  const installed = Object.fromEntries(
    entries.map((e) => [e.name, { source: e.source, installedAt: e.installedAt }]),
  );
  writeRawManifest({ installed });
}

export function upsertManifest(name: string, source: string): void {
  const raw = readRawManifest();
  writeRawManifest({
    ...raw,
    installed: {
      ...raw.installed,
      [name]: {
        ...(raw.installed[name] ?? {}),
        source,
        installedAt: new Date().toISOString(),
      },
    },
  });
}

export function removeFromManifest(name: string): boolean {
  const raw = readRawManifest();
  if (!(name in raw.installed)) return false;
  const { [name]: _removed, ...rest } = raw.installed;
  writeRawManifest({ ...raw, installed: rest });
  return true;
}

// ── Snapshot helpers for detecting newly installed skills ─────────

export function snapshotDirs(): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  for (const dir of GLOBAL_SKILL_DIRS) {
    if (!fs.existsSync(dir)) {
      snap.set(dir, new Set());
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    snap.set(dir, new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name)));
  }
  return snap;
}

export function diffSnapshots(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): Array<{ dir: string; name: string }> {
  const newEntries: Array<{ dir: string; name: string }> = [];
  for (const [dir, afterSet] of after) {
    const beforeSet = before.get(dir) || new Set();
    for (const name of afterSet) {
      if (!beforeSet.has(name)) {
        newEntries.push({ dir, name });
      }
    }
  }
  return newEntries;
}

// ── Helpers ───────────────────────────────────────────────────────

export function extractSkillName(pkg: string): string {
  // "owner/repo@skill-name" → "skill-name"
  const atIdx = pkg.lastIndexOf("@");
  if (atIdx > 0) return pkg.slice(atIdx + 1);
  // "owner/repo" → "repo"
  const slashIdx = pkg.lastIndexOf("/");
  if (slashIdx >= 0) return pkg.slice(slashIdx + 1);
  return pkg;
}

export function findExistingSkill(name: string): { name: string; dir: string } | null {
  for (const dir of GLOBAL_SKILL_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return { name, dir: candidate };
    }
  }
  return null;
}

export function copySkillToInstance(name: string, sourceDir: string): void {
  const destDir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(destDir, { recursive: true });
  copyDirRecursive(sourceDir, destDir);
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── CLI action functions ──────────────────────────────────────────

export function skillsFind(query?: string): void {
  const args = ["skills", "find"];
  const cleaned = query ? sanitizeFindQuery(query) : "";
  if (cleaned) args.push(cleaned);
  const result = spawnSync("npx", args, {
    stdio: "inherit",
    ...NPX_SPAWN_OPTS,
  });
  process.exitCode = result.status ?? 1;
}

export function skillsAdd(pkg: string): void {
  if (!isValidSource(pkg)) {
    console.error(`${RED}source は owner/repo または owner/repo@skill 形式で指定してください: ${pkg}${RESET}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nスキルをインストール中: ${pkg}\n`);

  // Snapshot before
  const before = snapshotDirs();

  // Run npx skills add
  const result = spawnSync("npx", ["skills", "add", pkg, "-g", "-y"], {
    stdio: "inherit",
    ...NPX_SPAWN_OPTS,
  });

  if (result.status !== 0) {
    console.error(`\n${RED}スキルのインストールに失敗しました。${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Snapshot after to detect new directories
  const after = snapshotDirs();
  const newDirs = diffSnapshots(before, after);

  if (newDirs.length === 0) {
    // Skill may have been already installed globally — try to find it by name
    const skillName = extractSkillName(pkg);
    const existing = findExistingSkill(skillName);
    if (existing) {
      copySkillToInstance(existing.name, existing.dir);
      upsertManifest(existing.name, pkg);
      console.log(`\n${GREEN}スキル "${existing.name}" を ${SKILLS_DIR} に追加しました${RESET}`);
    } else {
      console.log(`\n${YELLOW}グローバルにはインストール済みですが、ディレクトリの特定に失敗しました。${RESET}`);
    }
    return;
  }

  // Copy first new directory to our skills dir
  const installed = newDirs[0];
  copySkillToInstance(installed.name, path.join(installed.dir, installed.name));
  upsertManifest(installed.name, pkg);
  console.log(`\n${GREEN}スキル "${installed.name}" を ${SKILLS_DIR} に追加しました${RESET}`);
}

export function skillsRemove(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(skillDir)) {
    console.error(`${RED}スキル "${name}" は ${SKILLS_DIR} に見つかりません${RESET}`);
    process.exitCode = 1;
    return;
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  removeFromManifest(name);
  console.log(`${GREEN}スキル "${name}" を削除しました。${RESET}`);
}

export function skillsList(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log("インストール済みスキルがありません。");
    return;
  }

  const manifest = readManifest();
  const manifestMap = new Map(manifest.map((e) => [e.name, e]));

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  if (skillDirs.length === 0) {
    console.log("インストール済みスキルがありません。");
    return;
  }

  console.log(`\n  ${DIM}${SKILLS_DIR}${RESET} のスキル\n`);
  for (const dir of skillDirs) {
    const meta = manifestMap.get(dir.name);
    const source = meta ? `${DIM}(${meta.source})${RESET}` : `${DIM}(local)${RESET}`;
    const skillMd = path.join(SKILLS_DIR, dir.name, "SKILL.md");
    let description = "";
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        if (descMatch) description = `  ${DIM}${descMatch[1].trim()}${RESET}`;
      }
    }
    console.log(`  ${GREEN}${dir.name}${RESET} ${source}${description}`);
  }
  console.log("");
}

export function skillsUpdate(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("更新対象のスキルがマニフェストにありません。");
    return;
  }

  console.log(`\n${manifest.length} 件のスキルを更新中...\n`);
  for (const entry of manifest) {
    if (!entry.source) {
      console.log(`  ${YELLOW}${entry.name}: source が不正または未記録のためスキップ${RESET}`);
      continue;
    }
    console.log(`  ${entry.name} を ${entry.source} から更新中...`);
    const before = snapshotDirs();
    const result = spawnSync("npx", ["skills", "add", entry.source, "-g", "-y"], {
      stdio: "pipe",
      ...NPX_SPAWN_OPTS,
    });

    if (result.status !== 0) {
      console.log(`  ${RED}${entry.name} の更新に失敗${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    upsertManifest(entry.name, entry.source);
    console.log(`  ${GREEN}${entry.name} を更新しました${RESET}`);
  }
  console.log("");
}

export function skillsRestore(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("復元対象のスキルがマニフェストにありません。");
    return;
  }

  console.log(`\n${manifest.length} 件のスキルを復元中...\n`);
  for (const entry of manifest) {
    const destDir = path.join(SKILLS_DIR, entry.name);
    if (fs.existsSync(destDir)) {
      console.log(`  ${DIM}${entry.name} already exists, skipping${RESET}`);
      continue;
    }

    if (!entry.source) {
      console.log(`  ${YELLOW}${entry.name}: source が不正または未記録のためスキップ${RESET}`);
      continue;
    }
    console.log(`  Installing ${entry.name} from ${entry.source}...`);
    const before = snapshotDirs();
    const result = spawnSync("npx", ["skills", "add", entry.source, "-g", "-y"], {
      stdio: "pipe",
      ...NPX_SPAWN_OPTS,
    });

    if (result.status !== 0) {
      console.log(`  ${RED}Failed to install ${entry.name}${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    console.log(`  ${GREEN}Restored ${entry.name}${RESET}`);
  }
  console.log("");
}
