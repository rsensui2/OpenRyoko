import fs from "node:fs";
import path from "node:path";

const BYTES_PER_MB = 1024 * 1024;

/**
 * The largest attachment a connector downloads when its config does not say:
 * `connectors.<name>.maxAttachmentMb`. How large a file is, is up to whoever
 * sent it, so there has to be a limit; it is generous because people do send
 * recordings and videos, and a file over it is not delivered to the session.
 */
export const DEFAULT_MAX_ATTACHMENT_MB = 200;

/**
 * A connector's attachment limit in bytes, from its `maxAttachmentMb`. The
 * config is hand-edited YAML: anything that is not a positive number means
 * the default, not "no limit" and not "nothing at all".
 */
export function attachmentLimitBytes(maxAttachmentMb: unknown): number {
  const megabytes =
    typeof maxAttachmentMb === "number" && Number.isFinite(maxAttachmentMb) && maxAttachmentMb > 0 ? maxAttachmentMb : DEFAULT_MAX_ATTACHMENT_MB;
  return Math.floor(megabytes * BYTES_PER_MB);
}

/** `bytes` in megabytes, the way the setting is written: "200", "1.5", "0.5". */
export function megabytes(bytes: number): string {
  return String(Number((bytes / BYTES_PER_MB).toFixed(2)));
}

/** The message says how large is too large, and nothing about the file. */
export class AttachmentTooLargeError extends Error {
  /** The limit that was passed. */
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Attachment is too large (limit ${maxBytes} bytes)`);
    this.name = "AttachmentTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Remove a failed save: the partial file, and the directories that were
 * created for it. Deliberately weak tools — unlink removes one file, and a
 * non-recursive rmdir removes a directory only while it is empty — so that
 * whatever path this is handed, it cannot take anything else with it.
 */
async function discard(destPath: string, firstCreated: string | undefined): Promise<void> {
  await fs.promises.unlink(destPath).catch(() => {});
  if (firstCreated === undefined) return;
  for (let directory = path.dirname(destPath); directory.startsWith(firstCreated); directory = path.dirname(directory)) {
    try {
      await fs.promises.rmdir(directory);
    } catch {
      return; // not empty (somebody else's file is in it), or already gone
    }
    if (directory === firstCreated) return;
  }
}

/**
 * Save what `chunks` yields as the file `destPath`, refusing more than
 * `maxBytes`.
 *
 * Each chunk is written as it arrives, so no more than one chunk is held in
 * memory however large the file, and reading stops at the first chunk that
 * passes the limit — the rest is never asked for. The directory is created
 * once there is something to put in it. When the save fails, for size or for
 * any other reason, nothing is left: neither the partial file nor a directory
 * created for it.
 */
export async function saveWithin(chunks: AsyncIterable<Uint8Array>, destination: string, maxBytes: number): Promise<void> {
  const destPath = path.resolve(destination);
  let handle: fs.promises.FileHandle | undefined;
  let firstCreated: string | undefined;
  const open = async () => {
    firstCreated = await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    return fs.promises.open(destPath, "w");
  };
  try {
    let received = 0;
    for await (const chunk of chunks) {
      received += chunk.byteLength;
      if (received > maxBytes) throw new AttachmentTooLargeError(maxBytes);
      handle ??= await open();
      await handle.write(chunk);
    }
    handle ??= await open(); // an empty body is an empty file
    await handle.close();
  } catch (err) {
    await handle?.close().catch(() => {});
    await discard(destPath, firstCreated);
    throw err;
  }
}

/**
 * Save the body of an HTTP response as `destPath`, refusing more than
 * `maxBytes`. A body announced as larger is refused without being read; the
 * announcement is not trusted beyond that, and the body is counted as it is
 * read either way (see {@link saveWithin}).
 */
export async function saveResponseWithin(res: Response, destPath: string, maxBytes: number): Promise<void> {
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new AttachmentTooLargeError(maxBytes);
  }
  const body = res.body as (ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>) | null;
  await saveWithin(body ?? emptyBody(), destPath, maxBytes);
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  // nothing to yield
}
