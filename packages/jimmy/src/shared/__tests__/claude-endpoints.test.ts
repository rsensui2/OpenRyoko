import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger.js";
import {
  claudeEndpointAllowsFallback,
  claudeEndpointEnvFor,
  claudeEndpointModels,
  configureClaudeEndpoints,
  findClaudeEndpoint,
  isClaudeEndpointRun,
  normalizeClaudeEndpoints,
  resetClaudeEndpointsForTests,
  withClaudeEndpointEnv,
} from "../claude-endpoints.js";

const ENDPOINT = {
  name: "local-mac",
  baseUrl: "http://100.64.0.10:1236/",
  apiKeyEnv: "TEST_ENDPOINT_KEY",
  models: ["deepseek-v41", { id: "deepseek-v41-uncensored", label: "DeepSeek (local)", contextWindow: 1_000_000 }],
};

describe("normalizeClaudeEndpoints", () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  it("accepts a valid endpoint, trims the trailing slash, and expands string models", () => {
    const [endpoint] = normalizeClaudeEndpoints([ENDPOINT]);
    expect(endpoint.baseUrl).toBe("http://100.64.0.10:1236");
    expect(endpoint.models.map((m) => m.id)).toEqual(["deepseek-v41", "deepseek-v41-uncensored"]);
    expect(endpoint.models[1]).toMatchObject({ label: "DeepSeek (local)", contextWindow: 1_000_000 });
  });

  it("treats a missing or empty block as no endpoints, without warning", () => {
    expect(normalizeClaudeEndpoints(undefined)).toEqual([]);
    expect(normalizeClaudeEndpoints([])).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["not a list", { name: "x" }],
    ["no baseUrl", [{ ...ENDPOINT, baseUrl: undefined }]],
    ["a non-http baseUrl", [{ ...ENDPOINT, baseUrl: "file:///etc/passwd" }]],
    ["no models", [{ ...ENDPOINT, models: [] }]],
    ["no key source", [{ ...ENDPOINT, apiKeyEnv: undefined }]],
    ["credentials in the baseUrl", [{ ...ENDPOINT, baseUrl: "http://user:pass@100.64.0.10:1236" }]],
    ["a query in the baseUrl", [{ ...ENDPOINT, baseUrl: "http://100.64.0.10:1236?x=1" }]],
    ["a trailing /v1", [{ ...ENDPOINT, baseUrl: "http://100.64.0.10:1236/v1/" }]],
  ])("skips an endpoint with %s and warns", (_label, raw) => {
    expect(normalizeClaudeEndpoints(raw)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps the first endpoint for a model id that two endpoints declare", () => {
    const other = { ...ENDPOINT, name: "other", baseUrl: "http://10.0.0.2:1236" };
    const endpoints = normalizeClaudeEndpoints([ENDPOINT, other]);
    expect(endpoints).toHaveLength(2);
    expect(endpoints[1].models).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("claudeEndpointEnvFor", () => {
  let dir: string;
  const saved = process.env.TEST_ENDPOINT_KEY;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-endpoints-"));
    resetClaudeEndpointsForTests();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_ENDPOINT_KEY;
    else process.env.TEST_ENDPOINT_KEY = saved;
    resetClaudeEndpointsForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a model that no endpoint serves (it goes to Anthropic as before)", () => {
    configureClaudeEndpoints([ENDPOINT]);
    expect(claudeEndpointEnvFor("claude-opus-5-5")).toBeNull();
    expect(claudeEndpointEnvFor(undefined)).toBeNull();
  });

  it("points the CLI at the endpoint with the key from the environment", () => {
    process.env.TEST_ENDPOINT_KEY = "secret-from-env";
    configureClaudeEndpoints([ENDPOINT]);
    expect(findClaudeEndpoint("deepseek-v41")?.name).toBe("local-mac");
    expect(claudeEndpointEnvFor("deepseek-v41")).toEqual({
      ANTHROPIC_BASE_URL: "http://100.64.0.10:1236",
      ANTHROPIC_API_KEY: "secret-from-env",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v41",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v41",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v41",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v41",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v41",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("reads the key from a KEY=VALUE file, picking the line named by apiKeyEnv", () => {
    delete process.env.TEST_ENDPOINT_KEY;
    const file = path.join(dir, "omlx.env");
    fs.writeFileSync(file, "# comment\nOTHER=nope\nTEST_ENDPOINT_KEY=\"secret-from-file\"\n");
    configureClaudeEndpoints([{ ...ENDPOINT, apiKeyFile: file }]);
    expect(claudeEndpointEnvFor("deepseek-v41-uncensored")?.ANTHROPIC_API_KEY).toBe("secret-from-file");
  });

  it("reads a file that holds only the bare key", () => {
    const file = path.join(dir, "key.txt");
    fs.writeFileSync(file, "bare-secret\n");
    configureClaudeEndpoints([{ ...ENDPOINT, apiKeyEnv: undefined, apiKeyFile: file }]);
    expect(claudeEndpointEnvFor("deepseek-v41")?.ANTHROPIC_API_KEY).toBe("bare-secret");
  });

  it("fails loudly when the key cannot be found, without naming where it looked", () => {
    delete process.env.TEST_ENDPOINT_KEY;
    const missing = path.join(dir, "missing.env");
    configureClaudeEndpoints([{ ...ENDPOINT, apiKeyFile: missing }]);
    expect(() => claudeEndpointEnvFor("deepseek-v41")).toThrow(/local-mac/);
    expect(() => claudeEndpointEnvFor("deepseek-v41")).not.toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not guess between several KEY=VALUE lines when apiKeyEnv is not set", () => {
    const file = path.join(dir, "shared.env");
    fs.writeFileSync(file, "SLACK_TOKEN=xoxb-unrelated\nOMLX_KEY=right\n");
    configureClaudeEndpoints([{ ...ENDPOINT, apiKeyEnv: undefined, apiKeyFile: file }]);
    expect(() => claudeEndpointEnvFor("deepseek-v41")).toThrow();
  });

  it("reads a bare base64 key and drops a trailing comment", () => {
    const bare = path.join(dir, "bare.txt");
    fs.writeFileSync(bare, "abcd==\n");
    configureClaudeEndpoints([{ ...ENDPOINT, apiKeyEnv: undefined, apiKeyFile: bare }]);
    expect(claudeEndpointEnvFor("deepseek-v41")?.ANTHROPIC_API_KEY).toBe("abcd==");
    const commented = path.join(dir, "commented.env");
    fs.writeFileSync(commented, "TEST_ENDPOINT_KEY=secret # rotated monthly\n");
    delete process.env.TEST_ENDPOINT_KEY;
    configureClaudeEndpoints([{ ...ENDPOINT, apiKeyFile: commented }]);
    expect(claudeEndpointEnvFor("deepseek-v41")?.ANTHROPIC_API_KEY).toBe("secret");
  });

  it("holds back the models of an invalid entry instead of sending them to Anthropic", () => {
    configureClaudeEndpoints([{ ...ENDPOINT, baseUrl: "not a url" }]);
    expect(() => claudeEndpointEnvFor("deepseek-v41")).toThrow(/not valid/);
    expect(isClaudeEndpointRun("claude", "deepseek-v41")).toBe(true);
  });

  it("replaces every inherited ANTHROPIC_* value for an endpoint model only", () => {
    process.env.TEST_ENDPOINT_KEY = "k";
    configureClaudeEndpoints([ENDPOINT]);
    const base = { PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "sub", ANTHROPIC_CUSTOM_HEADERS: "x: y", ANTHROPIC_BASE_URL: "https://elsewhere" };
    const local = withClaudeEndpointEnv(base, "deepseek-v41");
    expect(local.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(local.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(local.ANTHROPIC_BASE_URL).toBe("http://100.64.0.10:1236");
    expect(local.PATH).toBe("/bin");
    expect(withClaudeEndpointEnv(base, "claude-opus-5-5")).toBe(base);
  });

  it("forgets endpoints removed by a config reload", () => {
    process.env.TEST_ENDPOINT_KEY = "k";
    configureClaudeEndpoints([ENDPOINT]);
    configureClaudeEndpoints(undefined);
    expect(claudeEndpointEnvFor("deepseek-v41")).toBeNull();
  });
});

describe("isClaudeEndpointRun / claudeEndpointAllowsFallback", () => {
  afterEach(() => resetClaudeEndpointsForTests());

  it("recognizes endpoint models on the claude engine only, including the default model", () => {
    configureClaudeEndpoints([ENDPOINT], "deepseek-v41");
    expect(isClaudeEndpointRun("claude", "deepseek-v41-uncensored")).toBe(true);
    expect(isClaudeEndpointRun("claude", null)).toBe(true); // runs engines.claude.model
    expect(isClaudeEndpointRun("claude", "claude-opus-5-5")).toBe(false);
    expect(isClaudeEndpointRun("codex", "deepseek-v41")).toBe(false);
  });

  it("keeps endpoint work off the engine fallback unless the endpoint opts in", () => {
    configureClaudeEndpoints([ENDPOINT]);
    expect(claudeEndpointAllowsFallback("deepseek-v41")).toBe(false);
    configureClaudeEndpoints([{ ...ENDPOINT, fallback: true }]);
    expect(claudeEndpointAllowsFallback("deepseek-v41")).toBe(true);
  });
});

describe("claudeEndpointModels", () => {
  it("lists endpoint models for the model picker, without effort levels unless declared", () => {
    const models = claudeEndpointModels([ENDPOINT]);
    expect(models).toEqual([
      { id: "deepseek-v41", label: "deepseek-v41 (local-mac)", supportsEffort: false, effortLevels: [] },
      {
        id: "deepseek-v41-uncensored",
        label: "DeepSeek (local)",
        supportsEffort: false,
        effortLevels: [],
        contextWindow: 1_000_000,
      },
    ]);
  });
});
