/**
 * Normalize an explicit thread id from an untrusted payload.
 *
 * Gateway endpoints cast request bodies straight to `Target`, so `thread`
 * can be a number, empty string, or padded string. A send must only be
 * routed as a thread reply when the caller really named a thread — and the
 * value must reach the connector trimmed, or Slack receives a `thread_ts`
 * with whitespace.
 */
export function explicitThread(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
