import jsYaml from "js-yaml";
import { isMap, isScalar, isSeq, parseDocument, Scalar, type Pair, type YAMLMap, type YAMLSeq } from "yaml";

/**
 * Rewrite only the lines of a YAML text whose value changed.
 *
 * A whole-file `yaml.dump` drops every comment and re-quotes every value, and
 * config.yaml is mostly guidance comments. A parse → edit → stringify round
 * trip through a document model keeps the comments but still re-indents and
 * re-spaces lines nobody touched. So this splices: the `yaml` package is used
 * only to find where each key and value sits in the text, the replacement text
 * comes from js-yaml (the parser the gateway reads its config with), and
 * everything outside the spliced ranges is copied through byte for byte.
 *
 * A changed value of a key is replaced where it stands, keeping its quotes and
 * the comment after it. Keys and list items are added and removed as whole
 * lines; a list item is never overwritten with a different one, because the
 * comment on its line was written about it. Anything else — a value changing
 * kind, a list with nothing left in common — rewrites that one `key: value`
 * entry, and the comments inside it go with it.
 *
 * The result is checked before it is returned: it must load, with js-yaml, to
 * exactly `after`. Anything this cannot promise — the two parsers disagreeing
 * about the file (dates, merge keys), an edit an alias would repeat elsewhere,
 * a shape it does not handle — yields null, and the caller falls back to
 * dumping the whole document as before.
 */

interface Edit {
  start: number;
  end: number;
  text: string;
  /** The text must begin a line of its own (the file may not end with a newline). */
  ownLine?: boolean;
}

interface Source {
  raw: string;
  eol: string;
}

type Data = Record<string, unknown>;

const isMapping = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const isLeaf = (value: unknown): boolean =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Equality of parsed YAML data. The order of keys does not matter. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameData(item, b[i]));
  }
  if (!isMapping(a) || !isMapping(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}

/**
 * `value` as a js-yaml dump stores it: a key whose value is undefined is left
 * out, and an undefined item of a list is null. Code that clears a setting
 * assigns undefined to it as readily as it deletes the key, and a dump writes
 * the same file for both — so must the in-place edit, or one undefined
 * anywhere in the document would make every save rewrite the whole file.
 * Returns a copy; the caller's document is not changed.
 */
function asStored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : asStored(item)));
  if (!isMapping(value)) return value;
  const stored: Data = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) stored[key] = asStored(item);
  }
  return stored;
}

/** `key: value` as js-yaml writes it, one array entry per line. */
function dumpEntryLines(key: string, value: unknown): string[] {
  return jsYaml.dump({ [key]: value }, { lineWidth: -1 }).replace(/\n$/, "").split("\n");
}

/** A scalar on one line, valid inside flow collections as well as outside.
 *  Rendered as the only item of a flow sequence so js-yaml applies its own
 *  quoting rules; a quoted original keeps its kind of quotes. */
function renderInlineScalar(value: unknown, style: Scalar.Type | undefined): string | null {
  const quotes =
    style === Scalar.QUOTE_DOUBLE ? { quotingType: '"' as const, forceQuotes: true }
    : style === Scalar.QUOTE_SINGLE ? { quotingType: "'" as const, forceQuotes: true }
    : {};
  const dumped = jsYaml.dump([value], { flowLevel: 0, lineWidth: -1, ...quotes }).trimEnd();
  if (!dumped.startsWith("[") || !dumped.endsWith("]") || dumped.includes("\n")) return null;
  return dumped.slice(1, -1);
}

/** Offset just past `node`'s own last character. A block collection's range
 *  runs on over the comments that follow it, so walk down to its last value. */
function contentEnd(node: unknown): number | null {
  if (isMap(node) && !node.flow && node.items.length > 0) {
    const last = node.items[node.items.length - 1];
    return contentEnd(last.value ?? last.key);
  }
  if (isSeq(node) && !node.flow && node.items.length > 0) {
    return contentEnd(node.items[node.items.length - 1]);
  }
  const range = (node as { range?: [number, number, number] | null } | null)?.range;
  return range ? range[1] : null;
}

/** Offset just past the line `offset` is on (or `offset`, if it already starts a line). */
function endOfLine(raw: string, offset: number): number {
  if (offset > 0 && raw[offset - 1] === "\n") return offset;
  const newline = raw.indexOf("\n", offset);
  return newline === -1 ? raw.length : newline + 1;
}

