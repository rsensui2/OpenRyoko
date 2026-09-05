/**
 * The grammar for pointing a workflow run at a Todo attachment without ever
 * putting the bytes in the run. Its own module because both sides of the loop
 * need it: the runner and the output validator format and check refs, and the
 * web surfaces parse one back into the id pair the byte route already serves.
 *
 * A ref is a single whitespace-free token, so it survives interpolation into
 * prose and stores as a plain JSON string with no schema change anywhere:
 *
 *     attachment:<TODO-ID>:<attachment-id>:<mime>
 *     attachment:PLA-1:wia_ab12cd34ef56:image/png
 *
 * It deliberately carries no filesystem path. A ref is an employee-authored
 * string, and a path inside one is an arbitrary file read the moment a renderer
 * trusts it; the id pair is what the byte route needs anyway, and that route
 * resolves the real path and the real Content-Type from the attachment row. A
 * forged mime can therefore only mis-pick the client-side renderer, which
 * already degrades to a named-file row.
 */

/** One `type/subtype` token: dot, plus and dash may join runs, never repeat. */
const MIME_TOKEN = String.raw`[a-z0-9]+(?:[.+-][a-z0-9]+)*`;

const ATTACHMENT_REF = new RegExp(
  String.raw`^attachment:([A-Z]{3}-[1-9][0-9]*):(wia_[0-9a-f]{12}):(${MIME_TOKEN}/${MIME_TOKEN})$`,
);

const MIME_ONLY = new RegExp(String.raw`^${MIME_TOKEN}/${MIME_TOKEN}$`);

/** What a ref names, once it has been proven to be one. */
export interface AttachmentRef {
  workItemId: string;
  attachmentId: string;
  mime: string;
}

/** The shape of a ref, for the humans and employees who have to write one. */
export const ATTACHMENT_REF_SHAPE = 'attachment:<TODO-ID>:<attachment-id>:<mime>';

/** The ref for a stored attachment. Never throws: an unusable mime degrades. */
export function formatAttachmentRef(attachment: {
  workItemId: string;
  id: string;
  mime?: string | null;
}): string {
  const mime = attachment.mime?.trim().toLowerCase() ?? '';
  const usable = MIME_ONLY.test(mime) ? mime : 'application/octet-stream';
  return `attachment:${attachment.workItemId}:${attachment.id}:${usable}`;
}

/** The ref's parts, or `null` if the value is not a ref. Shape only — no lookup. */
export function parseAttachmentRef(value: unknown): AttachmentRef | null {
  if (typeof value !== 'string') return null;
  const match = ATTACHMENT_REF.exec(value);
  if (!match) return null;
  return { workItemId: match[1]!, attachmentId: match[2]!, mime: match[3]! };
}

/** Whether a value is a ref, for callers that only need the verdict. */
export function isAttachmentRef(value: unknown): value is string {
  return parseAttachmentRef(value) !== null;
}
