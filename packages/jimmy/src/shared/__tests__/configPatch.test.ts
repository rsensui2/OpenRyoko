import { describe, it, expect } from "vitest";
import { applyPatchOps, parseConfigPatch } from "../configPatch.js";

describe("applyPatchOps", () => {
  it("updates a key that still holds the old default (from matches)", () => {
    const cfg = { engines: { claude: { effortLevel: "medium" } } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", from: "medium", to: "xhigh" },
    ]);
    expect(config.engines.claude.effortLevel).toBe("xhigh");
    expect(outcomes).toEqual([
      { path: "engines.claude.effortLevel", action: "set", from: "medium", to: "xhigh" },
    ]);
  });

  it("skips a customized value (current differs from `from`)", () => {
    const cfg = { engines: { claude: { effortLevel: "high" } } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", from: "medium", to: "xhigh" },
    ]);
    expect(config.engines.claude.effortLevel).toBe("high"); // untouched
    expect(outcomes[0]).toMatchObject({ action: "skip", reason: "customized", current: "high" });
  });

  it("inserts when the key is missing", () => {
    const cfg = { engines: { claude: { bin: "claude" } } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", from: "medium", to: "xhigh" },
    ]);
    expect(config.engines.claude.effortLevel).toBe("xhigh");
    expect(outcomes[0]).toMatchObject({ action: "insert", to: "xhigh" });
  });

  it("creates intermediate objects for a deep missing path", () => {
    const { config, outcomes } = applyPatchOps({}, [
      { path: "engines.claude.effortLevel", to: "xhigh" },
    ]);
    expect(config.engines.claude.effortLevel).toBe("xhigh");
    expect(outcomes[0].action).toBe("insert");
  });

  it("is a no-op when the value already equals `to`", () => {
    const cfg = { engines: { claude: { effortLevel: "xhigh" } } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", from: "medium", to: "xhigh" },
    ]);
    expect(config.engines.claude.effortLevel).toBe("xhigh");
    expect(outcomes[0]).toMatchObject({ action: "skip", reason: "already" });
  });

  it("without `from`, never overwrites an existing value (insert-only)", () => {
    const cfg = { engines: { claude: { effortLevel: "low" } } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", to: "xhigh" },
    ]);
    expect(config.engines.claude.effortLevel).toBe("low");
    expect(outcomes[0]).toMatchObject({ action: "skip", reason: "customized" });
  });

  it("does not mutate the input config object", () => {
    const cfg = { engines: { claude: { effortLevel: "medium" } } };
    const { config } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", from: "medium", to: "xhigh" },
    ]);
    expect(cfg.engines.claude.effortLevel).toBe("medium"); // original untouched
    expect(config).not.toBe(cfg);
  });

  it("is idempotent — re-applying after a set makes no further change", () => {
    const ops = [{ path: "engines.claude.effortLevel", from: "medium", to: "xhigh" }];
    const first = applyPatchOps({ engines: { claude: { effortLevel: "medium" } } }, ops);
    const second = applyPatchOps(first.config, ops);
    expect(second.config.engines.claude.effortLevel).toBe("xhigh");
    expect(second.outcomes[0]).toMatchObject({ action: "skip", reason: "already" });
  });

  it("skips (does not clobber) when a defined non-object parent blocks the path", () => {
    const cfg = { engines: { claude: "custom-string" } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.effortLevel", from: "medium", to: "xhigh" },
    ]);
    expect(config.engines.claude).toBe("custom-string"); // untouched, not turned into an object
    expect(outcomes[0]).toMatchObject({ action: "skip", reason: "customized", current: "custom-string" });
  });

  it("supports non-string values via structural equality", () => {
    const cfg = { engines: { claude: { maxLivePtys: 8 } } };
    const { config, outcomes } = applyPatchOps(cfg, [
      { path: "engines.claude.maxLivePtys", from: 8, to: 12 },
    ]);
    expect(config.engines.claude.maxLivePtys).toBe(12);
    expect(outcomes[0].action).toBe("set");
  });
});

describe("parseConfigPatch", () => {
  it("parses a valid array of ops, preserving optional `from`", () => {
    const ops = parseConfigPatch(
      JSON.stringify([
        { path: "a.b", from: "x", to: "y" },
        { path: "c", to: 1 },
      ]),
    );
    expect(ops).toEqual([
      { path: "a.b", from: "x", to: "y" },
      { path: "c", to: 1 },
    ]);
  });

  it("rejects a non-array payload", () => {
    expect(() => parseConfigPatch(JSON.stringify({ path: "a", to: 1 }))).toThrow(/must be a JSON array/);
  });

  it("rejects an op without a path", () => {
    expect(() => parseConfigPatch(JSON.stringify([{ to: 1 }]))).toThrow(/non-empty string "path"/);
  });

  it("rejects an op without `to`", () => {
    expect(() => parseConfigPatch(JSON.stringify([{ path: "a" }]))).toThrow(/needs a "to" value/);
  });

  it('preserves an explicit `to: null` (distinct from missing)', () => {
    const ops = parseConfigPatch(JSON.stringify([{ path: "a", to: null }]));
    expect(ops).toEqual([{ path: "a", to: null }]);
  });
});
