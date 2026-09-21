import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteTypeSafeApiKey, getTypeSafeCredentialStatus, resolveTypeSafeApiKey,
  saveTypeSafeApiKey, typeSafeCredentialPath,
} from "../typesafe-credentials.js";
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "typesafe-credentials-test-"));
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("JEV_CUSTOM_KEY", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe("TypeSafe private credentials", () => {
  it("persists an owner-only key independently of environment and config", () => {
    expect(getTypeSafeCredentialStatus(home)).toEqual({ configured: false, source: "none" });
    expect(saveTypeSafeApiKey("apikey_saved_fixture", home)).toEqual({ configured: true, source: "stored" });
    expect(resolveTypeSafeApiKey(undefined, home)).toBe("apikey_saved_fixture");
    expect(getTypeSafeCredentialStatus(home)).toEqual({ configured: true, source: "stored" });
    expect(fs.statSync(typeSafeCredentialPath(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "credentials")).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.join(home, "credentials"))).toEqual(["typesafe.json"]);
    expect(JSON.stringify(getTypeSafeCredentialStatus(home))).not.toContain("apikey_");
  });
  it("hot-reloads the stored key and leaves custom env namespaces isolated", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_environment_fixture");
    expect(resolveTypeSafeApiKey(undefined, home)).toBe("apikey_environment_fixture");
    saveTypeSafeApiKey("apikey_first_fixture", home);
    expect(resolveTypeSafeApiKey(undefined, home)).toBe("apikey_first_fixture");
    saveTypeSafeApiKey("apikey_second_fixture", home);
    expect(resolveTypeSafeApiKey(undefined, home)).toBe("apikey_second_fixture");
    expect(resolveTypeSafeApiKey("JEV_CUSTOM_KEY", home)).toBeUndefined();
    vi.stubEnv("JEV_CUSTOM_KEY", "apikey_custom_fixture");
    expect(resolveTypeSafeApiKey("JEV_CUSTOM_KEY", home)).toBe("apikey_custom_fixture");
  });
  it("deletes only the saved override and restores environment configuration", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_environment_fixture");
    saveTypeSafeApiKey("apikey_saved_fixture", home);
    expect(deleteTypeSafeApiKey(home)).toEqual({ configured: true, source: "environment" });
    expect(resolveTypeSafeApiKey(undefined, home)).toBe("apikey_environment_fixture");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(deleteTypeSafeApiKey(home)).toEqual({ configured: false, source: "none" });
  });
  it.each(["", "short", "apikey_a\nb", "apikey_a\rb", "apikey_a\u0000b", "apikey_a\u0085b", "api key invalid", "a".repeat(4097), 123])("rejects invalid key input without storing it", (key) => {
    expect(() => saveTypeSafeApiKey(key, home)).toThrow("invalid_key");
    expect(fs.existsSync(typeSafeCredentialPath(home))).toBe(false);
  });
  it("treats corrupt and oversized stored values as unavailable", () => {
    fs.mkdirSync(path.join(home, "credentials"));
    fs.writeFileSync(typeSafeCredentialPath(home), "{bad json");
    expect(resolveTypeSafeApiKey(undefined, home)).toBeUndefined();
    fs.writeFileSync(typeSafeCredentialPath(home), " ".repeat(8193));
    expect(getTypeSafeCredentialStatus(home)).toEqual({ configured: false, source: "none" });
  });
  it("normalizes storage failures without echoing keys or private paths", () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("permission denied apikey_secret_fixture /private/path"); });
    expect(() => saveTypeSafeApiKey("apikey_secret_fixture", home)).toThrow(/^storage_unavailable$/);
  });
  it("does not follow a credential directory symlink", () => {
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, "credentials"));
    expect(() => saveTypeSafeApiKey("apikey_secret_fixture", home)).toThrow(/^storage_unavailable$/);
    expect(resolveTypeSafeApiKey(undefined, home)).toBeUndefined();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