/** Where an entry's key starts, the line it starts on, and what precedes it there. */
function keyPlacement(raw: string, pair: Pair): { keyStart: number; lineStart: number; lead: string } | null {
  const keyStart = isScalar(pair.key) && !pair.key.anchor && !pair.key.tag ? pair.key.range?.[0] : undefined;
  if (keyStart === undefined) return null;
  const lineStart = raw.lastIndexOf("\n", keyStart - 1) + 1;
  return { keyStart, lineStart, lead: raw.slice(lineStart, keyStart) };
}

/** Offset just past the last line that belongs to `pair`. */
function entryEnd(raw: string, pair: Pair): number | null {
  const end = contentEnd(pair.value ?? pair.key);
  return end === null ? null : endOfLine(raw, end);
}

/** Indentation only, or indentation up to and including sequence dashes ("  - "). */
const BLOCK_LEAD = /^ *(?:- +)*$/;

function replaceScalar(node: Scalar, value: unknown): Edit[] | null {
  const range = node.range;
  const inline = node.type === Scalar.PLAIN || node.type === Scalar.QUOTE_DOUBLE || node.type === Scalar.QUOTE_SINGLE;
  // An empty value has no text to replace; a block scalar, an anchor or an
  // explicit tag would need more than a one-line swap. The caller rewrites the entry.
  if (!range || range[1] <= range[0] || !inline || node.anchor || node.tag) return null;
  const text = renderInlineScalar(value, node.type);
  return text === null ? null : [{ start: range[0], end: range[1], text }];
}

/** Replace a whole `key: value` entry — comments inside the old value go with it. */
function rewriteEntry(source: Source, pair: Pair, key: string, value: unknown): Edit | null {
  const placement = keyPlacement(source.raw, pair);
  const end = entryEnd(source.raw, pair);
  if (!placement || end === null || !BLOCK_LEAD.test(placement.lead)) return null;
  const indent = " ".repeat(placement.lead.length);
  const lines = dumpEntryLines(key, value).map((line, i) => (i === 0 ? line : indent + line));
  const endsLine = end > 0 && source.raw[end - 1] === "\n";
  return { start: placement.keyStart, end, text: lines.join(source.eol) + (endsLine ? source.eol : "") };
}

function removeEntry(source: Source, pair: Pair): Edit | null {
  const placement = keyPlacement(source.raw, pair);
  const end = entryEnd(source.raw, pair);
  // An entry that shares its line with a sequence dash cannot simply lose the line.
  if (!placement || end === null || !/^ *$/.test(placement.lead)) return null;
  return { start: placement.lineStart, end, text: "" };
}

/** Past the comment lines that follow `offset` and are indented deeper than
 *  `indent`: they belong to the value that ends at `offset`. */
function skipDeeperComments(raw: string, offset: number, indent: number): number {
  let settled = offset;
  let cursor = offset;
  while (cursor < raw.length) {
    const newline = raw.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? raw.length : newline + 1;
    const line = raw.slice(cursor, lineEnd).replace(/\r?\n$/, "");
    const text = line.trimStart();
    const deeperComment = text.startsWith("#") && line.length - text.length > indent;
    if (text !== "" && !deeperComment) break;
    if (deeperComment) settled = lineEnd; // blank lines count only when such a comment follows them
    cursor = lineEnd;
  }
  return settled;
}

/** Append new entries after the last entry of a block mapping. */
function appendEntries(source: Source, map: YAMLMap, keys: string[], after: Data): Edit | null {
  const { raw, eol } = source;
  const first = map.items[0];
  const last = map.items[map.items.length - 1];
  const placement = first ? keyPlacement(raw, first) : null;
  const lastEnd = last ? entryEnd(raw, last) : null;
  if (!placement || lastEnd === null || !BLOCK_LEAD.test(placement.lead)) return null;
  const width = placement.lead.length;
  const at = skipDeeperComments(raw, lastEnd, width);
  const indent = " ".repeat(width);
  const entries = keys.map((key) => dumpEntryLines(key, after[key]).map((line) => indent + line).join(eol) + eol);
  // A file that sets its top-level sections apart with blank lines gets them here too.
  const apart = width === 0 && raw.includes(eol + eol);
  const lead = apart && !raw.slice(0, at).endsWith(eol + eol) ? eol : "";
  return { start: at, end: at, text: lead + entries.join(apart ? eol : ""), ownLine: true };
}

