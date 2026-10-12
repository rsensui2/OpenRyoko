import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyTemplateReplacements, isTemplateFile } from "../shared/templateReplacements.js";
import { MAX_SKILL_BYTES, MAX_SKILL_ENTRIES, MAX_SKILL_FILE_BYTES } from "./bounded-read.js";
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

/** The sha256 of every file of the skill, as it is once installed. */
export function shippedHashes(skill: BundledSkill): Record<string, string> {
  return Object.fromEntries(Object.entries(skill.files).map(([relative, file]) => [relative, file.sha256]));
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
  let entries = 0;
  let bytes = 0;
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.lstatSync(full);
      if (stat.isFile() && !isHousekeepingFile(entry)) bytes += stat.size;
      // The sync refuses to read a home copy beyond these limits, so a shipped skill
      // beyond them could never be recognised once installed.
      if (++entries > MAX_SKILL_ENTRIES || (stat.isFile() && stat.size > MAX_SKILL_FILE_BYTES) || bytes > MAX_SKILL_BYTES) {
        throw new Error(`The package's skill "${name}" is larger than a skill may be, at ${relative}`);
      }
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
