import os from "node:os";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

function normalizeHost(value: string | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    return raw.slice(1, end).replace(/\.$/, "");
  }
  const colonCount = (raw.match(/:/g) || []).length;
  const hostname = colonCount === 1 ? raw.slice(0, raw.lastIndexOf(":")) : raw;
  return hostname.replace(/\.$/, "");
}

export function localInterfaceHosts(): string[] {
  const hosts = new Set<string>([os.hostname().toLowerCase()]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) hosts.add(address.address.toLowerCase());
  }
  return [...hosts];
}

/**
 * Restrict DNS-rebinding even when the server binds a wildcard address.
 * Wildcard means "listen on local interfaces", never "trust every Host".
 */
export function hostHeaderAllowed(
  hostHeader: string | undefined,
  configuredHost: string,
  allowedHosts: string[] = [],
  interfaceHosts: string[] = localInterfaceHosts(),
): boolean {
  const requested = normalizeHost(hostHeader);
  if (!requested) return false;
  if (LOOPBACK_HOSTS.has(requested)) return true;

  const configured = normalizeHost(configuredHost);

  const explicitHosts = Array.isArray(allowedHosts) ? allowedHosts.filter((host) => typeof host === "string") : [];
  const allowed = new Set(
    [...explicitHosts, ...(configured && WILDCARD_HOSTS.has(configured) ? interfaceHosts : [])]
      .map((host) => normalizeHost(host))
      .filter((host): host is string => host !== null && !WILDCARD_HOSTS.has(host)),
  );
  if (configured && !WILDCARD_HOSTS.has(configured)) allowed.add(configured);
  return allowed.has(requested);
}
