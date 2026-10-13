import { AttachmentTooLargeError } from "../../shared/attachment-download.js";
import { failedAttachment } from "../../shared/attachment-notice.js";
import { attachmentSlot } from "../../shared/attachments.js";
import { logger } from "../../shared/logger.js";
import type { Attachment } from "../../shared/types.js";
import { downloadAttachment } from "./format.js";

/** What discord.js tells about an attachment, as far as it is used here. */
export interface DiscordFile {
  name: string;
  url: string;
  contentType?: string | null;
  /** Size in bytes, as Discord reports it. */
  size?: number;
}

export interface FetchedDiscordFiles {
  attachments: Attachment[];
  /** One label per attachment that was not fetched: its position in the
   *  message — never its name, which is the sender's text and ends up in a
   *  prompt — and the reason, when the reason is its size. */
  failed: string[];
}

/**
 * Fetch the attachments of one Discord message into `destDir`, the message's
 * own directory, each in a slot of its own (two files of one message can share
 * a name). One Discord already reports as larger than `maxBytes` is not asked
 * for. An attachment that is not fetched, for size or any other reason, is
 * reported rather than dropped: the session has to know it is missing.
 */
export async function fetchDiscordFiles(files: readonly DiscordFile[], destDir: string, maxBytes: number): Promise<FetchedDiscordFiles> {
  const results = await Promise.all(
    files.map(async (file, slot): Promise<Attachment | string> => {
      const label = `attachment ${slot + 1} of ${files.length}`;
      try {
        if (typeof file.size === "number" && file.size > maxBytes) throw new AttachmentTooLargeError(maxBytes);
        const localPath = await downloadAttachment(file.url, attachmentSlot(destDir, slot), file.name, { maxBytes });
        return { name: file.name, url: "", mimeType: file.contentType ?? "application/octet-stream", localPath };
      } catch (err) {
        // Not the URL, and not the error of a failed request, which may quote it: a CDN link carries its signature.
        logger.warn(`[discord] Failed to retrieve ${label}: ${err instanceof AttachmentTooLargeError ? err.message : "download failed"}`);
        return failedAttachment(label, err);
      }
    }),
  );
  return {
    attachments: results.filter((result): result is Attachment => typeof result !== "string"),
    failed: results.filter((result): result is string => typeof result === "string"),
  };
}
