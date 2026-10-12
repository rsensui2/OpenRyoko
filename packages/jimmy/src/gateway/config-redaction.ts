/** What GET /api/config shows in place of a secret. PUT /api/config leaves a
 *  value it gets back as this placeholder alone (see SANITIZED_KEYS in api.ts). */
const REDACTED = "***";

/**
 * A copy of the config's `mcp` block with every API key hidden — today that
 * is mcp.search.apiKey, and an `apiKey` a custom server entry carries is
 * hidden the same way. Only a key that holds something is replaced; nothing is
 * added where there is none.
 */
export function redactMcpApiKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactMcpApiKeys(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, key === "apiKey" && child ? REDACTED : redactMcpApiKeys(child)]),
  ) as T;
}
