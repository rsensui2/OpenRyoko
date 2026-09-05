import { describe, it, expect } from "vitest";
import { isOperatorSpeaker } from "../operator-match.js";

// The production bug this guards against: operatorName is a nickname ("亮介")
// while chat platforms report profile names ("泉水亮介" / "Ryosuke Sensui" /
// "rsensui"). Exact matching flagged the operator himself as NOT the operator
// on every turn, turning the identity warning into noise the model ignored.

describe("isOperatorSpeaker", () => {
  const ryosukeAliases = ["泉水亮介", "Ryosuke Sensui", "rsensui"];

  it("matches a nickname operatorName against the profile name (the production bug)", () => {
    expect(isOperatorSpeaker(ryosukeAliases, "亮介")).toBe(true);
  });

  it("matches exactly and case-insensitively", () => {
    expect(isOperatorSpeaker(["RSENSUI"], "rsensui")).toBe(true);
    expect(isOperatorSpeaker(["泉水亮介"], "泉水亮介")).toBe(true);
  });

  it("does not match unrelated speakers", () => {
    expect(isOperatorSpeaker(["yoshiro.shigemitsu", "Yoshiro Shigemitsu"], "亮介")).toBe(false);
    expect(isOperatorSpeaker(["mao.arimura"], "亮介")).toBe(false);
  });

  it("never matches on a single character", () => {
    expect(isOperatorSpeaker(["泉水亮介"], "亮")).toBe(false);
    expect(isOperatorSpeaker(["a"], "andrew")).toBe(false);
  });

  it("honors explicit operatorAliases", () => {
    expect(isOperatorSpeaker(["shion.w"], "亮介", ["shion.w"])).toBe(true);
    expect(isOperatorSpeaker(["someone.else"], "亮介", ["shion.w"])).toBe(false);
  });

  it("returns false with no operator configured or no speaker info", () => {
    expect(isOperatorSpeaker(ryosukeAliases, undefined)).toBe(false);
    expect(isOperatorSpeaker(ryosukeAliases, "  ")).toBe(false);
    expect(isOperatorSpeaker([undefined, null, ""], "亮介")).toBe(false);
  });

  it("normalizes full-width/half-width forms (NFKC)", () => {
    expect(isOperatorSpeaker(["ｒｓｅｎｓｕｉ"], "rsensui")).toBe(true);
  });
});
