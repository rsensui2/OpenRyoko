import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_BACKUP_RETENTION } from "../../sessions/backup.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { SAME_DAY_BACKUPS_KEPT } from "../catalog.js";
import { GATEWAY_STOPPED_FLAG } from "../database-restore.js";
import { DEFAULT_ARCHIVE_RETENTION, DEFAULT_MAX_ARCHIVE_MB, DEFAULT_MAX_ENTRIES } from "../settings.js";
import { BACKUP_KINDS } from "../targets.js";

/* A backup nobody knows about is not used. The doc that ships with every
 * instance is what tells an operator - and the agent that has just broken
 * config.yaml - that yesterday's copy exists and how to get it back. These
 * hold it to the code, so a renamed flag or a new kind cannot leave it behind. */

const read = (relative: string): string => fs.readFileSync(path.join(TEMPLATE_DIR, ...relative.split("/")), "utf8");

describe("docs/backup.md", () => {
  const doc = (): string => read("docs/backup.md");

  it("names every kind `restore --only` accepts", () => {
    for (const kind of BACKUP_KINDS) expect(doc(), kind).toContain(`\`${kind}\``);
  });

  it("gives the commands to take, list, check and restore a backup, with the flags that matter", () => {
    for (const needed of [
      "ryoko backup run", "ryoko backup list", "ryoko backup verify", "ryoko backup restore",
      "--only", "--dry-run", "--allow-external-symlinks", GATEWAY_STOPPED_FLAG,
    ]) {
      expect(doc(), needed).toContain(needed);
    }
  });

  it("says a database is restored with the gateway stopped, inside the container", () => {
    expect(doc()).toMatch(/コンテナ/);
    expect(doc()).toContain("ryoko stop");
    expect(doc()).toMatch(new RegExp(`ryoko backup restore sessions-\\S+ ${GATEWAY_STOPPED_FLAG}`));
  });

  it("says what is not in a backup, so nobody counts on it being there", () => {
    for (const absent of [
      "credentials/", "connectors/", ".whatsapp-auth", "gateway-auth.json", "auth-devices.json",
      "logs/", "tmp/", "files/", "node_modules", ".git", "cron/commands/",
    ]) {
      expect(doc(), absent).toContain(absent);
    }
    // A symlink is recorded as a link: what it points at is the thing most likely to be assumed safe.
    expect(doc()).toMatch(/symlink/);
  });

  it("shows the settings with the defaults the code actually uses", () => {
    expect(doc()).toContain(`retention: ${DEFAULT_ARCHIVE_RETENTION}`);
    expect(doc()).toContain(`maxArchiveMb: ${DEFAULT_MAX_ARCHIVE_MB}`);
    expect(doc()).toContain(`maxEntries: ${DEFAULT_MAX_ENTRIES}`);
    expect(doc()).toContain(`${DATABASE_BACKUP_RETENTION} 世代`);
  });

  it("does not promise that going back to the pre-restore snapshot undoes everything", () => {
    // A restore only ever writes; it never deletes. Restoring the snapshot it
    // took first puts back what was overwritten, and leaves in place the files
    // the restore created, which were not there to be snapshotted.
    expect(doc()).toMatch(/新しく作られたファイル.*消えません/s);
    expect(doc()).not.toMatch(/で元に戻せます/);
  });

  it("says the commands belong where the gateway runs, and that a database is never opened to check", () => {
    expect(doc()).toMatch(/`ryoko backup` は、gateway が動いている場所で実行/);
    expect(doc()).toMatch(/DB を開いて確かめることはしません/);
  });

  it("says retention is counted in days, and how many of one day are kept", () => {
    // It recommends taking a backup before a big change, so it owes the reader
    // what doing that often does to the history: nothing.
    expect(doc()).toMatch(/retention: \d+\s+# アーカイブを残す日数/);
    expect(doc()).toContain(`直近 ${SAME_DAY_BACKUPS_KEPT} 個`);
  });
});

describe("the way to docs/backup.md", () => {
  it("leads there from the skill an agent follows when something is broken", () => {
    const skill = read("skills/self-heal/SKILL.md");

    expect(skill).toContain("docs/backup.md");
    expect(skill).toContain("ryoko backup list");
  });

  it("leads there from the doc an agent reads before editing its own files", () => {
    expect(read("docs/self-modification.md")).toContain("docs/backup.md");
  });

  it("points only at a doc that ships", () => {
    expect(fs.existsSync(path.join(TEMPLATE_DIR, "docs", "backup.md"))).toBe(true);
  });
});
