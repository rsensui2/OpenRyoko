import { describe, expect, it } from "vitest";
import { containsAuthCode, isOAuthInput, parseAuthInput } from "../input.js";

const CODE = "Ab".repeat(24);
const STATE = "state_1234567890123456";

describe("parseAuthInput", () => {
  it("accepts a short device code", () => {
    expect(parseAuthInput("AB12-CD34")).toEqual({ kind: "short-code", value: "AB12-CD34" });
    expect(parseAuthInput("  FHI3-TCJKF \n")).toEqual({ kind: "short-code", value: "FHI3-TCJKF" });
  });

  it("keeps Claude's code and state together", () => {
    expect(parseAuthInput(`${CODE}#${STATE}`)).toEqual({ kind: "code-state", value: `${CODE}#${STATE}` });
    const mixed = "Ab-_".repeat(12);
    expect(parseAuthInput(`${mixed}#${STATE}`)).toEqual({ kind: "code-state", value: `${mixed}#${STATE}` });
  });

  it("turns a loopback callback URL into the code#state value", () => {
    for (const host of ["localhost:58741", "127.0.0.1:58741", "[::1]:58741"]) {
      expect(parseAuthInput(`http://${host}/callback?code=${CODE}&state=${STATE}`))
        .toEqual({ kind: "callback-url", value: `${CODE}#${STATE}` });
    }
  });

  it("rejects callback URLs that are not a loopback /callback with both fields", () => {
    expect(parseAuthInput(`https://example.com/callback?code=${CODE}&state=${STATE}`)).toBeNull();
    expect(parseAuthInput(`https://localhost:58741/callback?code=${CODE}&state=${STATE}`)).toBeNull();
    expect(parseAuthInput(`http://localhost:58741/other?code=${CODE}&state=${STATE}`)).toBeNull();
    expect(parseAuthInput(`http://localhost:58741/callback?code=${CODE}`)).toBeNull();
    expect(parseAuthInput("http://localhost:58741/callback?code=bad&state=short")).toBeNull();
    expect(parseAuthInput(`http://localhost.evil.example/callback?code=${CODE}&state=${STATE}`)).toBeNull();
  });

  it("rejects everything that is not one of the three shapes", () => {
    for (const value of [
      "", "   ", "hello", "DONE", "README", "ab12-cd34", CODE, `${CODE}#`, `#${STATE}`,
      `${CODE}#${STATE}#extra`, `${CODE} #${STATE}`, "sk-ant-oat01-" + "a".repeat(60),
      "AB12-CD34; rm -rf /", "AB12-CD34\nAB12-CD34", `${CODE}#${STATE}\u0003`, "\u001b[A", "y",
    ]) {
      expect(parseAuthInput(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("bounds the length of what it accepts", () => {
    expect(parseAuthInput(`${"a".repeat(600)}#${STATE}`)).toBeNull();
    expect(parseAuthInput(`${CODE}#${"s".repeat(600)}`)).toBeNull();
    expect(parseAuthInput(`http://localhost:1/callback?code=${CODE}&state=${STATE}&pad=${"p".repeat(5000)}`)).toBeNull();
  });
});

describe("isOAuthInput — outside a login, only a message that IS the code", () => {
  it("recognizes a message that is nothing but an OAuth value", () => {
    expect(isOAuthInput(`${CODE}#${STATE}`)).toBe(true);
    expect(isOAuthInput(`  ${CODE}#${STATE}\n`)).toBe(true);
    expect(isOAuthInput(`http://localhost:58741/callback?code=${CODE}&state=${STATE}`)).toBe(true);
  });

  it("leaves a request that merely mentions a callback URL or an anchor alone", () => {
    for (const value of [
      "この http://localhost:3000/callback?code=abc&state=xyz が 500 になる。調べて",
      "docs の installation-and-setup-guide#troubleshooting を直して",
      "http://localhost:3000/callback?code=abc&state=xyz",
      `コードは ${CODE}#${STATE} です`,
      `\`${CODE}#${STATE}\``,
      "ログイン", "https://example.com/docs", "please check #general", "issue#42",
    ]) {
      expect(isOAuthInput(value), value).toBe(false);
    }
  });

  it("does not treat a bare short code as a login artifact: outside a login it is an order number", () => {
    expect(isOAuthInput("AB12-CD34")).toBe(false);
  });
});

describe("containsAuthCode — during a login, a code anywhere in the message", () => {
  it.each([
    ["the bare value", `${CODE}#${STATE}`],
    ["in a sentence", `コードは ${CODE}#${STATE} です`],
    ["in a sentence without spaces", `コードは${CODE}#${STATE}です`],
    ["in backticks", `\`${CODE}#${STATE}\``],
    ["in a code block", `\`\`\`\n${CODE}#${STATE}\n\`\`\``],
    ["in bold", `*${CODE}#${STATE}*`],
    ["in italics", `_${CODE}#${STATE}_`],
    ["quoted", `> ${CODE}#${STATE}`],
    ["a callback URL in a sentence", `これです http://localhost:58741/callback?code=${CODE}&state=${STATE} お願いします`],
    ["a callback URL without a scheme", `localhost:58741/callback?state=${STATE}&code=${CODE}`],
    ["a malformed callback URL", "http://localhost:58741/callback?code=bad&state=short"],
  ])("finds an OAuth value, whichever login is running: %s", (_name, value) => {
    expect(containsAuthCode(value)).toBe(true);
    expect(containsAuthCode(value, { deviceCodes: true })).toBe(true);
  });

  it.each([
    ["in a sentence", "コードはFHI3-TCJKFです"],
    ["in backticks", "`AB12-CD34`"],
    ["on its own", "FHI3-TCJKF"],
  ])("finds a device code %s while a device-code login is running", (_name, value) => {
    expect(containsAuthCode(value, { deviceCodes: true })).toBe(true);
  });

  // A login that shows no device code has none to leak, and the shape is
  // common: time ranges, year ranges, ticket numbers, line anchors.
  it.each([
    "コードはFHI3-TCJKFです", "`AB12-CD34`", "1300-1500 に会議", "2025-2026 年度の計画", "VIBE-1234 を見て",
    "https://github.com/owner/repo/blob/main/src/a.ts#L100-L120",
  ])("does not take a short code for a secret when no device-code login is running: %s", (value) => {
    expect(containsAuthCode(value)).toBe(false);
    expect(containsAuthCode(value, { deviceCodes: false })).toBe(false);
  });

  it("does not see a code in ordinary text", () => {
    for (const value of [
      "", "ログイン", "今日の予定を教えて", "https://example.com/docs#install", "please check #general", "issue#42",
      "2026-10-12 の件", "docs の setup-guide#troubleshooting を直して", "PR-1234 を見て",
      "XABCD-EFGHIJ", "abcd-efgh",
    ]) {
      expect(containsAuthCode(value, { deviceCodes: true }), value).toBe(false);
    }
  });
});
