import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { requestFromTrustedProxy } from "./auth.js";

interface AttemptBucket {
  count: number;
  resetAt: number;
}

export class PairingAttemptLimiter {
  private readonly attempts = new Map<string, AttemptBucket>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 5 * 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  claim(key: string, now = Date.now()): boolean {
    const current = this.attempts.get(key);
    if (current && current.resetAt > now) {
      if (current.count >= this.limit) return false;
      current.count += 1;
      return true;
    }

    if (!current && this.attempts.size >= this.maxKeys) {
      for (const [candidate, bucket] of this.attempts) {
        if (bucket.resetAt <= now) this.attempts.delete(candidate);
      }
      // Fail closed instead of allowing an unbounded number of attacker keys.
      if (this.attempts.size >= this.maxKeys) return false;
    }
    this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    return true;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

/**
 * Use a forwarded client address only when the operator explicitly trusts the
 * reverse proxy. The right-most valid address is the hop appended by the
 * nearest trusted proxy when using the common proxy_add_x_forwarded_for form.
 */
export function pairingAttemptKey(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxyHeaders = false,
  trustedProxyAddresses: string[] = [],
): string {
  const remote = req.socket.remoteAddress || "unknown";
  if (!requestFromTrustedProxy(req, trustProxyHeaders, trustedProxyAddresses)) return remote;
  const header = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const forwarded = header
    ?.split(",")
    .map((value) => value.trim())
    .reverse()
    .find((value) => isIP(value) !== 0);
  return forwarded ? `${remote}|${forwarded}` : remote;
}
