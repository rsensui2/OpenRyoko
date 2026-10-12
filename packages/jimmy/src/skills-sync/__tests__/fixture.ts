import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintFile, type FileFingerprint } from "../fingerprint.js";
import { HISTORY_FILE } from "../history.js";
import { RECEIPT_FILE } from "../receipt.js";
import { syncBundledSkills } from "../sync.js";

export type Files = Record<string, string | Buffer>;

/** Every sync in a fixture runs at this instant, so backup directory names are predictable. */
export const NOW = new Date("2026-10-12T03:04:05.678Z");
export const STAMP = "2026-10-12T03-04-05-678Z";

export const sha = (content: string | Buffer): string => crypto.createHash("sha256").update(content).digest("hex");

/** Replace `dir` with exactly these files. */
export function writeTree(dir: string, files: Files): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** Every entry under `dir`, in enough detail to prove that nothing was touched:
 *  file content and mtime, link targets, and the directories themselves. */
export function snapshot(dir: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const key = path.relative(dir, full);
      if (stat.isSymbolicLink()) seen[key] = `link:${fs.readlinkSync(full)}`;
      else if (stat.isDirectory()) { seen[key] = "dir"; walk(full); }
      else seen[key] = `file:${sha(fs.readFileSync(full))}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return seen;
}

const roots: string[] = [];

/** A throwaway package template and instance home. Nothing here touches a real home. */
export function fixture() {
  // realpath: os.tmpdir() sits behind a symlink on macOS, and the sync reports real paths.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-skills-sync-")));
  roots.push(root);
  const template = path.join(root, "template");
  const home = path.join(root, "instance");
  const skills = path.join(home, "skills");
  fs.mkdirSync(path.join(template, "skills"), { recursive: true });
  fs.mkdirSync(home);
  return {
    root, template, home, skills,
    backups: path.join(home, ".migration-backups"),
    /** Put a skill in the package (replacing any earlier version of it). */
    ship: (name: string, files: Files) => writeTree(path.join(template, "skills", name), files),
    /** Drop a skill from the package, as a release that retires it would. */
    unship: (name: string) => fs.rmSync(path.join(template, "skills", name), { recursive: true, force: true }),
    /** Cut a release: record every skill the package ships right now in its history of
     *  past versions, as the generator does for a release tag. */
    release: (tag = "v-test") => recordRelease(template, tag),
    /** Put a skill directly in the home, bypassing the sync. */
    place: (name: string, files: Files) => writeTree(path.join(skills, name), files),
    read: (...relative: string[]) => fs.readFileSync(path.join(skills, ...relative), "utf8"),
    receipt: () => JSON.parse(fs.readFileSync(path.join(skills, RECEIPT_FILE), "utf8")),
    /** The sync as gateway start and a plain `ryoko migrate` run it. */
    sync: (packageVersion = "2026.10.10", portalName = "Momo") => run(packageVersion, portalName, false),
    /** The sync as `ryoko migrate --restore-deleted-skills` runs it: deleted skills come back. */
    restore: (packageVersion = "2026.10.10", portalName = "Momo") => run(packageVersion, portalName, true),
    /** The same with names: `ryoko migrate --restore-deleted-skills <name>...` */
    restoreOnly: (names: string[], packageVersion = "2026.10.10") => run(packageVersion, "Momo", names),
  };

  function run(packageVersion: string, portalName: string, restoreDeleted: boolean | string[]) {
    return syncBundledSkills({
      templateDir: template,
      home,
      packageVersion,
      restoreDeleted,
      now: NOW,
      replacements: { "{{portalName}}": portalName, "{{portalSlug}}": portalName.toLowerCase() },
      // The names `ryoko setup` falls back to when nobody chooses one.
      legacyPortalNames: ["Ryoko"],
    });
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  });
}

function recordRelease(template: string, since: string): void {
  const file = path.join(template, HISTORY_FILE);
  const history: { schemaVersion: 1; source: string; names: string[]; skills: Record<string, { since: string; files: Record<string, FileFingerprint> }[]> } =
    fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1, source: "test fixture", names: [], skills: {} };
  for (const name of fs.readdirSync(path.join(template, "skills")).sort()) {
    const root = path.join(template, "skills", name);
    const files = Object.fromEntries(listFiles(root).sort().map((relative) => [relative, fingerprintFile(relative, fs.readFileSync(path.join(root, relative)))]));
    history.skills[name] = [...(history.skills[name] ?? []), { since, files }];
    if (!history.names.includes(name)) history.names.push(name);
  }
  fs.writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`);
}

export function removeFixtures(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
