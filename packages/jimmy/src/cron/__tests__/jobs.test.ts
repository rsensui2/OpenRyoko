import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-cron-storage-"));
process.env.RYOKO_HOME = root;
const filename = path.join(root, "cron", "jobs.json");
const job = { id: "one", name: "One", enabled: true, schedule: "0 0 1 1 *", prompt: "test" };
let storage: typeof import("../jobs.js");

beforeAll(async () => { storage = await import("../jobs.js"); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(path.dirname(filename), { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("cron job storage", () => {
  it("allows a fresh installation to be empty but detects a missing file during reconciliation", () => {
    expect(storage.loadJobs()).toEqual([]);
    expect(() => storage.loadJobs({ allowMissing: false })).toThrow(/missing/i);
  });

  it.each(["[{", "null", "{}", '[{"id":"one"}]', JSON.stringify([job, job])])(
    "rejects malformed or ambiguous data instead of treating it as an empty schedule: %s", raw => {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, raw);
      expect(() => storage.loadJobs()).toThrow();
      expect(fs.readFileSync(filename, "utf8")).toBe(raw);
    },
  );

  it("does not include file contents in a JSON parse error", () => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, '[{"prompt":"PRIVATE_CONTENT"');
    try { storage.loadJobs(); throw new Error("expected failure"); } catch (error) {
      expect(String(error)).toContain("invalid JSON");
      expect(String(error)).not.toContain("PRIVATE_CONTENT");
    }
  });

  it("atomically replaces a complete document and accepts an explicit empty list", () => {
    storage.saveJobs([job]);
    expect(storage.loadJobs()).toEqual([job]);
    expect(fs.readdirSync(path.dirname(filename))).toEqual(["jobs.json"]);
    storage.saveJobs([]);
    expect(storage.loadJobs({ allowMissing: false })).toEqual([]);
  });

  it("preserves the prior file and cleans up temporary data when replacement fails", () => {
    storage.saveJobs([job]);
    const before = fs.readFileSync(filename, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
    expect(() => storage.saveJobs([])).toThrow("rename failed");
    expect(fs.readFileSync(filename, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(filename))).toEqual(["jobs.json"]);
  });
});
