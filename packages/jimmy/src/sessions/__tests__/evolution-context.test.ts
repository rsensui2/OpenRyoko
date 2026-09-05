import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      // paths.ts runs migrateLegacyHome() at module load — never let a
      // per-path existsSync mock reach the real renameSync.
      renameSync: vi.fn(),
    },
  };
});
vi.mock("../../gateway/org.js", () => ({ scanOrg: vi.fn(() => ({ departments: [] })) }));
vi.mock("../../gateway/services.js", () => ({ buildServiceRegistry: vi.fn(() => new Map()) }));
vi.mock("../../jobs/state.js", () => ({ findJobsNeedingAttention: vi.fn(() => []) }));

import fs from "node:fs";
import { JINN_HOME } from "../../shared/paths.js";
import { buildEvolutionContext } from "../context.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function setWorkspace(opts: { bootstrap?: boolean; memory?: boolean; legacyProfile?: string }) {
  mockExistsSync.mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("BOOTSTRAP.md")) return opts.bootstrap === true;
    if (s.endsWith("MEMORY.md")) return opts.memory === true;
    return false;
  });
  mockReadFileSync.mockImplementation((p) => {
    if (String(p).endsWith("user-profile.md") && opts.legacyProfile !== undefined) {
      return opts.legacyProfile;
    }
    throw new Error("ENOENT");
  });
}

describe("buildEvolutionContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("points a fresh install at BOOTSTRAP.md instead of a parallel question flow", () => {
    setWorkspace({ bootstrap: true });
    const out = buildEvolutionContext("Ryoko");
    expect(out).toContain("ONBOARDING MODE");
    expect(out).toContain("BOOTSTRAP.md");
  });

  it("embeds the real instance home, not a hardcoded ~/.ryoko (custom RYOKO_INSTANCE installs)", () => {
    setWorkspace({ bootstrap: true });
    const out = buildEvolutionContext("Ryoko");
    expect(out).toContain(`${JINN_HOME}/BOOTSTRAP.md`);
    expect(out).not.toContain("~/.jinn");
  });

  it("does NOT trap an upgraded veteran (BOOTSTRAP.md pending + rich legacy profile) in onboarding", () => {
    setWorkspace({ bootstrap: true, legacyProfile: "x".repeat(200) });
    const out = buildEvolutionContext("Ryoko");
    expect(out).not.toContain("ONBOARDING MODE");
  });

  it("steady state teaches the two-layer memory scheme (regression: upstream 3-file scheme contradicted AGENTS.md)", () => {
    setWorkspace({ memory: true });
    const out = buildEvolutionContext("Ryoko");
    expect(out).toContain("MEMORY.md");
    expect(out).toContain("knowledge/<topic>.md");
    expect(out).not.toContain("user-profile.md");
    expect(out).not.toContain("preferences.md");
    expect(out).not.toContain("~/.jinn");
  });

  it("treats a legacy workspace with a filled user profile as already onboarded", () => {
    setWorkspace({ legacyProfile: "x".repeat(100) });
    const out = buildEvolutionContext("Ryoko");
    expect(out).not.toContain("ONBOARDING MODE");
  });

  it("falls back to inline onboarding questions when neither BOOTSTRAP.md nor persona files exist", () => {
    setWorkspace({});
    const out = buildEvolutionContext("Ryoko");
    expect(out).toContain("ONBOARDING MODE");
    expect(out).not.toContain("BOOTSTRAP.md");
    expect(out).toContain("MEMORY.md");
  });
});
