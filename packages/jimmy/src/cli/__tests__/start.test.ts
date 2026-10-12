import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `ryoko start` without --daemon IS the gateway process (this is how the Docker
// image runs it), so it must install the process safety net itself. The net
// keeps the process alive on a stray rejection, which makes one thing the
// caller's job: a boot that fails still has to end the process.
//
// Either way, the skills the package ships are synced into the home before the
// gateway comes up — in the foreground, with the net already in place.

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
  installProcessSafetyNet: vi.fn(),
  loadConfig: vi.fn(),
  syncBundledSkills: vi.fn(),
}));

vi.mock("../../gateway/lifecycle.js", () => ({
  startForeground: mocks.startForeground,
  startDaemon: mocks.startDaemon,
}));
vi.mock("../../shared/process-safety-net.js", () => ({
  installProcessSafetyNet: mocks.installProcessSafetyNet,
}));
vi.mock("../../shared/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));
// The real start-up hook of the sync runs; only the engine underneath it is replaced.
vi.mock("../../skills-sync/sync.js", () => ({
  syncBundledSkills: mocks.syncBundledSkills,
}));

import { logger } from "../../shared/logger.js";
import { JINN_HOME, TEMPLATE_DIR } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import type { BundledSkillSync } from "../../skills-sync/types.js";

const { runStart } = await import("../start.js");

const NOTHING: BundledSkillSync = {
  added: [], updated: [], adopted: [], retired: [], kept: [], notices: [], inSync: [], failed: [], backupDir: null,
};

function config(overrides: Partial<JinnConfig> = {}): JinnConfig {
  // Never a real gateway: lifecycle is mocked, and the port is not the production one.
  return { gateway: { host: "127.0.0.1", port: 17999 }, ...overrides } as JinnConfig;
}

describe("runStart", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.installProcessSafetyNet.mockReset().mockImplementation(() => { mocks.calls.push("safety-net"); return true; });
    mocks.startForeground.mockReset().mockImplementation(async () => { mocks.calls.push("gateway"); });
    mocks.startDaemon.mockReset().mockImplementation(() => { mocks.calls.push("daemon"); });
    mocks.syncBundledSkills.mockReset().mockImplementation(() => { mocks.calls.push("skills"); return NOTHING; });
    mocks.loadConfig.mockReset().mockReturnValue(config());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("in the foreground", () => {
    it("installs the safety net, then syncs bundled skills, then starts the gateway", async () => {
      await runStart({});

      // The net first: whatever goes wrong from here on, in the sync included, must
      // not take down the process that is about to be the gateway.
      expect(mocks.calls).toEqual(["safety-net", "skills", "gateway"]);
      expect(mocks.startDaemon).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });

    it("syncs the bundled skills of this instance, without putting back any the operator deleted", async () => {
      await runStart({});

      expect(mocks.syncBundledSkills).toHaveBeenCalledTimes(1);
      expect(mocks.syncBundledSkills.mock.calls[0][0]).toMatchObject({
        home: JINN_HOME,
        templateDir: TEMPLATE_DIR,
        packageVersion: "1.0.0",
        restoreDeleted: false,
      });
    });

    it("ends the process when the gateway fails to boot", async () => {
      const failure = new Error("sessions database is locked");
      mocks.startForeground.mockRejectedValue(failure);

      await runStart({});

      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr.mock.calls.flat()).toContain(failure);
    });
  });

  describe("as a daemon", () => {
    it("syncs bundled skills before forking the daemon", async () => {
      await runStart({ daemon: true });

      expect(mocks.calls).toEqual(["skills", "daemon"]);
      expect(mocks.startForeground).not.toHaveBeenCalled();
    });

    it("leaves the launching CLI process alone when it only forks the daemon", async () => {
      await runStart({ daemon: true });

      expect(mocks.startDaemon).toHaveBeenCalledTimes(1);
      expect(mocks.installProcessSafetyNet).not.toHaveBeenCalled();
      expect(mocks.startForeground).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["in the foreground", {}, mocks.startForeground],
    ["as a daemon", { daemon: true }, mocks.startDaemon],
  ])("still starts %s when the sync throws", async (_label, opts, start) => {
    mocks.syncBundledSkills.mockImplementation(() => { throw new Error("receipt is unreadable"); });

    await expect(runStart(opts)).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("receipt is unreadable"));
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not sync when skills.autoSync is false, and starts as usual", async () => {
    mocks.loadConfig.mockReturnValue(config({ skills: { autoSync: false } }));

    await runStart({});

    expect(mocks.syncBundledSkills).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(["safety-net", "gateway"]);
  });
});
