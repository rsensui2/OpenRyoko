import { describe, expect, it } from "vitest";
import { redactJson, redactText } from "../redact.js";

describe("secret redaction", () => {
  it("redacts headers, environment values, private keys, token prefixes and URL passwords", () => {
    const input = [
      "Authorization: Bearer sk-live_1234567890abcdef",
      "OPENAI_API_KEY=sk-proj-1234567890abcdef",
      "-----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----",
      "postgres://alice:secretpass@db.example/app",
      "xoxb-" + "1234567890-abcdefghijklmnop",
      "signingSecret: another-secret-value",
    ].join("\n");
    const output = redactText(input);
    for (const secret of ["sk-live_1234567890abcdef", "sk-proj-1234567890abcdef", "secret-key-body", "secretpass", "abcdefghijklmnop", "another-secret-value"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("recursively redacts secret JSON fields", () => {
    expect(redactJson({ token: "abc", nested: { password: "pw", model: "opus" } })).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", model: "opus" },
    });
  });
});
