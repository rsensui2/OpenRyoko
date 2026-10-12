import { AttachmentTooLargeError, megabytes } from "./attachment-download.js";

/**
 * How a connector names an attachment it did not retrieve: `what` — a label of
 * the connector's own making, an opaque ID or a position, never the file's
 * name — and the reason, when the reason is the file's size. Any other error
 * is left out: its message may quote a URL or the name.
 */
export function failedAttachment(what: string, err: unknown): string {
  return err instanceof AttachmentTooLargeError ? `${what} (larger than the ${megabytes(err.maxBytes)} MB attachment limit)` : what;
}

/**
 * What a connector appends to a message whose attachments did not all arrive.
 *
 * Keep attachment failures visible to the engine. Silently dropping a file can
 * make a content-dependent task continue with invented or unrelated input —
 * and with a size limit in force, "silently dropped" is what would happen to
 * every large video. `failed` holds labels from {@link failedAttachment}: the
 * notice is the connector's own text, with nothing of the sender's in it.
 */
export function attachmentFailureNotice(platform: string, failed: readonly string[]): string {
  if (failed.length === 0) return "";
  return (
    `\n\n[System attachment notice: The following ${platform} attachment(s) could not be retrieved: ` +
    `${failed.join(", ")}. Do not infer or substitute their contents. ` +
    "Explain that the attachment could not be read, and why where a reason is given, before doing any content-dependent work.]"
  );
}

/**
 * `text` with the notice for `failed` appended. A slash command is passed on
 * exactly as typed — the session manager matches it by its text, and a command
 * reads no attachment anyway — and so is anything that is not text.
 */
export function withAttachmentNotice<T>(text: T, platform: string, failed: readonly string[]): T | string {
  if (typeof text !== "string" || text.trimStart().startsWith("/")) return text;
  return text + attachmentFailureNotice(platform, failed);
}
