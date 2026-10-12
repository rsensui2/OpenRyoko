import { attachmentLimitBytes } from "../../shared/attachment-download.js";
import { failedAttachment } from "../../shared/attachment-notice.js";
import { logger } from "../../shared/logger.js";
import type { Attachment } from "../../shared/types.js";
import { downloadAttachment, resolveSlackFileAttachment, type SlackFileLike } from "./format.js";

export interface FetchedSlackFiles {
  attachments: Attachment[];
  /** One label per file that could not be fetched: Slack's opaque file ID —
   *  never the name, which is the poster's text and ends up in a prompt — and
   *  the reason, when the reason is the file's size. */
  failed: string[];
}

/**
 * Fetch the files of one Slack message into `destDir`, the message's own
 * directory, one after another.
 *
 * The connector calls this once the message is going to be answered, not when
 * it arrives. In a channel most messages are not for the bot — the triage
 * says "silent" or "react" and no turn runs — and fetching first meant every
 * file anyone posted there was downloaded and then left on disk.
 */
export async function fetchSlackFiles(
  files: readonly SlackFileLike[],
  client: {
    token: string;
    filesInfo: Parameters<typeof resolveSlackFileAttachment>[1];
    /** The connector's attachment limit; the default one when left out. */
    maxBytes?: number;
  },
  destDir: string,
): Promise<FetchedSlackFiles> {
  const attachments: Attachment[] = [];
  const failed: string[] = [];
  const maxBytes = client.maxBytes ?? attachmentLimitBytes(undefined);
  for (const file of files) {
    try {
      const resolved = await resolveSlackFileAttachment(file, client.filesInfo);
      const localPath = await downloadAttachment(resolved.url, client.token, destDir, maxBytes);
      attachments.push({ name: resolved.name, url: resolved.url, mimeType: resolved.mimeType, localPath });
    } catch (err) {
      const label = file.id ? `Slack file ${file.id}` : "Slack attachment";
      failed.push(failedAttachment(label, err));
      logger.warn(`[slack] Failed to retrieve attachment ${label}: ${err}`);
    }
  }
  return { attachments, failed };
}
