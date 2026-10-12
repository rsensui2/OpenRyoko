import fs from "node:fs";
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
}

/**
 * The record of which shipped skills the sync placed, and with what bytes. The
 * package alone says what ships now; only this says whether a skill in the home is
 * still the copy we put there, which is what makes replacing or retiring it safe.
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

/**
 * Null when there is no receipt yet (a first run). A receipt that exists but cannot
 * be trusted is refused instead: it decides what gets replaced and moved away, so it
 * must not quietly read as empty.
 */
export function readReceipt(file: string): Receipt | null {
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("it is not a regular file");
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unusable(file, error);
  }
  try {
    return parseReceipt(JSON.parse(text));
  } catch (error) {
    throw unusable(file, error);
  }
}

function unusable(file: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Cannot use ${file}: ${reason}. Fix or delete the file; deleting it only resets update tracking, `
    + "and no skill is replaced or removed without it.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Messages read as the middle of "Cannot use <file>: … ." — hence the subject "it". */
function parseReceipt(parsed: unknown): Receipt {
  if (!isRecord(parsed)) throw new Error("it is not a JSON object");
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
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) throw new Error(`its entry for "${name}/${relative}" is not a sha256`);
    return [relative, hash];
  }));
  // Every skill the sync places has one, so an entry without it was not written here.
  if (!Object.hasOwn(files, "SKILL.md")) throw new Error(`its entry for "${name}" lists no SKILL.md`);
  return receiptSkill(files, entry.version);
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));

/** Stable key order, so an unchanged receipt serializes to the same bytes. */
export function serializeReceipt(receipt: Receipt): string {
  const skills = Object.fromEntries(Object.keys(receipt.skills).sort().map((name) => {
    const { version, sha256: digest, files } = receipt.skills[name];
    return [name, { version, sha256: digest, files: sortedByKey(files) }];
  }));
  const body = { schemaVersion: SCHEMA_VERSION, packageVersion: receipt.packageVersion, skills, notices: sortedByKey(receipt.notices) };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Replace the receipt in one step: a reader sees the old file or the new one.
 * The temporary file is created exclusively, after clearing whatever sits at its
 * path, so a link left there (the name is predictable) is removed, never written through.
 */
export function writeReceipt(file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, text, { flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
