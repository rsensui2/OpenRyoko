import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    /** Put a skill directly in the home, bypassing the sync. */
    place: (name: string, files: Files) => writeTree(path.join(skills, name), files),
    read: (...relative: string[]) => fs.readFileSync(path.join(skills, ...relative), "utf8"),
    receipt: () => JSON.parse(fs.readFileSync(path.join(skills, RECEIPT_FILE), "utf8")),
    /** The sync as the gateway runs it at start. */
    sync: (packageVersion = "2026.10.10", portalName = "Momo") => run(packageVersion, portalName, false),
    /** The sync as an explicit `ryoko migrate` runs it: skills the operator deleted come back. */
    migrate: (packageVersion = "2026.10.10", portalName = "Momo") => run(packageVersion, portalName, true),
  };

  function run(packageVersion: string, portalName: string, restoreDeleted: boolean) {
    return syncBundledSkills({
      templateDir: template,
      home,
      packageVersion,
      restoreDeleted,
      now: NOW,
      replacements: { "{{portalName}}": portalName, "{{portalSlug}}": portalName.toLowerCase() },
    });
  }
}

export function removeFixtures(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
