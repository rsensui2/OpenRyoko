import { safeAttachmentName } from "../../shared/safe-file-name.js";

// Lives in shared/: the upload route applies the same rule to its file names.
export { safeAttachmentName };

const DISCORD_MAX_LENGTH = 2000;

export function formatResponse(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    if (cutAt <= 0) cutAt = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

export interface DownloadAttachmentOptions {
  /** When set, only an https URL on exactly one of these hosts is fetched, and
   *  a redirect is an error (it could lead anywhere). */
  allowedHosts?: readonly string[];
  /** A larger file is refused and nothing is left on disk. Default: 50 MB. */
  maxBytes?: number;
}

/** Throws unless `url` is an https URL on one of `allowedHosts`. The message
 *  never quotes the URL: a CDN link carries its signature in the query. */
function assertAllowedUrl(url: string, allowedHosts: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Attachment URL is not a valid URL");
  }
  const plainHttps = parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "";
  if (!plainHttps || !allowedHosts.includes(parsed.hostname)) {
    throw new Error("Attachment URL is not an https URL on an allowed host");
  }
}

/**
 * Download an attachment into `destDir` and return where it was saved. The
 * file always lands directly inside `destDir`, whatever `filename` says.
 * `destDir` is created once there is something to save in it, and the file is
 * written as it arrives, up to a size limit (see shared/attachment-download.ts).
 */
export async function downloadAttachment(
  url: string,
  destDir: string,
  filename: string,
  options: DownloadAttachmentOptions = {},
): Promise<string> {
  const { default: path } = await import("node:path");
  const { MAX_ATTACHMENT_BYTES, saveResponseWithin } = await import("../../shared/attachment-download.js");
  const name = safeAttachmentName(filename);
  const directory = path.resolve(destDir);
  const destPath = name === null ? null : path.join(directory, name);
  if (destPath === null || path.dirname(destPath) !== directory) {
    throw new Error("Unusable attachment name");
  }
  if (options.allowedHosts) assertAllowedUrl(url, options.allowedHosts);
  const res = options.allowedHosts ? await fetch(url, { redirect: "error" }) : await fetch(url);
  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
  await saveResponseWithin(res, destPath, options.maxBytes ?? MAX_ATTACHMENT_BYTES);
  return destPath;
}
