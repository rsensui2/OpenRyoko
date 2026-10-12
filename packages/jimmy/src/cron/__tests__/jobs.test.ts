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

describe("cron run history", () => {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    timestamp: `2026-10-0${n}T07:00:00.000Z`, status: n % 2 ? "success" : "error", durationMs: n * 1000,
  }));
  const record = (jobId: string) => { for (const entry of entries) storage.appendRunLog(jobId, entry); };

  it("returns every run oldest first when no limit is given", () => {
    record("daily");
    expect(storage.readRunLog("daily")).toEqual(entries);
    expect(storage.readRunLog("daily", 0)).toEqual(entries);
  });

  it("keeps only the newest runs when limited, still oldest first", () => {
    record("daily");
    expect(storage.readRunLog("daily", 3)).toEqual(entries.slice(-3));
    expect(storage.readRunLog("daily", 1)).toEqual([entries.at(-1)]);
    expect(storage.readRunLog("daily", 50)).toEqual(entries);
  });

  it("is empty for a job that has never run", () => {
    expect(storage.readRunLog("never-ran")).toEqual([]);
    expect(storage.readRunLog("never-ran", 5)).toEqual([]);
  });

  it("parses only the runs it returns, so an old damaged line does not hide recent ones", () => {
    const runs = path.join(root, "cron", "runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, "damaged.jsonl"), `{"status":"succ\n${entries.slice(-2).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    expect(storage.readRunLog("damaged", 2)).toEqual(entries.slice(-2));
  });
});
