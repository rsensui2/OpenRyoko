import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, saveResponseWithin } from "../../shared/attachment-download.js";

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
 * Where Slack serves the files uploaded to it: url_private and
 * url_private_download of a hosted file are
 * https://files.slack.com/files-pri/<team>-<file>/… (Slack's file object and
 * "working with files" documentation, Enterprise Grid included). These are the
 * only URLs the bot token belongs on.
 */
const SLACK_FILE_HOSTS: ReadonlySet<string> = new Set(["files.slack.com"]);
const MAX_SLACK_FILE_REDIRECTS = 3;

/** `url` as a URL, if it is an https URL on Slack's file host; null otherwise. */
function slackFileUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const plainHttps = parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "";
  return plainHttps && SLACK_FILE_HOSTS.has(parsed.hostname) ? parsed : null;
}

/**
 * GET a Slack file with the bot token — from Slack's file host and from
 * nowhere else.
 *
 * The URL comes from the file object in the event, and not every file is
 * Slack's: a remote file (files.remote.add — Google Drive, Dropbox, any app's
 * own) has a url_private that is whatever external URL was registered for it.
 * Sending `Authorization: Bearer <bot token>` there hands the token to that
 * host. So a URL elsewhere is refused before any request is made — it is not
 * fetched without the token either — and redirects are followed by hand, each
 * hop held to the same rule. The errors never quote a URL.
 */
async function fetchSlackFile(url: string, token: string): Promise<Response> {
  const first = slackFileUrl(url);
  if (!first) throw new Error("Slack attachment is not hosted on Slack's file host; it was not downloaded");
  let target: URL = first;
  for (let hop = 0; ; hop++) {
    const response: Response = await fetch(target, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => {});
    const location: string | null = response.headers.get("location");
    const next: URL | null = location ? slackFileUrl(new URL(location, target).href) : null;
    if (!next) {
      // What Slack does for a token it will not serve the file to: the sign-in page.
      throw new Error("Slack answered the attachment download with a redirect away from its file host (does the bot token have the files:read scope?)");
    }
    if (hop >= MAX_SLACK_FILE_REDIRECTS) throw new Error("Slack attachment download was redirected too many times");
    target = next;
  }
}

/**
 * Download a Slack file attachment to a local directory.
 * Returns the local file path.
 *
 * The file is written as it arrives and refused past `maxBytes` (50 MB unless
 * said otherwise); `destDir` is created once there is something to save, and
 * a download that fails leaves nothing behind. Only a file on Slack's own
 * file host is downloaded (see {@link fetchSlackFile}).
 */
export async function downloadAttachment(
  url: string,
  token: string,
  destDir: string,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): Promise<string> {
  const response = await fetchSlackFile(url, token);

  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
  }

  // Generate unique filename preserving extension from URL if possible
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath) || "";
  const filename = `${randomUUID()}${ext}`;
  const localPath = path.join(destDir, filename);

  await saveResponseWithin(response, localPath, maxBytes);

  return localPath;
}
