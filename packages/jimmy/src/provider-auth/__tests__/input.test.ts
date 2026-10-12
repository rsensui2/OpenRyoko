import { describe, expect, it } from "vitest";
import { looksLikeAuthSecret, parseAuthInput } from "../input.js";

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

describe("looksLikeAuthSecret", () => {
  it("flags OAuth artifacts even when they are malformed", () => {
    expect(looksLikeAuthSecret(`${CODE}#${STATE}`)).toBe(true);
    expect(looksLikeAuthSecret(`http://localhost:58741/callback?code=${CODE}&state=${STATE}`)).toBe(true);
    expect(looksLikeAuthSecret("http://localhost:58741/callback?code=bad&state=short")).toBe(true);
  });

  it("leaves ordinary messages alone", () => {
    for (const value of ["ログイン", "AB12-CD34", "https://example.com/docs", "please check #general", "issue#42"]) {
      expect(looksLikeAuthSecret(value), value).toBe(false);
    }
  });
});
