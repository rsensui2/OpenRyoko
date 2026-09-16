import { describe, expect, it } from "vitest";
import { compareSemver, isDottedNumericVersion } from "../version.js";

describe("version utilities", () => {
  it("does not advertise an older stable package to a local prerelease", () => {
    expect(compareSemver("2026.9.11-local.1", "2026.9.8")).toBeGreaterThan(0);
    expect(compareSemver("2026.9.11-local.1", "2026.9.11")).toBeLessThan(0);
    expect(compareSemver("2026.9.11-beta.2", "2026.9.11-beta.10")).toBeLessThan(0);
    expect(compareSemver("2026.9.11+build.1", "2026.9.11+build.2")).toBe(0);
  });
  it("accepts historical semver-like versions and OpenRyoko CalVer versions", () => {
    expect(isDottedNumericVersion("0.9.0")).toBe(true);
    expect(isDottedNumericVersion("2026.5.7")).toBe(true);
    expect(isDottedNumericVersion("2026.5")).toBe(false);
    expect(isDottedNumericVersion("2026.05.07-beta")).toBe(false);
  });

  it("orders CalVer versions numerically by year, month, then day", () => {
    expect(compareSemver("2026.10.1", "2026.4.30")).toBeGreaterThan(0);
    expect(compareSemver("2026.5.7", "2026.5.13")).toBeLessThan(0);
    expect(compareSemver("2026.5.13", "0.9.0")).toBeGreaterThan(0);
  });
});
