// Self-contained on purpose: scripts/generate-bundled-skill-history.mjs imports this
// file directly (Node strips the types), so the generator and the sync can never
// disagree about what a fingerprint means. Keep it free of relative imports and of
// TypeScript syntax that needs compiling (enums, namespaces, parameter properties).
import crypto from "node:crypto";

/** The placeholders `ryoko setup` fills in, and the files it fills them in.
 *  A test holds both in step with shared/templateReplacements.ts. */
export const PLACEHOLDERS: readonly string[] = ["{{portalName}}", "{{portalSlug}}"];
const TEMPLATE_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".yaml", ".yml"]);

/**
 * How one file of an earlier shipped skill is recognised without keeping its text.
 *
 * A file the installer copies as is has one hash. A template with placeholders was
 * written differently into every home, so it is split by line: the lines that carry
 * a placeholder are kept verbatim (`slots`, by zero-based line number) and every
 * other line is covered by `masked`, the hash of the file with those lines blanked.
 */
export type FileFingerprint =
  | { sha256: string }
  | { lines: number; masked: string; slots: Record<string, string> };

export function isTemplatePath(relativePath: string): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && TEMPLATE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDERS.some((placeholder) => text.includes(placeholder));
}

const sha256 = (value: Buffer | string): string => crypto.createHash("sha256").update(value).digest("hex");

/** The text, or null when the bytes are not exactly its UTF-8 encoding. A lossy
 *  decode would let two different files compare equal. */
function decodeExactly(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

function blankSlots(lines: readonly string[], slots: Record<string, string>): string {
  return lines.map((line, index) => (Object.hasOwn(slots, String(index)) ? "" : line)).join("\n");
}

export function fingerprintFile(relativePath: string, bytes: Buffer): FileFingerprint {
  const text = isTemplatePath(relativePath) ? decodeExactly(bytes) : null;
  if (text === null || !hasPlaceholder(text)) return { sha256: sha256(bytes) };
  const lines = text.split("\n");
  const slots = Object.fromEntries(lines.flatMap((line, index) => (hasPlaceholder(line) ? [[String(index), line]] : [])));
  return { lines: lines.length, masked: sha256(blankSlots(lines, slots)), slots };
}

/**
 * Is `bytes` this file, as the installer would have written it? `render` fills the
 * placeholders of one template line the way the installer does for the whole file;
 * that is the same thing, because no placeholder and no value spans a line.
 *
 * Every line without a placeholder must hash exactly, and every line with one must
 * equal its rendering character for character. Nothing is matched loosely: a home
 * copy that differs in any other way is not this file.
 */
export function matchesFingerprint(fingerprint: FileFingerprint, bytes: Buffer, render: (templateLine: string) => string): boolean {
  if ("sha256" in fingerprint) return sha256(bytes) === fingerprint.sha256;
  const text = decodeExactly(bytes);
  if (text === null) return false;
  const lines = text.split("\n");
  if (lines.length !== fingerprint.lines) return false;
  if (sha256(blankSlots(lines, fingerprint.slots)) !== fingerprint.masked) return false;
  return Object.entries(fingerprint.slots).every(([index, templateLine]) => lines[Number(index)] === render(templateLine));
}