function editMap(source: Source, map: YAMLMap, before: Data, after: Data): Edit[] | null {
  const entries = new Map<string, Pair>();
  for (const pair of map.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : null;
    if (name === null || entries.has(name)) return null;
    entries.set(name, pair);
  }
  // `key:` with nothing left under it would read back as null, not {}.
  if (Object.keys(after).length === 0) return null;
  const edits: Edit[] = [];
  for (const key of Object.keys(before)) {
    const pair = entries.get(key);
    if (!pair) return null;
    if (!Object.hasOwn(after, key)) {
      const removal = map.flow ? null : removeEntry(source, pair);
      if (!removal) return null;
      edits.push(removal);
      continue;
    }
    const inPlace = editValue(source, pair.value, before[key], after[key]);
    if (inPlace) {
      edits.push(...inPlace);
      continue;
    }
    const rewritten = map.flow ? null : rewriteEntry(source, pair, key, after[key]);
    if (!rewritten) return null;
    edits.push(rewritten);
  }
  const added = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
  if (added.length > 0) {
    const appended = map.flow ? null : appendEntries(source, map, added, after);
    if (!appended) return null;
    edits.push(appended);
  }
  return edits;
}

/** The lines one item of a block sequence occupies, and the column of its dash. */
function itemLines(raw: string, item: unknown): { lineStart: number; end: number; dash: number } | null {
  const node = item as { range?: [number, number, number] | null; anchor?: string; tag?: string } | null;
  const start = node?.range?.[0];
  const end = contentEnd(item);
  if (start === undefined || end === null || node?.anchor || node?.tag) return null;
  const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
  const lead = raw.slice(lineStart, start);
  return /^ *- +$/.test(lead) ? { lineStart, end: endOfLine(raw, end), dash: lead.indexOf("-") } : null;
}

/** What tells one mapping in a list from the others: its `id`, or failing that
 *  its `name`. Null for anything that has neither — and for every scalar. */
function itemIdentity(item: unknown): string | null {
  if (!isMapping(item)) return null;
  for (const key of ["id", "name"]) {
    const value = item[key];
    if (typeof value === "string" || typeof value === "number") return `${key}\u0000${typeof value}\u0000${value}`;
  }
  return null;
}

/**
 * Index pairs [before, after] of the items that are the same item in both
 * lists, in order (longest common subsequence). "The same" is: equal, or two
 * mappings with the same identifier. Never "at the same position" — a list
 * that was reordered has different values at every position, and the note
 * written next to a value belongs to that value.
 */
