import { describe, expect, it } from "vitest";
import { BACKUP_KINDS, isExcludedPath, kindOfPath, unsafePathReason } from "../targets.js";

describe("kindOfPath", () => {
  it("counts every Markdown file directly in the home as persona, whatever it is called", () => {
    // The names the template ships, the one-shot BOOTSTRAP.md, and documents an
    // operator added that no list here could have known.
    for (const name of ["AGENTS.md", "CLAUDE.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "BOOTSTRAP.md", "MANIFEST.md", "運用メモ.md"]) {
      expect(kindOfPath(name), name).toBe("persona");
    }
  });

  it("keeps MEMORY.md with the memory, where --only memory finds it", () => {
    expect(kindOfPath("MEMORY.md")).toBe("memory");
    expect(kindOfPath("memory")).toBe("memory");
    expect(kindOfPath("memory/2026-10-11.md")).toBe("memory");
  });

  it("puts .env with the config", () => {
    expect(kindOfPath("config.yaml")).toBe("config");
    expect(kindOfPath(".env")).toBe("config");
  });

  it("does not mistake a retired copy, a nested file or a directory for a document in the home", () => {
    for (const notOne of ["AGENTS.md.bak-20261001", "notes.txt", ".md", "README.MD", ".env.local", "env", "archive/AGENTS.md", "drafts.md/inner.txt"]) {
      expect(kindOfPath(notOne), notOne).toBeNull();
    }
    expect(kindOfPath("drafts.md", "directory")).toBeNull();
    expect(kindOfPath("MANIFEST.md", "symlink")).toBe("persona");
  });

  it("maps the directories and files it always did", () => {
    expect(kindOfPath("cron/jobs.json")).toBe("cron");
    expect(kindOfPath("cron/runs")).toBe("cron-history");
    expect(kindOfPath("cron/runs/daily.jsonl")).toBe("cron-history");
    expect(kindOfPath("org/lead.yaml")).toBe("org");
    expect(kindOfPath("skills", "directory")).toBe("skills");
    expect(kindOfPath("skills/demo/SKILL.md")).toBe("skills");
    expect(kindOfPath("skills.json")).toBe("skills");
    expect(kindOfPath("docs/overview.md")).toBe("docs");
    expect(kindOfPath("knowledge/notes.md")).toBe("knowledge");
    expect(kindOfPath("workflows/legacy-v1-import-report.json")).toBe("workflows");
  });

  it("claims nothing that is not an archive target", () => {
    // Auth state is not something anyone edits; after a total loss it is re-established, not restored.
    for (const outside of [
      "cron", "cron/commands/abc/running.lock", "gateway-auth.json", "auth-devices.json", "credentials/typesafe.json",
      "connectors/slack.json", ".whatsapp-auth/creds.json", "sessions/registry.db", "logs/gateway.log", "hook-relay.mjs",
      ".claude/settings.local.json", "skillsX", "memory.md.d/x",
    ]) {
      expect(kindOfPath(outside), outside).toBeNull();
    }
  });
});

describe("BACKUP_KINDS", () => {
  it("lists the kinds `restore --only` accepts, in the order they are reported", () => {
    expect(BACKUP_KINDS).toEqual(["config", "cron", "cron-history", "persona", "memory", "org", "skills", "docs", "knowledge", "workflows"]);
  });
});

describe("isExcludedPath", () => {
  it("leaves out caches and checkouts at any depth, and the workflow store's own files", () => {
    for (const directory of ["node_modules", "skills/demo/node_modules", "skills/demo/.git", "knowledge/x/.venv", "skills/a/b/__pycache__"]) {
      expect(isExcludedPath(directory, true), directory).toBe(true);
    }
    for (const file of ["workflows/workflows.db", "workflows/workflows.db-wal", "workflows/workflows.db-shm"]) {
      expect(isExcludedPath(file, false), file).toBe(true);
    }
    expect(isExcludedPath("skills/demo", true)).toBe(false);
    expect(isExcludedPath("skills/demo/data.db", false)).toBe(false);
    expect(isExcludedPath("workflows/legacy-v1-import-report.json", false)).toBe(false);
  });
});

describe("unsafePathReason", () => {
  it("accepts the plain relative form and nothing else", () => {
    for (const safe of ["config.yaml", ".env", "skills/demo/SKILL.md", "knowledge/議事録/notes.md", "a b/c..d/.hidden"]) {
      expect(unsafePathReason(safe), safe).toBeNull();
    }
    for (const unsafe of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/.", "a/b/", "a\0b"]) {
      expect(unsafePathReason(unsafe), JSON.stringify(unsafe)).not.toBeNull();
    }
  });
});
