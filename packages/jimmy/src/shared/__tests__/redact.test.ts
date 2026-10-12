import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
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

// Connector failures are now reported instead of swallowed, so their reasons
// reach the log. These credentials carry no recognisable prefix or key name
// next to them, and none of them was masked. Every value below is synthetic.
describe("secret redaction — connector credentials", () => {
  const slackAppToken = "xapp-" + "1-A0000000000-1234567890123-" + "abcdef0123456789abcdef0123456789";
  const telegramToken = "1234567890:" + "AAE" + "abcdefghijklmnopqrstuvwxyz012345";
  const discordId = Buffer.from("123456789012345678").toString("base64");
  const discordToken = `${discordId}.GAbCdE.` + "abcdefghijklmnopqrstuvwxyz_";
  const discordLongToken = `${discordId}.GAbCdE.` + "abcdefghijklmnopqrstuvwxyz0123456789-_";

  it("masks a Slack app-level token", () => {
    const output = redactText(`apps.connections.open failed for ${slackAppToken}`);

    expect(output).toBe("apps.connections.open failed for [REDACTED]");
  });

  it("masks the bot token inside a Telegram API URL and keeps the rest readable", () => {
    const output = redactText(`request to https://api.telegram.org/bot${telegramToken}/sendMessage failed`);

    expect(output).toBe("request to https://api.telegram.org/bot[REDACTED]/sendMessage failed");
  });

  it("masks the bot token inside a Telegram file URL", () => {
    const output = redactText(`GET https://api.telegram.org/file/bot${telegramToken}/documents/file_1.pdf`);

    expect(output).toBe("GET https://api.telegram.org/file/bot[REDACTED]/documents/file_1.pdf");
  });

  it("masks a Telegram bot token that stands on its own", () => {
    const output = redactText(`Unauthorized (token ${telegramToken})`);

    expect(output).toBe("Unauthorized (token [REDACTED])");
    expect(redactText(`polling as bot${telegramToken}`)).toBe("polling as bot[REDACTED]");
  });

  it("is applied by the logger to every line it writes", () => {
    const lines: string[] = [];
    const print = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      logger.error(`[telegram] Send failed: Error: request to https://api.telegram.org/bot${telegramToken}/sendMessage failed`);
      logger.warn(`Slack socket closed for ${slackAppToken}`);
      logger.error(`Discord client error: invalid token ${discordToken}`);
    } finally {
      print.mockRestore();
    }

    const output = lines.join("\n");
    for (const secret of [telegramToken, slackAppToken, discordToken]) {
      expect(output).not.toContain(secret);
    }
    expect(lines[0]).toContain("[ERROR] [telegram] Send failed: Error: request to https://api.telegram.org/bot[REDACTED]/sendMessage failed");
  });

  it.each([
    ["a Discord bot token", discordToken],
    ["a Discord bot token with the longer signature", discordLongToken],
  ])("masks %s", (_label, token) => {
    expect(redactText(`login failed with ${token}.`)).toBe("login failed with [REDACTED].");
    expect(redactText(`Authorization: Bot ${token}`)).not.toContain(token);
  });

  it("masks them wherever they sit in a multi-line message", () => {
    const output = redactText([
      `Error: connect failed (${slackAppToken})`,
      `    cause: https://api.telegram.org/bot${telegramToken}/getUpdates`,
      `    retrying with ${discordToken}`,
    ].join("\n"));

    for (const secret of [slackAppToken, telegramToken, discordToken]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("/getUpdates");
  });

  it.each([
    "2026-10-12T02:50:31.032Z [INFO] Session 0f8c2d1e-5b7a-4c3d-9e1f-2a3b4c5d6e7f completed in 1234ms",
    "    at SlackConnector.start (/app/dist/src/connectors/slack/index.js:150:16)",
    "Slack message ts=1700000000.000100 thread_ts=1700000000.000200",
    "Created new session for discord:thread:1234567890123456789",
    "gateway listening on 127.0.0.1:7777 (boot 1700000000000)",
    "pulled sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "NetworkError: Network request failed: sendMessage",
    "telegram chat -1001234567890: 400: Bad Request: chat not found",
    "see https://api.telegram.org/bots/api#sendmessage and https://example.test/bot12/status",
    "com.example.application.module.SomeVeryLongClassName.method.anotherVeryLongIdentifierName",
    "Discord channel 1543864208750542941 was not found or cannot receive messages",
  ])("leaves ordinary log text alone: %s", (line) => {
    expect(redactText(line)).toBe(line);
  });

  // Shapes that only resemble a token. Masking them costs the operator the
  // one detail the log line was written for.
  const hex = (length: number) => "0123456789abcdef".repeat(4).slice(0, length);

  it.each([
    ["a short id before a 35-character hash", `sha 1234567:${hex(35)}`],
    ["a date before a 35-character hash", `build 20261012:${hex(35)}`],
    ["a date before an upper-case hash", `build 20261012:${hex(35).toUpperCase()}`],
    ["a long numeric id before a 35-character hash", `trace 12345678901234:${hex(35)}`],
    ["a bundle name before a hash", `Module_Federation_Runtime_X.bundle.${hex(40)}`],
    ["a dotted handler path", "Notification_Wake_Delivery.handle.someVeryLongIdentifierNameGoesHere12"],
    ["a long file name with two extensions", `/var/log/Maintenance-Report-2026-10-12.backup.${hex(32)}`],
  ])("does not mistake %s for a token", (_label, line) => {
    expect(redactText(line)).toBe(line);
  });

  // Bot ids are 10 digits today and keep growing; what keeps hashes from being
  // masked is the check on the secret, not the length of the id.
  it.each([8, 9, 10, 11, 12, 16])("still masks a Telegram bot token whose bot id has %i digits", (digits) => {
    const token = `${"1234567890123456".slice(0, digits)}:` + "AAE" + "abcdefghijklmnopqrstuvwxyz012345";

    expect(redactText(`Unauthorized (token ${token})`)).toBe("Unauthorized (token [REDACTED])");
  });

  it.each([17, 18, 19, 20])("still masks a Discord bot token whose bot id has %i digits", (digits) => {
    const id = Buffer.from("12345678901234567890".slice(0, digits)).toString("base64").replace(/=+$/, "");
    const token = `${id}.GAbCdE.` + "abcdefghijklmnopqrstuvwxyz_";

    expect(redactText(`login failed with ${token}.`)).toBe("login failed with [REDACTED].");
  });
});
