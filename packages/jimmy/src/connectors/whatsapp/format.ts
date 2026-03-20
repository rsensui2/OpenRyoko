const WA_MAX_LENGTH = 4000;

/**
 * Convert standard markdown to WhatsApp formatting.
 * WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```, `code`.
 * It does NOT support headings or hyperlinks, so we convert those.
 */
export function markdownToWhatsApp(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment;

      return (
        segment
          // Headings: ## text → *text* (bold on own line)
          .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `*${content}*`)
          // Bold: **text** or __text__ → *text*
          .replace(/\*\*(.+?)\*\*/g, "*$1*")
          .replace(/__(.+?)__/g, "*$1*")
          // Strikethrough: ~~text~~ → ~text~
          .replace(/~~(.+?)~~/g, "~$1~")
          // Links: [text](url) → text (url) — WhatsApp auto-links URLs
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
          // Bullet lists: - item or * item → • item
          .replace(/^(\s*)[-*]\s+/gm, "$1• ")
      );
    })
    .join("");
}

/**
 * Split text into chunks that fit within WhatsApp's message length limit.
 * Converts markdown to WhatsApp formatting before chunking.
 */
export function formatResponse(text: string): string[] {
  const converted = markdownToWhatsApp(text);

  if (converted.length <= WA_MAX_LENGTH) return [converted];
  const chunks: string[] = [];
  let remaining = converted;
  while (remaining.length > 0) {
    if (remaining.length <= WA_MAX_LENGTH) { chunks.push(remaining); break; }
    let cutAt = remaining.lastIndexOf("\n", WA_MAX_LENGTH);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", WA_MAX_LENGTH);
    if (cutAt <= 0) cutAt = WA_MAX_LENGTH;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}
