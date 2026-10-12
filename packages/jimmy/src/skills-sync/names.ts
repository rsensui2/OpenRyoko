/** Finder and git leave these behind. They are never part of a skill's content, so
 *  they neither get installed nor make an unmodified skill look edited. */
const HOUSEKEEPING_FILES = new Set([".DS_Store", ".gitkeep"]);

export function isHousekeepingFile(name: string): boolean {
  return HOUSEKEEPING_FILES.has(name);
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A skill name is one directory name directly under skills/. Names reach the sync
 * from the package and from the receipt — a file in the instance home that anyone
 * can edit — and each is joined to a path that may be moved, so every name is
 * checked first. The leading character rules out ".", "..", and hidden directories.
 */
export function assertSkillName(name: unknown, origin: string): asserts name is string {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    throw new Error(`${origin} names a skill that is not a plain directory name: ${JSON.stringify(name)}`);
  }
}

/** File paths inside a skill are written with "/" and never leave the skill. */
export function assertSkillFilePath(relative: unknown, origin: string): asserts relative is string {
  const contained = typeof relative === "string"
    && relative.length > 0
    && !relative.includes("\0")
    && !relative.includes("\\")
    && relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!contained) {
    throw new Error(`${origin} lists a file path that does not stay inside its skill: ${JSON.stringify(relative)}`);
  }
}

/**
 * Text that came from the home — a path, a file name inside an fs error — made safe
 * to put in a log line or on a terminal. A newline there would pass for a line of its
 * own, and an escape sequence could redraw what is already on screen.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Own-property lookup: skill and file names are data, and "constructor" is a legal one. */
export function own<T>(record: Record<string, T> | null | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
