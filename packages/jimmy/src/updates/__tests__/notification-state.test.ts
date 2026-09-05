import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateStatePath } = vi.hoisted(() => ({
  updateStatePath: `/tmp/openryoko-update-state-test-${process.pid}/state.json`,
}));

vi.mock("../../shared/paths.js", () => ({ UPDATE_STATE: updateStatePath }));

import { getLastNotifiedVersion, markVersionNotified } from "../notification-state.js";

describe("update notification state", () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(updateStatePath), { recursive: true, force: true });
  });

  it("treats missing and malformed state as empty", () => {
    expect(getLastNotifiedVersion("job-a")).toBeUndefined();
    fs.mkdirSync(path.dirname(updateStatePath), { recursive: true });
    fs.writeFileSync(updateStatePath, "not json", "utf-8");
    expect(getLastNotifiedVersion("job-a")).toBeUndefined();
  });

  it("preserves notification versions for multiple jobs", () => {
    markVersionNotified("job-a", "2026.8.19");
    markVersionNotified("job-b", "2026.8.20");

    expect(getLastNotifiedVersion("job-a")).toBe("2026.8.19");
    expect(getLastNotifiedVersion("job-b")).toBe("2026.8.20");
    expect(fs.readdirSync(path.dirname(updateStatePath))).toEqual(["state.json"]);
  });

  it("filters non-string values and writes private file permissions", () => {
    fs.mkdirSync(path.dirname(updateStatePath), { recursive: true });
    fs.writeFileSync(updateStatePath, JSON.stringify({
      notifiedVersions: { valid: "2026.8.19", invalid: 42 },
    }), "utf-8");

    expect(getLastNotifiedVersion("valid")).toBe("2026.8.19");
    expect(getLastNotifiedVersion("invalid")).toBeUndefined();

    markVersionNotified("next", "2026.8.20");
    expect(fs.statSync(updateStatePath).mode & 0o777).toBe(0o600);
  });
});
