import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

const warn = vi.fn();
vi.mock("../../shared/logger.js", () => ({
  logger: { warn: (...args: unknown[]) => warn(...args), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { scanOrg } from "../org.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("scanOrg — peer block", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-peer-"));
    warn.mockClear();
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it.each(["shared", "own"] as const)("reads memory: %s", (memory) => {
    writeYaml("ryokos", "hana.yaml", `name: hana\ndisplayName: Hana\ndepartment: ryokos\nrank: executive\npersona: Calm.\npeer:\n  memory: ${memory}\n`);
    const hana = scanOrg().get("hana");
    expect(hana?.peer).toEqual({ memory });
    expect(hana?.rank).toBe("executive");
    expect(hana?.reportsTo).toBeUndefined();
  });

  it.each([
    ["an unknown mode", "peer:\n  memory: everything\n"],
    ["a scalar", "peer: true\n"],
    ["a missing mode", "peer: {}\n"],
  ])("treats %s as not a peer, with a warning", (_label, block) => {
    writeYaml("ryokos", "hana.yaml", `name: hana\npersona: Calm.\n${block}`);
    const hana = scanOrg().get("hana");
    expect(hana).toBeDefined();
    expect(hana?.peer).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid peer block"));
  });

  it("leaves ordinary employees without a peer field", () => {
    writeYaml("eng", "dev.yaml", "name: dev\npersona: Builds.\n");
    expect(scanOrg().get("dev")).not.toHaveProperty("peer");
    expect(warn).not.toHaveBeenCalled();
  });
});
