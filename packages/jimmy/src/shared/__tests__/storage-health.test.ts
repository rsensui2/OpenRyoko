import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { clearDiskSpaceCacheForTests, evaluateDiskSpace, getDiskSpaceStatus } from "../storage-health.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockReset();
  clearDiskSpaceCacheForTests();
});

describe("disk space evaluation", () => {
  it("classifies healthy, warning, and critical capacity", () => {
    expect(evaluateDiskSpace({ bsize: 1024, blocks: 10_000_000, bavail: 5_000_000 } as never).level).toBe("ok");
    expect(evaluateDiskSpace({ bsize: 1024, blocks: 10_000_000, bavail: 500_000 } as never).level).toBe("warning");
    expect(evaluateDiskSpace({ bsize: 1024, blocks: 10_000_000, bavail: 100_000 } as never).level).toBe("critical");
  });

  it("warns when free percentage is below five percent even above one GiB", () => {
    const status = evaluateDiskSpace({ bsize: 1024, blocks: 100_000_000, bavail: 4_900_000 } as never);
    expect(status.level).toBe("warning");
    expect(status.freePercent).toBeCloseTo(4.9);
  });
});

describe("disk space collection", () => {
  it("uses Linux fragment units even when Node has no frsize and bsize is inflated", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const native = vi.spyOn(fs, "statfsSync").mockReturnValue({ bsize: 1048576, blocks: 975653540, bavail: 224000000 } as fs.StatsFs);
    vi.mocked(execFileSync).mockReturnValue("4096 975653540 224000000\n");
    const status = getDiskSpaceStatus("/path with spaces", 1000);
    expect(status.totalBytes).toBe(3996276899840);
    expect(status.freeBytes).toBe(917504000000);
    expect(native).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith("stat", ["-f", "-c", "%S %b %a", "--", "/path with spaces"], expect.objectContaining({ timeout: 2000 }));
    getDiskSpaceStatus("/path with spaces", 2000);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    getDiskSpaceStatus("/path with spaces", 32000);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns unknown rather than an inflated estimate when Linux stat fails", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("timeout"); });
    expect(getDiskSpaceStatus("/failed").level).toBe("unknown");
  });

  it.each(["broken", "0 1 1", "4096 0 0", "4096 1 -1"])("rejects malformed statistics: %s", output => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(execFileSync).mockReturnValue(output);
    expect(getDiskSpaceStatus("/invalid").level).toBe("unknown");
  });

  it("preserves native statfs on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bsize: 4096, blocks: 1000000, bavail: 500000 } as fs.StatsFs);
    expect(getDiskSpaceStatus("/native").freeBytes).toBe(2048000000);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
