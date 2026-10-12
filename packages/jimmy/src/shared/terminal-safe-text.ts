/**
 * Text headed for a terminal — a prompt pasted into the interactive CLI's
 * input, or a cold start's positional prompt argument — must carry no control
 * characters that act on the terminal instead of being read as text.
 *
 * Dropped: the C0 controls (tab and line feed excepted), DEL, and the C1
 * controls. C0 includes ESC, so an embedded bracketed-paste start or end
 * (ESC [ 200 ~ / ESC [ 201 ~) loses its ESC and is left as the inert text
 * `[200~` / `[201~`: a message cannot close the paste it is delivered in and
 * have what follows typed as keystrokes.
 *
 * Kept: tab and line feed, the only control characters a message legitimately
 * carries. A carriage return is the Enter key, so it is folded into the line
 * feed it usually travels with rather than dropped — a pasted line break
 * survives as a line break instead of joining two lines.
 */
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function stripTerminalControlChars(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(TERMINAL_CONTROLS, "");
}
