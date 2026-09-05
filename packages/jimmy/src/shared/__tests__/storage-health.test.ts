import { describe, expect, it } from "vitest";
import { evaluateDiskSpace } from "../storage-health.js";

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
