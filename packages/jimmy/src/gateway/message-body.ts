export function messageText(body: unknown, keys: readonly string[]): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
