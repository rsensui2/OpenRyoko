import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditGatewayReferences } from "../gateway-audit.js";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-gateway-audit-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  vi.restoreAllMocks();
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

  it("leaves the skill copies the bundled skill sync moved aside as they were", () => {
    const home = makeHome();
    const backup = path.join(home, ".migration-backups", "2026.10.11-2026-10-12T03-04-05-678Z", "skills", "demo");
    fs.mkdirSync(backup, { recursive: true });
    const original = "curl http://0.0.0.0:7777/api/sessions\n";
    fs.writeFileSync(path.join(backup, "SKILL.md"), original);

    const report = auditGatewayReferences(home, { fix: true });

    // An archive is not a live reference: rewriting it would alter the only copy of what was replaced.
    expect(report.legacyOccurrences).toBe(0);
    expect(report.unauthenticatedCurlCandidates).toEqual([]);
    expect(report.backupDir).toBeUndefined();
    expect(fs.readFileSync(path.join(backup, "SKILL.md"), "utf8")).toBe(original);
  });

  it("does not overwrite a file outside the home through a link left where its temporary file used to go", () => {
    const home = makeHome();
    const script = path.join(home, "skills", "x", "a.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "curl http://0.0.0.0:7777/api/status # attacker-chosen text\n", { mode: 0o644 });
    const outside = makeHome();
    const secret = path.join(outside, "id_ed25519");
    fs.writeFileSync(secret, "the user's key\n", { mode: 0o600 });
    // The temporary file was named after the PID, which can simply be guessed at.
    fs.symlinkSync(secret, `${script}.tmp-gateway-url-${process.pid}`);

    const report = auditGatewayReferences(home, { fix: true });

    expect(fs.readFileSync(secret, "utf8")).toBe("the user's key\n");
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    // The fix itself still happens, on the file it was meant for.
    expect(report.fixedFiles).toEqual(["skills/x/a.sh"]);
    expect(fs.lstatSync(script).isFile()).toBe(true);
    expect(fs.readFileSync(script, "utf8")).toContain("http://127.0.0.1:7777");
    expect(fs.statSync(script).mode & 0o777).toBe(0o644);
  });

  it("writes through a temporary file nobody can name in advance, and leaves none behind", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "cron"), { recursive: true });
    for (const name of ["a.json", "b.json"]) fs.writeFileSync(path.join(home, "cron", name), '{"u":"http://0.0.0.0:7777/api/status"}');
    const rename = vi.spyOn(fs, "renameSync");

    auditGatewayReferences(home, { fix: true });

    const temporaries = rename.mock.calls.map(([from]) => path.basename(String(from)));
    expect(temporaries).toHaveLength(2);
    expect(new Set(temporaries).size).toBe(2);
    for (const name of temporaries) expect(name).not.toContain(String(process.pid));
    expect(fs.readdirSync(path.join(home, "cron")).sort()).toEqual(["a.json", "b.json"]);
  });

  it("refuses a file already sitting at the very name its temporary file is about to take", () => {
    const home = makeHome();
    const script = path.join(home, "skills", "x", "a.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "curl http://0.0.0.0:7777/api/status\n");
    const outside = makeHome();
    const secret = path.join(outside, "id_ed25519");
    fs.writeFileSync(secret, "the user's key\n");
    // Not something anyone can arrange once the name is random; if the path is taken
    // anyway, it must be refused rather than followed.
    vi.spyOn(crypto, "randomBytes").mockImplementation((() => Buffer.alloc(8, 0xcd)) as unknown as typeof crypto.randomBytes);
    fs.symlinkSync(secret, `${script}.${"cd".repeat(8)}.tmp`);

    expect(() => auditGatewayReferences(home, { fix: true })).toThrow(/EEXIST/);

    expect(fs.readFileSync(secret, "utf8")).toBe("the user's key\n");
    expect(fs.readFileSync(script, "utf8")).toContain("0.0.0.0");
  });

  it("removes its temporary file when the fixed copy cannot be moved into place", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "cron"), { recursive: true });
    const file = path.join(home, "cron", "jobs.json");
    fs.writeFileSync(file, '{"u":"http://0.0.0.0:7777/api/status"}');
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename refused"); });

    expect(() => auditGatewayReferences(home, { fix: true })).toThrow("rename refused");

    expect(fs.readdirSync(path.join(home, "cron"))).toEqual(["jobs.json"]);
    expect(fs.readFileSync(file, "utf8")).toContain("0.0.0.0");
  });

  it("does not follow a file that turned into a link after it was listed", () => {
    const home = makeHome();
    const script = path.join(home, "skills", "x", "a.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "curl http://0.0.0.0:7777/api/status\n");
    const outside = makeHome();
    const elsewhere = path.join(outside, "notes.md");
    fs.writeFileSync(elsewhere, "see http://0.0.0.0:7777/api/status\n", { mode: 0o600 });
    const read = fs.readFileSync;
    // Listed as a regular file; swapped for a link before the fix reaches it.
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const content = (read as (...args: unknown[]) => unknown)(file, ...rest);
      if (file === script && fs.lstatSync(script).isFile()) {
        fs.rmSync(script);
        fs.symlinkSync(elsewhere, script);
      }
      return content;
    }) as typeof fs.readFileSync);

    const report = auditGatewayReferences(home, { fix: true });

    expect(report.fixedFiles).toEqual([]);
    expect(report.backupDir).toBeUndefined();
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("see http://0.0.0.0:7777/api/status\n");
    expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o600);
    expect(fs.readlinkSync(script)).toBe(elsewhere);
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
