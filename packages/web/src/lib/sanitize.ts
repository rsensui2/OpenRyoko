/**
 * HTML sanitization and safe markdown rendering utilities.
 *
 * Design:
 * - escapeHtml() handles the 5 critical HTML special characters
 * - MarkdownRenderer is a configurable pipeline: escape first, then transform
 * - Open/Closed: add new renderers via the `rules` array without modifying core
 * - Dependency Inversion: consumers depend on the MarkdownRule interface, not
 *   a specific implementation
 */

// ---------------------------------------------------------------------------
// Core escape function
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escape all HTML-significant characters so that the string is safe
 * to embed inside an HTML document (both element content and attributes).
 */
export function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}

// ---------------------------------------------------------------------------
// Markdown rendering pipeline
// ---------------------------------------------------------------------------

/**
 * A single markdown-to-HTML transformation rule.
 * Rules are applied in order after the input has already been HTML-escaped.
 */
export interface MarkdownRule {
  /** Human-readable name for debugging / extensibility */
  name: string;
  /** Regex to match against the escaped text */
  pattern: RegExp;
  /** Replacement string (may use $1, $2, etc.) */
  replacement: string;
}

/** Default rules that ship with the renderer. */
export const DEFAULT_MARKDOWN_RULES: MarkdownRule[] = [
  {
    name: "h4",
    pattern: /^#### (.+)$/gm,
    replacement:
      '<h4 class="text-[15px] font-semibold" style="color:var(--text-primary);margin-top:1rem;margin-bottom:0.25rem">$1</h4>',
  },
  {
    name: "h3",
    pattern: /^### (.+)$/gm,
    replacement:
      '<h3 class="text-[17px] font-semibold" style="color:var(--text-primary);margin-top:1.25rem;margin-bottom:0.375rem">$1</h3>',
  },
  {
    name: "h2",
    pattern: /^## (.+)$/gm,
    replacement:
      '<h2 class="text-[22px] font-semibold" style="color:var(--text-primary);margin-top:1.5rem;margin-bottom:0.5rem;padding-bottom:0.25rem;border-bottom:1px solid var(--separator)">$1</h2>',
  },
  {
    name: "h1",
    pattern: /^# (.+)$/gm,
    replacement:
      '<h1 class="text-[28px] font-bold" style="color:var(--text-primary);margin-top:1rem;margin-bottom:0.75rem">$1</h1>',
  },
  {
    name: "bold",
    pattern: /\*\*(.+?)\*\*/g,
    replacement:
      '<strong class="font-semibold" style="color:var(--text-primary)">$1</strong>',
  },
  {
    name: "inline-code",
    pattern: /`([^`]+)`/g,
    replacement:
      '<code style="background:var(--fill-secondary);color:var(--accent);padding:2px 6px;border-radius:6px;font-size:13px;font-family:var(--font-mono)">$1</code>',
  },
  {
    name: "unordered-list",
    pattern: /^- (.+)$/gm,
    replacement:
      '<li class="ml-4 text-[15px] leading-[1.7] list-disc" style="color:var(--text-secondary)">$1</li>',
  },
  {
    name: "ordered-list",
    pattern: /^(\d+)\. (.+)$/gm,
    replacement:
      '<li class="ml-4 text-[15px] leading-[1.7] list-decimal" style="color:var(--text-secondary)">$2</li>',
  },
  {
    name: "paragraph-break",
    pattern: /\n{2,}/g,
    replacement:
      '</p><p class="mb-3" style="color:var(--text-secondary)">',
  },
  {
    name: "line-break",
    pattern: /\n/g,
    replacement: "<br/>",
  },
];

export interface MarkdownRendererOptions {
  /** Override or extend the default rules */
  rules?: MarkdownRule[];
}

/**
 * Render a plain-text markdown string to safe HTML.
 *
 * The pipeline is:
 *   1. Escape ALL HTML entities (neutralises any injected markup)
 *   2. Apply markdown transformation rules in order
 *
 * Because escaping happens first, captured groups ($1 etc.) only ever
 * contain escaped text — no raw HTML can slip through.
 */
export function renderMarkdown(
  text: string,
  options?: MarkdownRendererOptions
): string {
  const rules = options?.rules ?? DEFAULT_MARKDOWN_RULES;

  // Step 1 — escape (this is the security boundary)
  let html = escapeHtml(text);

  // Step 2 — apply markdown transformations on the safe string
  for (const rule of rules) {
    html = html.replace(rule.pattern, rule.replacement);
  }

  return html;
}

// ---------------------------------------------------------------------------
// JSON colorizer (safe)
// ---------------------------------------------------------------------------

/** Default rules for JSON syntax highlighting (applied after escaping). */
export const JSON_COLORIZE_RULES: MarkdownRule[] = [
  {
    name: "json-key",
    pattern: /&quot;((?:(?!&quot;).)*?)&quot;(?=\s*:)/g,
    replacement:
      '<span style="color:var(--accent)">&quot;$1&quot;</span>',
  },
  {
    name: "json-string-value",
    pattern: /:\s*&quot;((?:(?!&quot;).)*?)&quot;/g,
    replacement:
      ': <span style="color:var(--system-green)">&quot;$1&quot;</span>',
  },
  {
    name: "json-number",
    pattern: /:\s*(\d+\.?\d*)/g,
    replacement: ': <span style="color:var(--system-blue)">$1</span>',
  },
  {
    name: "json-boolean",
    pattern: /:\s*(true|false)/g,
    replacement: ': <span style="color:#bf5af2">$1</span>',
  },
  {
    name: "json-null",
    pattern: /:\s*(null)/g,
    replacement:
      ': <span style="color:var(--text-tertiary)">$1</span>',
  },
];

/**
 * Syntax-highlight a JSON string safely.
 * Escapes HTML first, then applies colorization rules.
 */
export function colorizeJson(json: string): string {
  let html = escapeHtml(json);

  for (const rule of JSON_COLORIZE_RULES) {
    html = html.replace(rule.pattern, rule.replacement);
  }

  return html;
}
