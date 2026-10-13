import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { TEMPLATE_MIGRATIONS_DIR } from "../shared/paths.js";

const OPENS_FRONT_MATTER = /^﻿?---\r?\n/;
const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Does this MIGRATION.md declare, in its front matter, that the migration needs an AI
 * session or the owner?
 *
 *     ---
 *     auto: false
 *     ---
 *
 * `ryoko migrate --auto` copies new files and applies config patches; it does not read
 * the prose. A migration whose prose asks for a merge, a confirmation or the owner's
 * consent has to say so in a form a program can read, or `--auto` records it as applied
 * with that part never done.
 *
 * Anything short of a clear "this is fine" counts as the declaration: a value other
 * than `true`, or front matter that does not parse. Holding a migration back wrongly
 * costs one `ryoko migrate`; passing one wrongly means it is never applied.
 */
export function declaresSessionNeeded(migrationMd: string): boolean {
  if (!OPENS_FRONT_MATTER.test(migrationMd)) return false;
  const front = FRONT_MATTER.exec(migrationMd);
  if (!front) return true;
  try {
    const declared = yaml.load(front[1]);
    if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return true;
    return "auto" in declared && (declared as { auto: unknown }).auto !== true;
  } catch {
    return true;
  }
}

/**
 * Whether the migration for `version` needs an AI session or the owner. Read from the
 * package, not from the copy staged in the home: the answer is the release's to give.
 */
export function migrationNeedsSession(version: string, migrationsDir: string = TEMPLATE_MIGRATIONS_DIR): boolean {
  let text: unknown;
  try { text = fs.readFileSync(path.join(migrationsDir, version, "MIGRATION.md"), "utf-8"); }
  catch { return false; }
  return typeof text === "string" && declaresSessionNeeded(text);
}
