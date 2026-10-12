import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyTemplateReplacements, isTemplateFile } from "../shared/templateReplacements.js";
import { assertSkillFilePath, assertSkillName, isHousekeepingFile } from "./names.js";

export interface BundledFile {
  /** What gets installed: the packaged file with this instance's placeholders filled in. */
  bytes: Buffer;
  sha256: string;
  /** Hash of the file exactly as packaged. A migration applied by an AI copies files
   *  without filling placeholders, and such a copy is still an unmodified one. */
  rawSha256: string;
  mode: number;
}

export interface BundledSkill {
  name: string;
  /** Keyed by "/"-separated path inside the skill. */
  files: Record<string, BundledFile>;
  directories: string[];
}

export function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read every skill the package ships, rendered the way setup would install it.
 * A directory without SKILL.md is not a skill. Anything that is not a plain file
 * or directory inside a skill is a packaging error and refuses the whole load.
 */
export function loadBundledSkills(templateDir: string, replacements: Record<string, string>): BundledSkill[] {
  const root = path.join(templateDir, "skills");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort()
    .map((name) => loadBundledSkill(root, name, replacements));
}

function loadBundledSkill(root: string, name: string, replacements: Record<string, string>): BundledSkill {
  assertSkillName(name, "The package");
  const files: Record<string, BundledFile> = {};
  const directories: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        directories.push(relative);
        walk(full, relative);
      } else if (!stat.isFile()) {
        throw new Error(`The package's skill "${name}" carries ${relative}, which is not a regular file`);
      } else if (!isHousekeepingFile(entry)) {
        assertSkillFilePath(relative, `The package's skill "${name}"`);
        files[relative] = bundledFile(full, entry, stat.mode, replacements);
      }
    }
  };
  walk(path.join(root, name), "");
  if (!Object.hasOwn(files, "SKILL.md")) throw new Error(`The package's skill "${name}" has no SKILL.md file`);
  return { name, files, directories };
}

function bundledFile(file: string, name: string, mode: number, replacements: Record<string, string>): BundledFile {
  const raw = fs.readFileSync(file);
  const bytes = isTemplateFile(name)
    ? Buffer.from(applyTemplateReplacements(raw.toString("utf8"), replacements), "utf8")
    : raw;
  return { bytes, sha256: sha256(bytes), rawSha256: sha256(raw), mode: mode & 0o777 };
}
