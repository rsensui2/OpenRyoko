import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      // paths.ts runs migrateLegacyHome() at module load — never let a
      // per-path existsSync mock reach the real renameSync.
      renameSync: vi.fn(),
    },
  };
});

import fs from "node:fs";
import {
  readManifest,
  writeManifest,
  upsertManifest,
  removeFromManifest,
  isValidSource,
  sanitizeFindQuery,
  SKILLS_JSON,
} from "../skills.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

function lastWrittenJson(): any {
  const calls = mockWriteFileSync.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [file, data] = calls[calls.length - 1];
  expect(file).toBe(SKILLS_JSON);
  return JSON.parse(String(data));
}

describe("skills.json manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it("reads the canonical object format shipped in template/skills.json", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        installed: {
          "deploy-fly": { source: "owner/repo@deploy-fly", installedAt: "2026-01-01T00:00:00Z" },
        },
      }),
    );
    expect(readManifest()).toEqual([
      { name: "deploy-fly", source: "owner/repo@deploy-fly", installedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("returns [] for the pristine template ({\"installed\": {}}) instead of crashing", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ installed: {} }));
    const manifest = readManifest();
    expect(manifest).toEqual([]);
    // Regression: the old implementation returned the raw object, so
    // Array methods used by skillsList/skillsUpdate threw TypeError.
    expect(() => manifest.map((e) => e.name)).not.toThrow();
  });

  it("still reads the legacy flat-array format", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify([{ name: "a", source: "own/rep@a", installedAt: "t" }]),
    );
    expect(readManifest()).toEqual([{ name: "a", source: "own/rep@a", installedAt: "t" }]);
  });

  it("rejects {\"installed\": [...]} instead of mis-parsing array indices as names", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ installed: [{ name: "a", source: "own/rep@a", installedAt: "t" }] }),
    );
    expect(readManifest()).toEqual([]);
  });

  it("returns [] for malformed JSON or a missing file", () => {
    mockReadFileSync.mockReturnValue("not json");
    expect(readManifest()).toEqual([]);
    mockExistsSync.mockReturnValue(false);
    expect(readManifest()).toEqual([]);
  });

  it("blanks a source that is not owner/repo[@skill]-shaped — it later reaches npx argv", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        installed: {
          evil: { source: "owner/repo@x; echo PWNED > /tmp/pwned.txt", installedAt: "t" },
          dot: { source: "./repo", installedAt: "t" },
          dotdot: { source: "../repo", installedAt: "t" },
          hidden: { source: ".hidden/repo", installedAt: "t" },
          fine: { source: "owner/repo@skill", installedAt: "t" },
          repo: { source: "owner/repo", installedAt: "t" },
        },
      }),
    );
    const byName = Object.fromEntries(readManifest().map((e) => [e.name, e.source]));
    expect(byName.evil).toBe("");
    expect(byName.dot).toBe("");
    expect(byName.dotdot).toBe("");
    expect(byName.hidden).toBe("");
    expect(byName.fine).toBe("owner/repo@skill");
    expect(byName.repo).toBe("owner/repo");
  });

  it("writes the canonical object format", () => {
    writeManifest([{ name: "a", source: "s", installedAt: "t" }]);
    expect(lastWrittenJson()).toEqual({
      installed: { a: { source: "s", installedAt: "t" } },
    });
  });

  it("upserts into a pristine template manifest end to end", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ installed: {} }));
    upsertManifest("deploy-fly", "owner/repo@deploy-fly");
    const written = lastWrittenJson();
    expect(written.installed["deploy-fly"].source).toBe("owner/repo@deploy-fly");
    expect(typeof written.installed["deploy-fly"].installedAt).toBe("string");
  });

  it("preserves fields other writers added — per entry and top-level", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        schemaVersion: 1,
        installed: {
          a: { source: "own/rep@a", installedAt: "t", description: "keep me" },
        },
      }),
    );
    upsertManifest("a", "own/rep@a2");
    const written = lastWrittenJson();
    expect(written.schemaVersion).toBe(1);
    expect(written.installed.a.description).toBe("keep me");
    expect(written.installed.a.source).toBe("own/rep@a2");
  });

  it("preserves extra legacy-array fields through the object migration", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify([{ name: "a", source: "own/rep@a", installedAt: "t", version: "1.2.3" }]),
    );
    upsertManifest("b", "own/rep@b");
    const written = lastWrittenJson();
    expect(written.installed.a.version).toBe("1.2.3");
    expect(written.installed.b.source).toBe("own/rep@b");
  });

  it("validates CLI-provided sources and sanitizes find queries (win32 shell:true path)", () => {
    expect(isValidSource("owner/repo@skill")).toBe(true);
    expect(isValidSource("owner/repo")).toBe(true);
    expect(isValidSource("owner/repo@x; echo PWNED")).toBe(false);
    expect(isValidSource("a & calc")).toBe(false);
    expect(isValidSource("../repo")).toBe(false);
    expect(sanitizeFindQuery("ios swift xcode")).toBe("ios swift xcode");
    expect(sanitizeFindQuery("react & del /q *")).toBe("react del /q");
    expect(sanitizeFindQuery('foo" | calc')).toBe("foo calc");
    expect(sanitizeFindQuery("動画生成 スライド")).toBe("動画生成 スライド");
    expect(sanitizeFindQuery("動画 & del")).toBe("動画 del");
  });

  it("removeFromManifest keeps unrelated entries and top-level fields", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        schemaVersion: 1,
        installed: {
          a: { source: "own/rep@a", installedAt: "t" },
          b: { source: "own/rep@b", installedAt: "t" },
        },
      }),
    );
    expect(removeFromManifest("a")).toBe(true);
    const written = lastWrittenJson();
    expect(written.schemaVersion).toBe(1);
    expect(written.installed).toEqual({ b: { source: "own/rep@b", installedAt: "t" } });
  });
});
