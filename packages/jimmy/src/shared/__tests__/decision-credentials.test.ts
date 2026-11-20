import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_PROVIDERS, decisionCredentialPath, deleteDecisionApiKey, getDecisionCredentialStatus,
  resolveDecisionApiKey, saveDecisionApiKey,
} from "../decision-credentials.js";
import { resolveTypeSafeApiKey } from "../typesafe-credentials.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "decision-credentials-test-"));
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe("per-provider decision credentials", () => {
  it.each(DECISION_PROVIDERS)("stores the %s key owner-only in its own file", (provider) => {
    expect(getDecisionCredentialStatus(provider, home)).toEqual({ configured: false, source: "none" });
    expect(saveDecisionApiKey(provider, `apikey_${provider}_fixture`, home)).toEqual({ configured: true, source: "stored" });
    expect(decisionCredentialPath(provider, home)).toBe(path.join(home, "credentials", `${provider}.json`));
    expect(fs.statSync(decisionCredentialPath(provider, home)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, "credentials"))).toEqual([`${provider}.json`]);
    expect(resolveDecisionApiKey(provider, undefined, home)).toBe(`apikey_${provider}_fixture`);
    expect(JSON.parse(fs.readFileSync(decisionCredentialPath(provider, home), "utf8"))).toEqual({ version: 1, apiKey: `apikey_${provider}_fixture` });
  });

  it("keeps providers isolated from each other", () => {
    saveDecisionApiKey("openai", "apikey_openai_fixture", home);
    vi.stubEnv("TYPESAFE_API_KEY", "apikey_typesafe_env_fixture");
    expect(resolveDecisionApiKey("openrouter", undefined, home)).toBeUndefined();
    expect(resolveDecisionApiKey("typesafe", undefined, home)).toBe("apikey_typesafe_env_fixture");
    expect(resolveTypeSafeApiKey(undefined, home)).toBe("apikey_typesafe_env_fixture");
    expect(deleteDecisionApiKey("typesafe", home)).toEqual({ configured: true, source: "environment" });
    expect(resolveDecisionApiKey("openai", undefined, home)).toBe("apikey_openai_fixture");
    expect(deleteDecisionApiKey("openai", home)).toEqual({ configured: false, source: "none" });
  });

  it.each([["openrouter", "OPENROUTER_API_KEY"], ["openai", "OPENAI_API_KEY"]] as const)("falls back to %s's environment variable", (provider, env) => {
    vi.stubEnv(env, "apikey_from_environment");
    expect(getDecisionCredentialStatus(provider, home)).toEqual({ configured: true, source: "environment" });
    expect(resolveDecisionApiKey(provider, undefined, home)).toBe("apikey_from_environment");
    saveDecisionApiKey(provider, "apikey_saved_fixture", home);
    expect(resolveDecisionApiKey(provider, undefined, home)).toBe("apikey_saved_fixture");
  });

  it("rejects provider names outside the fixed list", () => {
    expect(() => decisionCredentialPath("../config" as never, home)).toThrow("storage_unavailable");
    expect(() => saveDecisionApiKey("../config" as never, "apikey_fixture_value", home)).toThrow("storage_unavailable");
    expect(resolveDecisionApiKey("anthropic" as never, undefined, home)).toBeUndefined();
    expect(getDecisionCredentialStatus("anthropic" as never, home)).toEqual({ configured: false, source: "none" });
  });

  it("rejects invalid keys without storing them", () => {
    expect(() => saveDecisionApiKey("openai", "sk bad\nkey", home)).toThrow("invalid_key");
    expect(fs.existsSync(decisionCredentialPath("openai", home))).toBe(false);
  });
});
