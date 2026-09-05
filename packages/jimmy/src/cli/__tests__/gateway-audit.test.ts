import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditGatewayReferences } from "../gateway-audit.js";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-gateway-audit-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("auditGatewayReferences", () => {
  it("finds legacy wildcard URLs without changing files by default", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "skills", "demo"), { recursive: true });
    const file = path.join(home, "skills", "demo", "SKILL.md");
    fs.writeFileSync(file, "curl http://0.0.0.0:7777/api/status\n");
    const report = auditGatewayReferences(home);
    expect(report.legacyOccurrences).toBe(1);
    expect(report.legacyFiles).toEqual(["skills/demo/SKILL.md"]);
    expect(report.fixedFiles).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toContain("0.0.0.0");
  });

  it("backs up and atomically fixes IPv4 and IPv6 wildcard URLs", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "cron"), { recursive: true });
    const file = path.join(home, "cron", "jobs.json");
    const original = '{"a":"http://0.0.0.0:7777/api/status","b":"http://[::]:9000/api/health"}';
    fs.writeFileSync(file, original, { mode: 0o600 });
    const report = auditGatewayReferences(home, { fix: true, now: new Date("2026-08-18T12:00:00.000Z") });
    expect(report.fixedFiles).toEqual(["cron/jobs.json"]);
    expect(fs.readFileSync(file, "utf8")).toContain("http://127.0.0.1:7777");
    expect(fs.readFileSync(file, "utf8")).toContain("http://[::1]:9000");
    expect(report.backupDir).toBeDefined();
    expect(fs.readFileSync(path.join(report.backupDir!, "cron", "jobs.json"), "utf8")).toBe(original);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("skips symlinks, runtime trees, and binary files", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, "logs", "gateway.log"), "http://0.0.0.0:7777/api/status");
    fs.writeFileSync(path.join(home, "sessions.db"), "http://0.0.0.0:7777/api/status");
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.md`);
    fs.writeFileSync(outside, "http://0.0.0.0:7777/api/status");
    fs.symlinkSync(outside, path.join(home, "linked.md"));
    try { expect(auditGatewayReferences(home).legacyOccurrences).toBe(0); }
    finally { fs.rmSync(outside, { force: true }); }
  });

  it("flags direct API curl candidates without auth but ignores health and ryoko api", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(home, "scripts", "bad.sh"), "curl http://127.0.0.1:7777/api/sessions\n");
    fs.writeFileSync(path.join(home, "scripts", "health.sh"), "curl http://127.0.0.1:7777/api/health\n");
    fs.writeFileSync(path.join(home, "scripts", "good.sh"), "ryoko api GET /api/sessions\n");
    expect(auditGatewayReferences(home).unauthenticatedCurlCandidates).toEqual(["scripts/bad.sh"]);
  });
});
