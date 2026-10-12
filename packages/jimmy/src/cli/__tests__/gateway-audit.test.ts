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

describe("auditGatewayReferences: the backup it takes before fixing a file", () => {
  const NOW = new Date("2026-08-18T12:00:00.000Z");
  const RUN = "gateway-url-2026-08-18T12-00-00-000Z";
  const LEGACY = "curl http://0.0.0.0:7777/api/status\n";

  /** A home holding these files, each with a legacy URL in it. */
  function homeWith(...relatives: string[]): { home: string; files: string[] } {
    const home = fs.realpathSync(makeHome());
    const files = relatives.map((relative) => path.join(home, relative));
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, LEGACY);
    }
    return { home, files };
  }

  /** A file of the user's, outside the home, that nothing here may touch. */
  function secretOutside(): string {
    const secret = path.join(fs.realpathSync(makeHome()), "id_ed25519");
    fs.writeFileSync(secret, "the user's key\n", { mode: 0o600 });
    return secret;
  }

  /** Run `plant` once, right after the run's backup directory has been created. */
  function onceTheRunDirectoryExists(plant: (directory: string) => void): void {
    const mkdir = fs.mkdirSync;
    let done = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      const made = (mkdir as (...args: unknown[]) => string | undefined)(dir, ...rest);
      if (!done && path.basename(String(dir)) === RUN) {
        done = true;
        plant(String(dir));
      }
      return made;
    }) as typeof fs.mkdirSync);
  }

  it.each(["a link to a directory elsewhere", "a file"])("refuses to back up when backups/ is %s, and so fixes nothing", (kind) => {
    const { home, files } = homeWith("AGENTS.md");
    const outside = fs.realpathSync(makeHome());
    if (kind === "a file") fs.writeFileSync(path.join(home, "backups"), "not a directory");
    else fs.symlinkSync(outside, path.join(home, "backups"));

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
    expect(report.fixedFiles).toEqual([]);
    expect(report.backupDir).toBeUndefined();
    expect(report.fixRefused).toMatch(/backups.*not a plain directory/);
    // What it found is still reported.
    expect(report.legacyFiles).toEqual(["AGENTS.md"]);
    expect(report.legacyOccurrences).toBe(1);
  });

  it("says nothing about refusing when it was not asked to fix, or had nothing to fix", () => {
    const { home } = homeWith("AGENTS.md");
    fs.symlinkSync(fs.realpathSync(makeHome()), path.join(home, "backups"));
    expect(auditGatewayReferences(home, { now: NOW }).fixRefused).toBeUndefined();

    const clean = fs.realpathSync(makeHome());
    fs.writeFileSync(path.join(clean, "AGENTS.md"), "curl http://127.0.0.1:7777/api/health\n");
    fs.symlinkSync(fs.realpathSync(makeHome()), path.join(clean, "backups"));
    expect(auditGatewayReferences(clean, { fix: true, now: NOW }).fixRefused).toBeUndefined();
  });

  it("makes a run directory of its own when a link was left at the name it would have used", () => {
    const { home, files } = homeWith("AGENTS.md");
    const outside = fs.realpathSync(makeHome());
    fs.mkdirSync(path.join(home, "backups"));
    fs.symlinkSync(outside, path.join(home, "backups", RUN));

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(report.fixedFiles).toEqual(["AGENTS.md"]);
    expect(report.backupDir).toBe(path.join(home, "backups", `${RUN}-2`));
    expect(fs.readFileSync(path.join(report.backupDir!, "AGENTS.md"), "utf8")).toBe(LEGACY);
    expect(fs.readFileSync(files[0], "utf8")).toContain("http://127.0.0.1:7777");
  });

  it("does not adopt a directory that was already there under that name, with whatever was put in it", () => {
    const { home } = homeWith("AGENTS.md");
    const secret = secretOutside();
    fs.mkdirSync(path.join(home, "backups", RUN), { recursive: true });
    fs.symlinkSync(secret, path.join(home, "backups", RUN, "AGENTS.md"));

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(fs.readFileSync(secret, "utf8")).toBe("the user's key\n");
    expect(report.backupDir).toBe(path.join(home, "backups", `${RUN}-2`));
    expect(fs.readFileSync(path.join(report.backupDir!, "AGENTS.md"), "utf8")).toBe(LEGACY);
  });

  it("does not copy over a link that appears at the backup's path, and leaves the file unfixed", () => {
    const { home, files } = homeWith("AGENTS.md");
    const secret = secretOutside();
    onceTheRunDirectoryExists((directory) => fs.symlinkSync(secret, path.join(directory, "AGENTS.md")));

    expect(() => auditGatewayReferences(home, { fix: true, now: NOW })).toThrow(/EEXIST/);

    expect(fs.readFileSync(secret, "utf8")).toBe("the user's key\n");
    // No backup, no fix.
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
  });

  it("does not create a backup inside a directory linked into the run directory", () => {
    const { home, files } = homeWith("scripts/a.sh");
    const outside = fs.realpathSync(makeHome());
    onceTheRunDirectoryExists((directory) => fs.symlinkSync(outside, path.join(directory, "scripts")));

    expect(() => auditGatewayReferences(home, { fix: true, now: NOW })).toThrow(/scripts/);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
  });

  it("does not copy into a directory of the run that became a link after the run made it", () => {
    const { home, files } = homeWith("scripts/a.sh");
    const outside = fs.realpathSync(makeHome());
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      const made = (mkdir as (...args: unknown[]) => string | undefined)(dir, ...rest);
      if (String(dir).endsWith(path.join(RUN, "scripts"))) {
        fs.rmdirSync(dir);
        fs.symlinkSync(outside, String(dir));
      }
      return made;
    }) as typeof fs.mkdirSync);

    expect(() => auditGatewayReferences(home, { fix: true, now: NOW })).toThrow(/scripts/);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
  });

  it("fixes nothing, and says why, when the backup directory cannot be made at all", () => {
    const { home, files } = homeWith("AGENTS.md");
    fs.mkdirSync(path.join(home, "backups"));
    for (let attempt = 1; attempt <= 20; attempt++) fs.mkdirSync(path.join(home, "backups", attempt === 1 ? RUN : `${RUN}-${attempt}`));

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(report.fixRefused).toMatch(/already taken/);
    expect(report.fixedFiles).toEqual([]);
    expect(report.backupDir).toBeUndefined();
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
    expect(fs.readdirSync(path.join(home, "backups"))).toHaveLength(20);
  });

  it("does not go on through backups/ when it turns into a link as the run directory is made", () => {
    const { home, files } = homeWith("AGENTS.md");
    const outside = fs.realpathSync(makeHome());
    fs.mkdirSync(path.join(home, "backups"));
    const mkdir = fs.mkdirSync;
    let swapped = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && path.basename(String(dir)) === RUN) {
        swapped = true;
        fs.rmdirSync(path.join(home, "backups"));
        fs.symlinkSync(outside, path.join(home, "backups"));
      }
      return (mkdir as (...args: unknown[]) => string | undefined)(dir, ...rest);
    }) as typeof fs.mkdirSync);

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(swapped).toBe(true);
    // Nothing of the home's was copied out, and the empty directory made on the way is gone again.
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(report.fixedFiles).toEqual([]);
    expect(report.fixRefused).toMatch(/backups/);
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
  });

  it("backs up files in the same directory and several levels deep, in directories only the owner can enter", () => {
    const { home } = homeWith("skills/x/a.sh", "skills/x/b.sh", "cron/jobs.json", "AGENTS.md");

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(report.fixedFiles.sort()).toEqual(["AGENTS.md", "cron/jobs.json", "skills/x/a.sh", "skills/x/b.sh"]);
    for (const relative of report.fixedFiles) expect(fs.readFileSync(path.join(report.backupDir!, relative), "utf8")).toBe(LEGACY);
    for (const directory of [path.join(home, "backups"), report.backupDir!, path.join(report.backupDir!, "skills"), path.join(report.backupDir!, "skills", "x")]) {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("works in a home that is itself reached through a link, and names the backup the way the home was named", () => {
    const { home, files } = homeWith("AGENTS.md");
    const alias = path.join(fs.realpathSync(makeHome()), "home");
    fs.symlinkSync(home, alias);

    const report = auditGatewayReferences(alias, { fix: true, now: NOW });

    // The user's own arrangement: only a link inside the home is refused.
    expect(report.fixedFiles).toEqual(["AGENTS.md"]);
    expect(report.backupDir).toBe(path.join(alias, "backups", RUN));
    expect(fs.readFileSync(path.join(home, "backups", RUN, "AGENTS.md"), "utf8")).toBe(LEGACY);
    expect(fs.readFileSync(files[0], "utf8")).toContain("http://127.0.0.1:7777");
  });

  it("sets a backup's mode on the file it opened, not on whatever is at the path by then", () => {
    const { home, files } = homeWith("AGENTS.md");
    const secret = secretOutside();
    const copy = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, ...rest) => {
      (copy as (...args: unknown[]) => void)(from, to, ...rest);
      fs.rmSync(to);
      fs.symlinkSync(secret, to);
    });

    expect(() => auditGatewayReferences(home, { fix: true, now: NOW })).toThrow();

    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(files[0], "utf8")).toBe(LEGACY);
  });

  it("sets the fixed file's mode on the temporary file it opened, not on whatever is at the path by then", () => {
    const { home, files } = homeWith("AGENTS.md");
    const secret = secretOutside();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...rest) => {
      (write as (...args: unknown[]) => void)(target, ...rest);
      // The fixed text is written; the temporary file's path is then swapped for a link.
      const temporary = fs.readdirSync(home).find((name) => name.endsWith(".tmp"));
      if (temporary && fs.lstatSync(path.join(home, temporary)).isFile()) {
        fs.rmSync(path.join(home, temporary));
        fs.symlinkSync(secret, path.join(home, temporary));
      }
    });

    auditGatewayReferences(home, { fix: true, now: NOW });

    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(secret, "utf8")).toBe("the user's key\n");
    expect(files).toHaveLength(1);
  });

  it("keeps a mode the umask would have narrowed, and never sets one by path", () => {
    const { home, files } = homeWith("cron/jobs.json");
    fs.chmodSync(files[0], 0o666);
    const chmod = vi.spyOn(fs, "chmodSync");

    const report = auditGatewayReferences(home, { fix: true, now: NOW });

    expect(fs.statSync(files[0]).mode & 0o777).toBe(0o666);
    expect(fs.statSync(path.join(report.backupDir!, "cron", "jobs.json")).mode & 0o777).toBe(0o666);
    expect(chmod).not.toHaveBeenCalled();
  });
});
