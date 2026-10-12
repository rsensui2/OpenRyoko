import crypto from "node:crypto";
import fs from "node:fs";
import { MAX_RECEIPT_BYTES, readBounded } from "./bounded-read.js";
import { sha256 } from "./bundled.js";
import { assertSkillFilePath, assertSkillName } from "./names.js";

/** Lives inside skills/, next to the directories it describes. */
export const RECEIPT_FILE = ".shipped-skills.json";

const SCHEMA_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ReceiptSkill {
  /** The package version that placed (or adopted) this content. */
  version: string;
  /** One digest for the whole skill, derived from `files`. */
  sha256: string;
  /** "/"-separated path inside the skill → sha256 of the file as it was placed. */
  files: Record<string, string>;
  /** A tombstone: the sync placed this skill and later found it gone, so the
   *  operator removed it. `files` still says what was placed, in case it returns. */
  deleted?: true;
  /**
   * Written before a replacement starts and cleared when it is over. Replacing a
   * skill moves the old copy away and the new one in, and for a moment between the
   * two there is no skill. If the process dies there, this mark is what tells the
   * next run that the skill is missing by the sync's doing, not the operator's.
   */
  replacing?: true;
}

/**
 * The record of which shipped skills the sync placed, and with what bytes. The
 * package alone says what ships now; only this says whether a skill in the home is
 * still the copy we put there, which is what makes replacing or retiring it safe —
 * and whether a missing skill is one the operator deleted or one never installed.
 */
export interface Receipt {
  /** The package version that last synced this home. */
  packageVersion: string;
  skills: Record<string, ReceiptSkill>;
  /** Skill → package version for which its "left untouched" notice was given. */
  notices: Record<string, string>;
}

export function skillDigest(files: Record<string, string>): string {
  return sha256(Object.keys(files).sort().map((relative) => `${relative}\0${files[relative]}\n`).join(""));
}

export function receiptSkill(files: Record<string, string>, version: string): ReceiptSkill {
  return { version, sha256: skillDigest(files), files };
}

/** The same record with or without its tombstone. */
export function markDeleted(skill: ReceiptSkill, deleted: boolean): ReceiptSkill {
  const { deleted: _mark, ...placed } = skill;
  return deleted ? { ...placed, deleted: true } : placed;
}

/** The same record with or without the mark of a replacement in progress. */
export function markReplacing(skill: ReceiptSkill, replacing: boolean): ReceiptSkill {
  const { replacing: _mark, ...settled } = skill;
  return replacing ? { ...settled, replacing: true } : settled;
}

/**
 * Null when there is no receipt yet (a first run). A receipt that exists but cannot
 * be trusted is refused instead: it decides what gets replaced and moved away, so it
 * must not quietly read as empty.
 */
export function readReceipt(file: string): Receipt | null {
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("it is not a regular file");
    // Bounded before it is parsed: a receipt bloated to exhaust the heap would abort
    // the process at start-up, and nothing can catch that.
    text = readBounded(file, MAX_RECEIPT_BYTES).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unusable(file, error);
  }
  try {
    return parseReceipt(JSON.parse(text));
  } catch (error) {
    if (error instanceof NewerReceiptFormat) throw error;
    throw unusable(file, error);
  }
}

/** The receipt is in a format a later OpenRyoko introduced. Not damage: this one
 *  simply cannot read it, and leaves the home to the release that can. */
export class NewerReceiptFormat extends Error {
  constructor(readonly format: number) {
    super(`it uses format ${format}, newer than the format ${SCHEMA_VERSION} this OpenRyoko reads`);
  }
}

function unusable(file: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Cannot use ${file}: ${reason}. Fix the file, or delete it. Deleting it forgets what the sync placed and which `
    + "bundled skills you deleted: on the next run the skills you deleted come back, skills matching a shipped version "
    + "are tracked again, and everything else is left alone.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Messages read as the middle of "Cannot use <file>: … ." — hence the subject "it". */
function parseReceipt(parsed: unknown): Receipt {
  if (!isRecord(parsed)) throw new Error("it is not a JSON object");
  const format = parsed.schemaVersion;
  if (typeof format === "number" && Number.isInteger(format) && format > SCHEMA_VERSION) throw new NewerReceiptFormat(format);
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`it uses format ${JSON.stringify(parsed.schemaVersion)}, and this OpenRyoko reads format ${SCHEMA_VERSION}`);
  }
  if (typeof parsed.packageVersion !== "string") throw new Error('its "packageVersion" is not a string');
  if (!isRecord(parsed.skills)) throw new Error('its "skills" is not an object');
  const notices = parsed.notices ?? {};
  if (!isRecord(notices)) throw new Error('its "notices" is not an object');
  return {
    packageVersion: parsed.packageVersion,
    skills: Object.fromEntries(Object.entries(parsed.skills).map(([name, entry]) => [name, parseSkill(name, entry)])),
    notices: Object.fromEntries(Object.entries(notices).map(([name, version]) => {
      assertSkillName(name, "it");
      if (typeof version !== "string") throw new Error(`its notice for "${name}" is not a version string`);
      return [name, version];
    })),
  };
}

function parseSkill(name: string, entry: unknown): ReceiptSkill {
  assertSkillName(name, "it");
  if (!isRecord(entry) || typeof entry.version !== "string" || !isRecord(entry.files)) {
    throw new Error(`its entry for "${name}" needs a "version" and a "files" object`);
  }
  const files = Object.fromEntries(Object.entries(entry.files).map(([relative, hash]) => {
    assertSkillFilePath(relative, "it");
    // Quoted: the path is whatever the file says, and a newline or an escape sequence
    // in it would otherwise land in the log as a line of its own.
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) throw new Error(`its entry for ${JSON.stringify(`${name}/${relative}`)} is not a sha256`);
    return [relative, hash];
  }));
  // Every skill the sync places has one, so an entry without it was not written here.
  if (!Object.hasOwn(files, "SKILL.md")) throw new Error(`its entry for "${name}" lists no SKILL.md`);
  for (const mark of ["deleted", "replacing"] as const) {
    if (entry[mark] !== undefined && entry[mark] !== true) throw new Error(`its "${mark}" mark for "${name}" is not true`);
  }
  return markReplacing(markDeleted(receiptSkill(files, entry.version), entry.deleted === true), entry.replacing === true);
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));

/** Stable key order, so an unchanged receipt serializes to the same bytes. */
export function serializeReceipt(receipt: Receipt): string {
  const skills = Object.fromEntries(Object.keys(receipt.skills).sort().map((name) => {
    const { version, sha256: digest, files, deleted, replacing } = receipt.skills[name];
    return [name, { version, sha256: digest, ...(deleted ? { deleted } : {}), ...(replacing ? { replacing } : {}), files: sortedByKey(files) }];
  }));
  const body = { schemaVersion: SCHEMA_VERSION, packageVersion: receipt.packageVersion, skills, notices: sortedByKey(receipt.notices) };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Replace the receipt in one step: a reader sees the old file or the new one.
 * The temporary file has a random name and is created exclusively, so nothing can be
 * waiting at its path — not a link to write through, not a directory to make the
 * save fail. Only a file this call created is ever removed.
 */
export function writeReceipt(file: string, text: string): void {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, text, { flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
