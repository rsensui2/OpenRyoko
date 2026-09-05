import { isLoopbackHost } from "./auth.js";

function authorityFromHostHeader(host: string | undefined, protocol: string): { hostname: string; port: string } | null {
  if (!host) return null;
  try {
    const parsed = new URL(`${protocol}//${host}`);
    const defaultPort = protocol === "https:" ? "443" : "80";
    return { hostname: parsed.hostname, port: parsed.port || defaultPort };
  } catch { return null; }
}

/** A browser request may be same-host or cross-spelling loopback
 * (localhost ↔ 127.0.0.1). Non-browser clients omit Origin and are governed by
 * Host/auth. Wildcard binds never mean wildcard browser origins. */
export function requestOriginAllowed(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  _configuredHost: string,
): boolean {
  if (!originHeader) return true;
  let origin: URL;
  try { origin = new URL(originHeader); }
  catch { return false; }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  const request = authorityFromHostHeader(hostHeader, origin.protocol);
  if (!request) return false;
  const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
  // SameSite cookies do not distinguish ports. Requiring the gateway port here
  // prevents another web service on the same host from performing credentialed
  // CORS requests against OpenRyoko.
  if (originPort !== request.port) return false;
  if (origin.hostname === request.hostname) return true;
  if (isLoopbackHost(origin.hostname) && isLoopbackHost(request.hostname)) return true;
  return false;
}
