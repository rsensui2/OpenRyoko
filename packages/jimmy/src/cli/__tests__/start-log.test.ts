import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the bundled skill sync reports at start — the skills it replaced, the ones it
// left because somebody edited them, where the previous copies went, a receipt it
// could not use — has to be in logs/gateway.log, where the Logs screen reads it. The
// logger is the real one here, writing a real file in the test home.

const mocks = vi.hoisted(() => ({
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
  loadConfig: vi.fn(),
  syncBundledSkills: vi.fn(),
}));

vi.mock("../../gateway/lifecycle.js", () => ({
  startForeground: mocks.startForeground,
  startDaemon: mocks.startDaemon,
}));
vi.mock("../../shared/process-safety-net.js", () => ({
  installProcessSafetyNet: vi.fn(),
}));
vi.mock("../../shared/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));
vi.mock("../../skills-sync/sync.js", () => ({
  syncBundledSkills: mocks.syncBundledSkills,
}));

import { configureLogger, logger } from "../../shared/logger.js";
import { LOGS_DIR } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import type { BundledSkillSync } from "../../skills-sync/types.js";
import { runStart } from "../start.js";

const LOG = path.join(LOGS_DIR, "gateway.log");
const BACKUP = "/home/.migration-backups/1.0.0-2026-10-12T03-04-05-678Z";
const REPORT: BundledSkillSync = {
  added: [], updated: ["status"], adopted: [], retired: [], inSync: ["status"], failed: [], backupDir: BACKUP,
  kept: [{ name: "onboarding", reason: "modified" }],
  notices: [{ name: "onboarding", reason: "modified" }],
};

function config(logging: JinnConfig["logging"]): JinnConfig {
  return { gateway: { host: "127.0.0.1", port: 17999 }, logging } as JinnConfig;
}

/** The log file as it stands once the logger has let go of it. */
async function written(): Promise<string> {
  configureLogger({ file: false });
  let text = "";
  await vi.waitFor(() => {
    text = fs.readFileSync(LOG, "utf8");
    expect(text).not.toBe("");
  }, { timeout: 10_000 });
  return text;
}

const count = (text: string, pattern: RegExp) => text.split("\n").filter((line) => pattern.test(line)).length;

// One test goes round forty times and waits for the log file each time: seconds in
// all, and more than the default limit of five on a slow disk.
describe("ryoko start: where the bundled skill sync's report goes", { timeout: 60_000 }, () => {
  beforeEach(() => {
    fs.rmSync(LOG, { force: true });
    mocks.loadConfig.mockReset().mockReturnValue(config({ level: "info", stdout: false, file: true }));
    mocks.syncBundledSkills.mockReset().mockReturnValue(REPORT);
    mocks.startDaemon.mockReset();
    // The gateway sets the logger up for itself as it boots, the same way.
    mocks.startForeground.mockReset().mockImplementation(async (booting: JinnConfig) => {
      configureLogger(booting.logging);
      logger.info("Starting gateway");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    configureLogger({ level: "info", stdout: true, file: false });
    vi.restoreAllMocks();
  });

  it.each([
    ["in the foreground", {}],
    ["as a daemon, from the process that launches it", { daemon: true }],
  ])("is in logs/gateway.log %s, each line once", async (_label, opts) => {
    await runStart(opts);

    const log = await written();
    expect(count(log, /\[INFO\] Bundled skills synced: updated status\./)).toBe(1);
    expect(log).toContain(`Previous copies are in ${BACKUP}.`);
    expect(count(log, /\[WARN\] Bundled skills not updated .* edited locally: onboarding\./)).toBe(1);
  });

  it("is still there, and ahead of what the gateway logs next, after the gateway has set its own logging up", async () => {
    // Out of order it would read as if the gateway had started and the skills were
    // synced afterwards. It used to happen about one time in three: hence the rounds.
    for (let round = 0; round < 40; round++) {
      fs.rmSync(LOG, { force: true });

      await runStart({});

      const lines = (await written()).split("\n").filter(Boolean).map((line) => line.replace(/^\S+ \[\w+\] /, "").slice(0, 22));
      expect(lines, `round ${round}`).toEqual(["Bundled skills synced:", "Bundled skills not upd", "Starting gateway"]);
    }
  });

  it("includes the error when the sync could not run at all", async () => {
    mocks.syncBundledSkills.mockImplementation(() => { throw new Error("Cannot use skills/.shipped-skills.json: it is not valid JSON"); });

    await runStart({});

    expect(await written()).toMatch(/\[ERROR\] Bundled skills were not synced \(startup continues\): Cannot use skills\/\.shipped-skills\.json/);
    expect(mocks.startForeground).toHaveBeenCalledTimes(1);
  });

  it("shows on the standard output once as well, when the config says to log there", async () => {
    mocks.loadConfig.mockReturnValue(config({ level: "info", stdout: true, file: true }));

    await runStart({});

    const shown = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(shown.filter((line) => /Bundled skills synced/.test(line))).toHaveLength(1);
    expect(count(await written(), /Bundled skills synced/)).toBe(1);
  });

  it.each<[string, { daemon?: boolean }]>([
    ["in the foreground", {}],
    ["in the process that launches the daemon", { daemon: true }],
  ])("neither stops the start nor brings the process down when the log file cannot be opened (%s)", async (_label, opts) => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.loadConfig.mockReturnValue(config({ level: "info", stdout: true, file: true }));
    mocks.startForeground.mockReset().mockResolvedValue(undefined);
    // Something that is not a file sits where the log goes.
    fs.mkdirSync(LOG, { recursive: true });
    try {
      await expect(runStart(opts)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(warned).toHaveBeenCalled());

      expect(mocks.syncBundledSkills).toHaveBeenCalledTimes(1);
      expect(opts.daemon ? mocks.startDaemon : mocks.startForeground).toHaveBeenCalledTimes(1);
      // The report is not lost with the file: it is on the standard output.
      expect(vi.mocked(console.log).mock.calls.map((call) => String(call[0])).filter((line) => /Bundled skills synced/.test(line))).toHaveLength(1);
    } finally {
      configureLogger({ file: false });
      fs.rmSync(LOG, { recursive: true, force: true });
    }
  });

  it("stays out of the file when the config turns the log file off", async () => {
    mocks.loadConfig.mockReturnValue(config({ level: "info", stdout: true, file: false }));

    await runStart({});

    configureLogger({ file: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(LOG)).toBe(false);
    expect(vi.mocked(console.log).mock.calls.map((call) => String(call[0])).filter((line) => /Bundled skills synced/.test(line))).toHaveLength(1);
  });
});
