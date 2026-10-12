import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs to control filesystem responses
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      lstatSync: vi.fn(),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      symlinkSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
    },
  };
});

// Mock shared modules
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({
    engines: {
      default: "claude",
      claude: { bin: "/usr/local/bin/claude" },
    },
  })),
}));

vi.mock("../../shared/version.js", () => ({
  compareSemver: vi.fn(() => -1), // instance behind package
  getPackageVersion: vi.fn(() => "1.1.0"),
  getInstanceVersion: vi.fn(() => "1.0.0"),
  getPendingMigrations: vi.fn(() => ["1.1.0"]),
}));

// Gateway start and `ryoko migrate` share one bundled-skill sync; its own suite
// covers what it does to a home. Here it only has to be called and reported.
vi.mock("../../skills-sync/instance.js", () => ({
  syncInstanceBundledSkills: vi.fn(),
}));

// The copy of package files into the home has its own suite, on a real filesystem.
// Here it only has to be asked for the right tree in the right place.
vi.mock("../home-copy.js", () => ({
  placeTree: vi.fn(),
  removePlacedTree: vi.fn(),
}));

// config.yaml is read and written through the shared config writer, not
// through fs directly — the version stamp shows up as updateConfigDocument.
vi.mock("../../shared/config-file.js", () => ({
  readConfigSnapshot: vi.fn(() => ({ raw: null, bytes: null, mode: null, document: {}, revision: "" })),
  writeConfigDocument: vi.fn(() => "revision"),
  updateConfigDocument: vi.fn(() => "revision"),
}));

// What the audit finds and fixes is its own suite's business. Here it only reports.
vi.mock("../gateway-audit.js", () => ({
  auditGatewayReferences: vi.fn(),
}));

import { compareSemver } from "../../shared/version.js";
import { JINN_HOME } from "../../shared/paths.js";
import { auditGatewayReferences, type GatewayAuditReport } from "../gateway-audit.js";
import { output, resetMigrateMocks } from "./migrate-harness.js";

const audited = (overrides: Partial<GatewayAuditReport>): void => {
  vi.mocked(auditGatewayReferences).mockReturnValue({ legacyFiles: [], legacyOccurrences: 0, fixedFiles: [], unauthenticatedCurlCandidates: [], ...overrides });
};

describe("migrate: what it says about the gateway URL fix", () => {
  beforeEach(() => {
    resetMigrateMocks();
    // Nothing else to do: the instance is up to date.
    vi.mocked(compareSemver).mockReturnValue(0);
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    vi.mocked(compareSemver).mockReturnValue(-1);
  });

  it.each([{ fix: true }, { auto: true }])("asks for the fix under %j, and says what was fixed and where the originals are", async (opts) => {
    audited({ legacyFiles: ["AGENTS.md", "cron/jobs.json"], legacyOccurrences: 3, fixedFiles: ["AGENTS.md", "cron/jobs.json"], backupDir: "/home/backups/gateway-url-x" });
    const { runMigrate } = await import("../migrate.js");

    await runMigrate(opts);

    expect(auditGatewayReferences).toHaveBeenCalledExactlyOnceWith(JINN_HOME, { fix: true });
    expect(output()).toMatch(/\[gateway URL\] 3箇所 \/ 2ファイルをloopback URLへ修正しました/);
    expect(output()).toContain("/home/backups/gateway-url-x");
  });

  it("does not claim a fix it was refused, and says why", async () => {
    audited({ legacyFiles: ["AGENTS.md", "cron/jobs.json"], legacyOccurrences: 3, fixRefused: "/home/backups is not a plain directory\u001b[2K\nforged" });
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ fix: true });

    expect(output()).not.toMatch(/修正しました/);
    expect(output()).toMatch(/\[gateway URL warning\] 3箇所 \/ 2ファイル/);
    expect(output()).toMatch(/修正していません.*\/home\/backups is not a plain directory/);
    // The reason carries a path from the home: nothing in it may redraw the terminal.
    const line = output().split("\n").find((printed) => printed.includes("修正していません")) ?? "";
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line).toContain("forged");
  });

  it("only warns, with the way to fix, when it was not asked to", async () => {
    audited({ legacyFiles: ["AGENTS.md"], legacyOccurrences: 1 });
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(auditGatewayReferences).toHaveBeenCalledExactlyOnceWith(JINN_HOME, { fix: false });
    expect(output()).toMatch(/\[gateway URL warning\]/);
    expect(output()).toMatch(/ryoko migrate --fix/);
  });
});
