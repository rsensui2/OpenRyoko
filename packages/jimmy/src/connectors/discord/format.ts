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
  /** When set, a larger file is refused and nothing is written. */
  maxBytes?: number;
}

/**
 * The file name an attachment may be saved under: the last segment of the name
 * it arrived with, or null when that names no file. The name comes from
 * another machine, so both separators count and `..` never survives.
 */
export function safeAttachmentName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  if (base === "" || base === "." || base === ".." || /[\u0000-\u001f]/.test(base)) return null;
  return base;
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

/** The response body, refusing one larger than `maxBytes` — by its announced
 *  size where there is one, and by count while reading either way. */
async function readAttachmentBody(res: Response, maxBytes: number | undefined): Promise<Buffer> {
  if (maxBytes === undefined) return Buffer.from(await res.arrayBuffer());
  const tooLarge = new Error(`Attachment is too large (limit ${maxBytes} bytes)`);
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Download an attachment into `destDir` and return where it was saved. The
 * file always lands directly inside `destDir`, whatever `filename` says.
 * `destDir` is created once there is something to save in it.
 */
export async function downloadAttachment(
  url: string,
  destDir: string,
  filename: string,
  options: DownloadAttachmentOptions = {},
): Promise<string> {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const name = safeAttachmentName(filename);
  const directory = path.resolve(destDir);
  const destPath = name === null ? null : path.join(directory, name);
  if (destPath === null || path.dirname(destPath) !== directory) {
    throw new Error("Unusable attachment name");
  }
  if (options.allowedHosts) assertAllowedUrl(url, options.allowedHosts);
  const res = options.allowedHosts ? await fetch(url, { redirect: "error" }) : await fetch(url);
  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
  const body = await readAttachmentBody(res, options.maxBytes);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(destPath, body);
  return destPath;
}
