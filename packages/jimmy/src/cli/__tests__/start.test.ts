import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../gateway/lifecycle.js", () => ({
  startForeground: vi.fn(async () => {}),
  startDaemon: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(),
}));

// The real boot hook runs; only the engine underneath it is replaced.
vi.mock("../../skills-sync/sync.js", () => ({
  syncBundledSkills: vi.fn(),
}));

import { startDaemon, startForeground } from "../../gateway/lifecycle.js";
import { loadConfig } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import { JINN_HOME, TEMPLATE_DIR } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { getPackageVersion } from "../../shared/version.js";
import { syncBundledSkills } from "../../skills-sync/sync.js";
import type { BundledSkillSync } from "../../skills-sync/types.js";
import { runStart } from "../start.js";

const NOTHING: BundledSkillSync = {
  added: [], updated: [], adopted: [], retired: [], kept: [], notices: [], inSync: [], failed: [], backupDir: null,
};

function config(overrides: Partial<JinnConfig> = {}): JinnConfig {
  // Never a real gateway: lifecycle is mocked, and the port is not the production one.
  return { gateway: { host: "127.0.0.1", port: 17999 }, ...overrides } as JinnConfig;
}

const order = (mock: unknown) => vi.mocked(mock as () => void).mock.invocationCallOrder[0];

describe("ryoko start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue(config());
    vi.mocked(syncBundledSkills).mockReturnValue(NOTHING);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs bundled skills for this instance before the gateway starts in the foreground", async () => {
    await runStart({});

    expect(syncBundledSkills).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncBundledSkills).mock.calls[0][0]).toMatchObject({
      home: JINN_HOME,
      templateDir: TEMPLATE_DIR,
      packageVersion: getPackageVersion(),
      // Starting the gateway never puts back a skill the operator deleted.
      restoreDeleted: false,
    });
    expect(startForeground).toHaveBeenCalledTimes(1);
    expect(startDaemon).not.toHaveBeenCalled();
    expect(order(syncBundledSkills)).toBeLessThan(order(startForeground));
  });

  it("syncs bundled skills before forking the daemon", async () => {
    await runStart({ daemon: true });

    expect(syncBundledSkills).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startForeground).not.toHaveBeenCalled();
    expect(order(syncBundledSkills)).toBeLessThan(order(startDaemon));
  });

  it.each([
    ["in the foreground", {}, startForeground],
    ["as a daemon", { daemon: true }, startDaemon],
  ])("still starts %s when the sync throws", async (_label, opts, start) => {
    vi.mocked(syncBundledSkills).mockImplementation(() => { throw new Error("receipt is unreadable"); });

    await expect(runStart(opts)).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("receipt is unreadable"));
  });

  it("does not sync when skills.autoSync is false, and starts as usual", async () => {
    vi.mocked(loadConfig).mockReturnValue(config({ skills: { autoSync: false } }));

    await runStart({});

    expect(syncBundledSkills).not.toHaveBeenCalled();
    expect(startForeground).toHaveBeenCalledTimes(1);
  });
});
