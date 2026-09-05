import { describe, it, expect } from "vitest";
import { explicitThread } from "../threading.js";

// Issue #6: /send and the connector proxy route a message as a thread reply
// only when the caller explicitly named a thread. Payloads are untrusted —
// numbers, blanks, and padded strings must not crash or leak whitespace.
describe("explicitThread", () => {
  it("returns the trimmed thread for a valid value", () => {
    expect(explicitThread("111.222")).toBe("111.222");
    expect(explicitThread(" 111.222 ")).toBe("111.222");
  });

  it("returns undefined for missing or blank values", () => {
    expect(explicitThread(undefined)).toBeUndefined();
    expect(explicitThread(null)).toBeUndefined();
    expect(explicitThread("")).toBeUndefined();
    expect(explicitThread("   ")).toBeUndefined();
  });

  it("returns undefined for non-string values instead of throwing", () => {
    expect(explicitThread(123)).toBeUndefined();
    expect(explicitThread({})).toBeUndefined();
    expect(explicitThread(["111.222"])).toBeUndefined();
  });
});
