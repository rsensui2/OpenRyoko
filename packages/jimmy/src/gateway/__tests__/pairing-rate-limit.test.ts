import { describe, expect, it } from "vitest";
import { PairingAttemptLimiter, pairingAttemptKey } from "../pairing-rate-limit.js";

describe("pairing attempt limiter", () => {
  it("blocks repeated guesses until the window expires", () => {
    const limiter = new PairingAttemptLimiter(2, 1_000);
    expect(limiter.claim("client", 100)).toBe(true);
    expect(limiter.claim("client", 200)).toBe(true);
    expect(limiter.claim("client", 300)).toBe(false);
    expect(limiter.claim("client", 1_201)).toBe(true);
  });

  it("clears failures after successful pairing", () => {
    const limiter = new PairingAttemptLimiter(1, 1_000);
    expect(limiter.claim("client", 100)).toBe(true);
    limiter.clear("client");
    expect(limiter.claim("client", 200)).toBe(true);
  });

  it("bounds distinct keys and admits new clients after expired buckets are collected", () => {
    const limiter = new PairingAttemptLimiter(1, 1_000, 2);
    expect(limiter.claim("a", 100)).toBe(true);
    expect(limiter.claim("b", 100)).toBe(true);
    expect(limiter.claim("c", 200)).toBe(false);
    expect(limiter.claim("c", 1_101)).toBe(true);
  });

  it("uses forwarded IPs only when proxy headers are trusted", () => {
    const request = {
      headers: { "x-forwarded-for": "198.51.100.4, 203.0.113.8" },
      socket: { remoteAddress: "10.0.0.2" },
    } as never;
    expect(pairingAttemptKey(request)).toBe("10.0.0.2");
    expect(pairingAttemptKey(request, true)).toBe("10.0.0.2");
    expect(pairingAttemptKey(request, true, ["10.0.0.2"])).toBe("10.0.0.2|203.0.113.8");
  });
});
