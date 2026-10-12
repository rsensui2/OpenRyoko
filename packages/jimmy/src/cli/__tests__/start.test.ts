import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `ryoko start` without --daemon IS the gateway process (this is how the Docker
// image runs it), so it must install the process safety net itself. The net
// keeps the process alive on a stray rejection, which makes one thing the
// caller's job: a boot that fails still has to end the process.

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
  installProcessSafetyNet: vi.fn(),
}));

vi.mock("../../gateway/lifecycle.js", () => ({
  startForeground: mocks.startForeground,
  startDaemon: mocks.startDaemon,
}));
vi.mock("../../shared/process-safety-net.js", () => ({
  installProcessSafetyNet: mocks.installProcessSafetyNet,
}));
vi.mock("../../shared/config.js", () => ({
  loadConfig: () => ({ gateway: { host: "127.0.0.1", port: 7788 } }),
}));
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));

const { runStart } = await import("../start.js");

describe("runStart", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.installProcessSafetyNet.mockReset().mockImplementation(() => { mocks.calls.push("safety-net"); return true; });
    mocks.startForeground.mockReset().mockImplementation(async () => { mocks.calls.push("gateway"); });
    mocks.startDaemon.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs the safety net before the foreground gateway starts", async () => {
    await runStart({});

    expect(mocks.calls).toEqual(["safety-net", "gateway"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("ends the process when the foreground gateway fails to boot", async () => {
    const failure = new Error("sessions database is locked");
    mocks.startForeground.mockRejectedValue(failure);

    await runStart({});

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.flat()).toContain(failure);
  });

  it("leaves the launching CLI process alone when it only forks the daemon", async () => {
    await runStart({ daemon: true });

    expect(mocks.startDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.installProcessSafetyNet).not.toHaveBeenCalled();
    expect(mocks.startForeground).not.toHaveBeenCalled();
  });
});
