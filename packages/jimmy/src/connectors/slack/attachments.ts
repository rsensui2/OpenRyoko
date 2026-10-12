import { logger } from "../../shared/logger.js";
import type { Attachment } from "../../shared/types.js";
import { downloadAttachment, resolveSlackFileAttachment, type SlackFileLike } from "./format.js";

export interface FetchedSlackFiles {
  attachments: Attachment[];
  /** One label per file that could not be fetched: Slack's opaque file ID,
   *  never the name — that is the poster's text, and this ends up in a prompt. */
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
  client: { token: string; filesInfo: Parameters<typeof resolveSlackFileAttachment>[1] },
  destDir: string,
): Promise<FetchedSlackFiles> {
  const attachments: Attachment[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      const resolved = await resolveSlackFileAttachment(file, client.filesInfo);
      const localPath = await downloadAttachment(resolved.url, client.token, destDir);
      attachments.push({ name: resolved.name, url: resolved.url, mimeType: resolved.mimeType, localPath });
    } catch (err) {
      const label = file.id ? `Slack file ${file.id}` : "Slack attachment";
      failed.push(label);
      logger.warn(`[slack] Failed to retrieve attachment ${label}: ${err}`);
    }
  }
  return { attachments, failed };
}
