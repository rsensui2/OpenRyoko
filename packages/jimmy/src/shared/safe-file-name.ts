/**
 * The file name something from outside may be saved under: the last segment
 * of the name it arrived with, or null when that names no file. The name is
 * somebody else's text — a Discord user's, a routed request's, an upload's —
 * so both separators count and `..` never survives. Whoever saves the file
 * joins this onto a directory of its own choosing and nothing else.
 */
export function safeAttachmentName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  if (base === "" || base === "." || base === ".." || /[\u0000-\u001f]/.test(base)) return null;
  return base;
}
