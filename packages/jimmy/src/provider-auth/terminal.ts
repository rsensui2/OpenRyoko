/**
 * Plain-text reading of raw PTY output — just enough to find a sign-in link or
 * a device code in what a login CLI prints. This is not a terminal emulator:
 * it keeps the characters and throws the layout away.
 *
 * Two details matter for the values we look for:
 *   - An OSC 8 hyperlink carries its target in the escape sequence, and the
 *     visible text may be a label ("click here"). The target is kept as a token
 *     of its own, so the link survives either way.
 *   - Cursor movement stands in for the spaces and line breaks a renderer did
 *     not write. Dropping it would fuse two cells into one token
 *     ("…/device2."), so it becomes a line break. Color changes sit inside a
 *     token and are simply removed.
 */

/** OSC 8 hyperlinks capture their target; every other OSC is discarded. */
const OSC = /\u001b\](?:8;[^;\u0007\u001b]*;([^\u0007\u001b]*)|[^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*([@-~])/g;
/** A sequence the next chunk has not finished yet — never read half of one. */
const UNFINISHED_OSC = /\u001b\][^\u0007\u001b]*\u001b?$/;
const UNFINISHED_CSI = /\u001b\[[0-?]*[ -/]*$/;
const OTHER_ESCAPE = /\u001b[ -/]*[0-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function terminalText(raw: string): string {
  return raw
    .replace(OSC, (_sequence, target: string | undefined) => (target === undefined ? "" : ` ${target} `))
    .replace(CSI, (_sequence, final: string) => (final === "m" ? "" : "\n"))
    .replace(UNFINISHED_OSC, "")
    .replace(UNFINISHED_CSI, "")
    .replace(OTHER_ESCAPE, "")
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n");
}

/**
 * Append `chunk` and keep only the newest `maxBytes` bytes, cut on a character
 * boundary so a multi-byte character is never left half-present.
 */
export function appendTail(current: string, chunk: string, maxBytes: number): string {
  const bytes = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