function alignItems(before: unknown[], after: unknown[]): [number, number][] {
  const identities = [before.map(itemIdentity), after.map(itemIdentity)];
  const same = (i: number, j: number) =>
    sameData(before[i], after[j]) || (identities[0][i] !== null && identities[0][i] === identities[1][j]);
  const length = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      length[i][j] = same(i, j) ? length[i + 1][j + 1] + 1 : Math.max(length[i + 1][j], length[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (same(i, j)) pairs.push([i++, j++]);
    else if (length[i + 1][j] >= length[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Edit a block sequence item by item. An item that is in both lists keeps its
 * lines, and with them the note next to it; a mapping that kept its identifier
 * is edited within its own lines. Every other item is removed as lines or
 * added as lines. A scalar is never swapped for another where it stands: the
 * comment on that line was written about the old value.
 */
function editSequence(source: Source, seq: YAMLSeq, before: unknown[], after: unknown[]): Edit[] | null {
  if (seq.flow || seq.items.length !== before.length) return null;
  const edits: Edit[] = [];
  const kept = alignItems(before, after).filter(([i, j]) => {
    if (sameData(before[i], after[j])) return true;
    const within = editValue(source, seq.items[i], before[i], after[j]);
    if (within) edits.push(...within);
    return within !== null;
  });
  if (kept.length === 0) return null; // nothing stays: the caller rewrites the entry
  const spans = seq.items.map((item) => itemLines(source.raw, item));
  const stays = new Set(kept.map(([i]) => i));
  for (let i = 0; i < before.length; i++) {
    if (stays.has(i)) continue;
    const span = spans[i];
    if (!span) return null;
    edits.push({ start: span.lineStart, end: span.end, text: "" });
  }
  let passed = 0; // kept items already behind position j
  for (let j = 0; j < after.length; j++) {
    if (passed < kept.length && kept[passed][1] === j) {
      passed++;
      continue;
    }
    // A new item goes right after the kept item before it, or ahead of the first kept one.
    const anchor = spans[kept[Math.max(passed - 1, 0)][0]];
    if (!anchor) return null;
    const at = passed === 0 ? anchor.lineStart : anchor.end;
    const indent = " ".repeat(anchor.dash);
    const rendered = jsYaml.dump([after[j]], { lineWidth: -1 }).replace(/\n$/, "").split("\n");
    edits.push({ start: at, end: at, text: rendered.map((line) => indent + line).join(source.eol) + source.eol, ownLine: true });
  }
  return edits;
}

/** A flow collection ([a, b] / {a: 1}) is one inline value: swap its text and
 *  leave the rest of the line — the comment after it included — as it is. */
function replaceFlowCollection(node: YAMLMap | YAMLSeq, value: unknown): Edit[] | null {
  const range = node.range;
  if (!node.flow || !range || node.anchor || node.tag || isLeaf(value)) return null;
  const text = jsYaml.dump(value, { flowLevel: 0, lineWidth: -1 }).trimEnd();
  return text.includes("\n") ? null : [{ start: range[0], end: range[1], text }];
}

/** Edits that turn `before` into `after` inside `node`; null when the entry
 *  holding `node` has to be rewritten as a whole instead. */
function editValue(source: Source, node: unknown, before: unknown, after: unknown): Edit[] | null {
  if (sameData(before, after)) return [];
  if (isScalar(node)) return isLeaf(before) && isLeaf(after) ? replaceScalar(node, after) : null;
  let edits: Edit[] | null = null;
  if (isMap(node) && isMapping(before) && isMapping(after)) {
    edits = editMap(source, node, before, after);
  } else if (isSeq(node) && Array.isArray(before) && Array.isArray(after)) {
    edits = editSequence(source, node, before, after);
  }
  return edits ?? (isMap(node) || isSeq(node) ? replaceFlowCollection(node, after) : null);
}

function applyEdits({ raw, eol }: Source, edits: Edit[]): string | null {
  // Insertions sort ahead of a range that starts at the same offset; edits at
  // the very same spot keep the order they were planned in (inner before outer).
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => a.edit.start - b.edit.start || (a.edit.end - a.edit.start) - (b.edit.end - b.edit.start) || a.index - b.index);
  let text = "";
  let cursor = 0;
  for (const { edit } of ordered) {
    if (edit.start < cursor) return null;
    text += raw.slice(cursor, edit.start);
    if (edit.ownLine && text !== "" && !text.endsWith("\n")) text += eol;
    text += edit.text;
    cursor = edit.end;
  }
  return text + raw.slice(cursor);
}

function planEdits(source: Source, before: Data, after: Data): Edit[] | null {
  const document = parseDocument(source.raw);
  if (document.errors.length > 0) return null;
  const root = document.contents;
  if (root === null || root === undefined) {
    // Nothing but comments (or nothing at all): keep them and write below.
    if (Object.keys(before).length > 0 || Object.keys(after).length === 0) return null;
    const lines = Object.keys(after).flatMap((key) => dumpEntryLines(key, after[key]));
    return [{ start: source.raw.length, end: source.raw.length, text: lines.join(source.eol) + source.eol, ownLine: true }];
  }
  // Both parsers must have read the same document, or the offsets from one
  // say nothing reliable about the data from the other.
  if (!isMap(root) || root.flow || !sameData(document.toJS(), before)) return null;
  return editMap(source, root, before, after);
}

/**
 * `raw` with the changes from `before` to `after` applied in place, or null
 * when that cannot be done safely. `before` must be what js-yaml loads from
 * `raw` (an empty mapping for a file that holds no data). `after` is taken the
 * way a dump would store it: see {@link asStored}.
 */
export function editYamlText(raw: string, before: Data, document: Data): string | null {
  try {
    const after = asStored(document) as Data;
    if (sameData(before, after)) return raw;
    const source: Source = { raw, eol: raw.includes("\r\n") ? "\r\n" : "\n" };
    const edits = planEdits(source, before, after);
    const text = edits ? applyEdits(source, edits) : null;
    return text !== null && sameData(jsYaml.load(text), after) ? text : null;
  } catch {
    return null;
  }
}
