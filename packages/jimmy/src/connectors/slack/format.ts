import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SLACK_MAX_LENGTH = 3000;

export interface SlackFileLike {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  file_access?: string;
  url_private?: string;
  url_private_download?: string;
}

export interface ResolvedSlackFileAttachment {
  id?: string;
  name: string;
  mimeType: string;
  url: string;
}

type FilesInfo = (args: { file: string }) => Promise<{
  ok?: boolean;
  error?: string;
  file?: SlackFileLike;
}>;

/**
 * Slack Events API may send an ID-only file object with
 * `file_access: "check_file_info"`. Hydrate those events before downloading.
 */
export async function resolveSlackFileAttachment(
  eventFile: SlackFileLike,
  filesInfo: FilesInfo,
): Promise<ResolvedSlackFileAttachment> {
  let file = eventFile;
  let url = file.url_private_download || file.url_private;

  if (!url) {
    if (!file.id) {
      throw new Error("Slack attachment has neither a download URL nor a file ID");
    }

    const result = await filesInfo({ file: file.id });
    if (!result.file) {
      const detail = result.error ? `: ${result.error}` : "";
      throw new Error(`Slack files.info returned no metadata for ${file.id}${detail}`);
    }

    file = { ...eventFile, ...result.file };
    url = file.url_private_download || file.url_private;
    if (!url) {
      throw new Error(`Slack file ${file.id} has no private download URL after files.info`);
    }
  }

  return {
    id: file.id,
    name: file.name || file.title || file.id || "slack-attachment",
    mimeType: file.mimetype || "application/octet-stream",
    url,
  };
}

/**
 * Keep attachment failures visible to the engine. Silently dropping a file can
 * make a content-dependent task continue with invented or unrelated input.
 */
export function formatAttachmentFailureNotice(failedAttachments: string[]): string {
  if (failedAttachments.length === 0) return "";

  return (
    "\n\n[System attachment notice: The following Slack attachment(s) could not be retrieved: " +
    `${failedAttachments.join(", ")}. Do not infer or substitute their contents. ` +
    "Explain that the attachment could not be read before doing any content-dependent work.]"
  );
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Handles headings, bold, strikethrough, links, and bullet lists.
 * Preserves code blocks and inline code untouched.
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Split text into code and non-code segments to protect code from conversion
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return segments
    .map((segment, i) => {
      // Odd indices are code matches — leave them untouched
      if (i % 2 === 1) return segment;

      return (
        segment
          // Headings: ## text → *text* (must be at start of line)
          .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `*${content}*`)
          // Bold: **text** or __text__ → *text*
          .replace(/\*\*(.+?)\*\*/g, "*$1*")
          .replace(/__(.+?)__/g, "*$1*")
          // Strikethrough: ~~text~~ → ~text~
          .replace(/~~(.+?)~~/g, "~$1~")
          // Links: [text](url) → <url|text>
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
          // Bullet lists: - item or * item → • item (with optional indentation)
          .replace(/^(\s*)[-*]\s+/gm, "$1• ")
      );
    })
    .join("");
}

/**
 * Split text into chunks that fit within Slack's message length limit.
 * Converts markdown to Slack mrkdwn format before chunking.
 */
export function formatResponse(text: string): string[] {
  const converted = markdownToSlackMrkdwn(text);

  if (converted.length <= SLACK_MAX_LENGTH) {
    return [converted];
  }

  const chunks: string[] = [];
  let remaining = converted;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary within the limit
    let splitIndex = remaining.lastIndexOf("\n", SLACK_MAX_LENGTH);
    if (splitIndex <= 0) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", SLACK_MAX_LENGTH);
    }
    if (splitIndex <= 0) {
      // Hard split if no good boundary found
      splitIndex = SLACK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * Download a Slack file attachment to a local directory.
 * Returns the local file path.
 */
export async function downloadAttachment(
  url: string,
  token: string,
  destDir: string,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
  }

  // Generate unique filename preserving extension from URL if possible
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath) || "";
  const filename = `${randomUUID()}${ext}`;
  const localPath = path.join(destDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  return localPath;
}
