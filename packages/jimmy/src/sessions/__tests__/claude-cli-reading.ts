/**
 * How Claude Code reads a prompt it is handed — the rules these tests hold the
 * gateway to. Read from the installed executable (2.1.296), never by running it:
 *
 *   - Arguments: one that starts with "-" is an option, not the prompt.
 *   - Input box: a value that starts with "!" switches it to bash mode, and
 *     the rest is run as a shell command
 *     (`function x_(t){if(t.startsWith("!"))return"bash";return"prompt"}`).
 *   - On submit: `input.trim()` equal to one of the exit words runs /exit
 *     (`bMe=["exit","quit",":q",":q!",":wq",":wq!"]`); one that starts with "/"
 *     is a command whose name runs to the first whitespace
 *     (`r=n.search(/\s/)`), looked up by exact, case-sensitive name or alias.
 *
 * Everything else is text. A full-width "／" is not folded to "/", and a "/"
 * further into the message is not a command.
 */
export const CLAUDE_EXIT_WORDS: readonly string[] = ["exit", "quit", ":q", ":q!", ":wq", ":wq!"];

/** "text", or what the CLI would do instead of passing the prompt to the model. */
export function claudeReads(prompt: string): string {
  if (prompt.startsWith("-")) return "option";
  if (prompt.startsWith("!")) return "bash";
  const trimmed = prompt.trim();
  if (CLAUDE_EXIT_WORDS.includes(trimmed)) return "/exit";
  if (trimmed.startsWith("/")) return `/${trimmed.slice(1).split(/\s/, 1)[0]}`;
  return "text";
}

/**
 * The same reading by a stricter CLI than the installed one: one that also
 * folds full-width forms and drops invisible characters before it looks. No
 * such version is known. What reaches the CLI is held to this reading too, so
 * that a later version which starts doing either does not reopen the hole.
 */
export function strictestClaudeReads(prompt: string): string {
  const visible = prompt.normalize("NFKC").replace(/^[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]+/u, "");
  if (CLAUDE_EXIT_WORDS.includes(visible.trim().toLowerCase())) return "/exit";
  return claudeReads(visible);
}
