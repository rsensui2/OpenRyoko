import { describe, expect, it } from "vitest";
import { decodeSessionCursor, encodeSessionCursor } from "../pagination.js";

describe("session pagination cursor", () => {
  it("round-trips a cursor through an opaque base64url token", () => {
    const cursor = { lastActivity: "2026-08-17T00:00:00.000Z", id: "session-1" };
    expect(decodeSessionCursor(encodeSessionCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed and oversized tokens", () => {
    expect(() => decodeSessionCursor("not-json")).toThrow(/invalid/);
    expect(() => decodeSessionCursor("a".repeat(2049))).toThrow(/too long/);
  });
});
