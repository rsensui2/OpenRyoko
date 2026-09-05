/**
 * Bind address → connect URL.
 *
 * `gateway.host` answers "where do we listen", never "where do clients connect".
 * A wildcard bind (`0.0.0.0` / `::`) is not a valid client destination: sending
 * `Host: 0.0.0.0` gets rejected by the gateway's own DNS-rebinding guard
 * (`host-guard.ts`). Every caller that turns the configured host into a URL must
 * go through here, or it hands out a URL the gateway will answer with 421.
 */

const WILDCARD_V4 = new Set(["0.0.0.0", "0.0.0.0.", "*"]);
const WILDCARD_V6 = new Set(["::", "[::]", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]"]);

export const DEFAULT_GATEWAY_PORT = 7777;

/** True when the host is a wildcard bind address rather than a routable target. */
export function isWildcardBindHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const raw = host.trim().toLowerCase();
  return WILDCARD_V4.has(raw) || WILDCARD_V6.has(raw);
}

/**
 * The loopback URL a local client should use to reach the gateway.
 * Wildcard binds collapse to loopback; a specific bind is returned as-is
 * (bracketing bare IPv6 so the result stays a valid URL).
 */
export function localGatewayUrl(host: string | undefined | null, port: number | undefined | null): string {
  const resolvedPort = port || DEFAULT_GATEWAY_PORT;
  const raw = (host || "").trim();
  if (!raw) return `http://127.0.0.1:${resolvedPort}`;
  if (WILDCARD_V4.has(raw.toLowerCase())) return `http://127.0.0.1:${resolvedPort}`;
  if (WILDCARD_V6.has(raw.toLowerCase())) return `http://[::1]:${resolvedPort}`;
  const formatted = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  return `http://${formatted}:${resolvedPort}`;
}

/** Convenience wrapper for the common `config.gateway` shape. */
export function gatewayUrlFromConfig(config?: { gateway?: { host?: string; port?: number } } | null): string {
  return localGatewayUrl(config?.gateway?.host, config?.gateway?.port);
}
