import fs from "node:fs";
import yaml from "js-yaml";
import { readConfigSnapshot, writeConfigText } from "../shared/config-file.js";

/**
 * Replace ONLY the top-level `portal:` block in raw config.yaml text, leaving
 * every other line byte-identical. A whole-file `yaml.dump` round-trip strips
 * all comments — and the shipped config template is mostly guidance comments,
 * so onboarding must never rewrite the file wholesale.
 *
 * Known limitation: comments INSIDE the portal block itself are regenerated
 * away. The shipped template keeps that block comment-free, so nothing is
 * lost in practice; keep it that way when editing the template.
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
  const current = onDisk && typeof onDisk === "object" && !Array.isArray(onDisk) ? onDisk : running;
  const portal: Record<string, unknown> = { ...current, ...patch };
  writeConfigText(snapshot, patchPortalSection(snapshot.raw ?? "", portal));
  return portal;
}

/** Crash-safe replacement for a config/instruction file the gateway watches. */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
