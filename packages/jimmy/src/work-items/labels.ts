/** work-items shim — the label normalizer, verbatim from upstream. */
export function normalizeLabelName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(`label name "${name}" must contain at least one letter or digit`);
  return normalized;
}
