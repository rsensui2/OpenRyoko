import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";
import { readConfigSnapshot, writeConfigDocument, writeConfigText } from "../shared/config-file.js";

/**
 * Replace ONLY the top-level `portal:` block in raw config.yaml text, leaving
 * every other line byte-identical. A whole-file `yaml.dump` round-trip strips
 * all comments — and the shipped config template is mostly guidance comments,
 * so onboarding must never rewrite the file wholesale.
 *
 * This is text surgery that knows one spelling of the block — `portal:` in
 * column 0, its entries indented under it — and regenerates the block whole.
 * Any other spelling (a quoted key, a flow mapping over several lines, an
 * anchor) is not found, and a second `portal:` is appended. Never write the
 * result unchecked: see {@link savePortalBlock}.
 */
export function patchPortalSection(raw: string, portal: Record<string, unknown>): string {
  const defined = Object.fromEntries(
    Object.entries(portal).filter(([, v]) => v !== undefined),
  );
  const rendered =
    Object.keys(defined).length === 0
      ? ["portal: {}"]
      : [
          "portal:",
          ...yaml
            .dump(defined, { lineWidth: -1 })
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => "  " + l),
        ];

  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^portal:\s*(\{.*\})?\s*(#.*)?$/.test(l));
  if (start === -1) {
    const sep = raw === "" || raw.endsWith("\n") ? "" : "\n";
    return raw + sep + rendered.join("\n") + "\n";
  }

  // The block ends at the next line that starts in column 0 (key or comment
  // introducing the next section). Blank/indented lines belong to the block.
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;

  // Keep exactly one blank line before the next section (if one follows).
  const tail = lines.slice(end);
  const spacer = tail.length > 0 && tail[0] !== "" ? [""] : [];
  return [...lines.slice(0, start), ...rendered, ...spacer, ...tail].join("\n");
}

/**
 * Apply `patch` to the portal block of config.yaml and return the block as
 * written. The base is the block on disk: the in-memory config (`running`)
 * trails the file by about a second, so two saves in a row — portal name, then
 * operator name — would otherwise have the second put the first one's value
 * back. `running` only stands in while the file has no portal block.
 *
 * Goes through the shared config writer: a config.yaml that cannot be read is
 * refused, the write is staged and renamed into place, and the file keeps its
 * permission bits.
 */
export function savePortalBlock(
  patch: Record<string, unknown>,
  running: object | undefined,
): Record<string, unknown> {
  const snapshot = readConfigSnapshot();
  const onDisk = snapshot.document.portal;
  const block = onDisk && typeof onDisk === "object" && !Array.isArray(onDisk) ? (onDisk as Record<string, unknown>) : undefined;
  const portal: Record<string, unknown> = { ...(block ?? running), ...patch };
  const document = { ...snapshot.document, portal };
  const asText = portalBlockAsText(snapshot.raw ?? "", block, portal, document);
  if (asText !== null) writeConfigText(snapshot, asText);
  else writeConfigDocument(snapshot, document);
  return portal;
}

/**
 * config.yaml with its portal block swapped in as text — but only when that
 * is known to be safe, and null otherwise (the caller then saves the document
 * through the config writer, which changes just the lines that changed).
 *
 * Two checks. Regenerating the block that is there now must give back the
 * file byte for byte: that is the one spelling {@link patchPortalSection}
 * understands, with no comment inside the block and no quoting of its own to
 * lose. And the result must load to exactly the document that was meant.
 */
function portalBlockAsText(
  raw: string,
  block: Record<string, unknown> | undefined,
  portal: Record<string, unknown>,
  document: Record<string, unknown>,
): string | null {
  if (block !== undefined && patchPortalSection(raw, block) !== raw) return null;
  const text = patchPortalSection(raw, portal);
  try {
    return isDeepStrictEqual(yaml.load(text), document) ? text : null;
  } catch {
    return null;
  }
}

/** Crash-safe replacement for a config/instruction file the gateway watches. */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
