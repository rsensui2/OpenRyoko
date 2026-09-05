import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-history-query-"));
process.env.RYOKO_HOME = instanceDir;

type Registry = typeof import("../registry.js");
let registry: Registry;

beforeAll(async () => {
  registry = await import("../registry.js");
  registry.initDb();
});

function seedSession(id: string, lastActivity: string, employee: string | null = null): void {
  registry.initDb().prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, employee, status, created_at, last_activity)
    VALUES (?, 'claude', 'web', ?, ?, 'idle', ?, ?)
  `).run(id, `web:${id}`, employee, lastActivity, lastActivity);
}

describe("session cursor pagination", () => {
  it("returns stable, non-overlapping pages when activity timestamps tie", () => {
    for (const [id, ts] of [
      ["page-d", "2026-08-17T04:00:00.000Z"],
      ["page-c", "2026-08-17T03:00:00.000Z"],
      ["page-b", "2026-08-17T03:00:00.000Z"],
      ["page-a", "2026-08-17T01:00:00.000Z"],
    ] as const) seedSession(id, ts);

    const first = registry.listSessionPage(2);
    expect(first.sessions.map((session) => session.id)).toEqual(["page-d", "page-c"]);
    expect(first.nextCursor).toEqual({ lastActivity: "2026-08-17T03:00:00.000Z", id: "page-c" });
    const second = registry.listSessionPage(2, first.nextCursor!);
    expect(second.sessions.map((session) => session.id)).toEqual(["page-b", "page-a"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("message paging", () => {
  it("prepends older pages without duplicates when timestamps tie", () => {
    seedSession("messages", "2026-08-17T05:00:00.000Z");
    const insert = registry.initDb().prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, 'messages', 'user', ?, ?)",
    );
    insert.run("m1", "one", 1000);
    insert.run("m2", "two", 1000);
    insert.run("m3", "three", 2000);
    insert.run("m4", "four", 3000);

    const latest = registry.getMessagePage("messages", { limit: 2 });
    expect(latest.messages.map((message) => message.id)).toEqual(["m3", "m4"]);
    expect(latest.hasOlder).toBe(true);
    const older = registry.getMessagePage("messages", { before: latest.messages[0].id, limit: 2 });
    expect(older.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(older.hasOlder).toBe(false);
  });

  it("returns a stable bounded window around a message anchor", () => {
    const window = registry.getMessageWindow("messages", "m2", 1);
    expect(window.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(window).toMatchObject({ hasOlder: false, hasNewer: true, anchorFound: true });
    expect(registry.getMessageWindow("messages", "missing", 1)).toMatchObject({
      messages: [],
      anchorFound: false,
    });
  });
});

describe("FTS5 message search", () => {
  it("indexes user/assistant messages, filters, and ignores notification rows", () => {
    seedSession("search-a", "2026-08-17T06:00:00.000Z", "alice");
    seedSession("search-b", "2026-08-17T06:01:00.000Z", "bob");
    registry.insertMessage("search-a", "user", "alpha launch checklist");
    registry.insertMessage("search-a", "notification", "alpha internal notification");
    registry.insertMessage("search-b", "assistant", "alpha launch result");

    expect(registry.searchMessages("alpha launch").map((result) => result.sessionId).sort()).toEqual(["search-a", "search-b"]);
    expect(registry.searchMessages("alpha", 20, { employee: "alice" })).toHaveLength(1);
    expect(registry.searchMessages("internal notification")).toEqual([]);
  });

  it("treats FTS operators and control bytes as literal input without throwing", () => {
    expect(() => registry.searchMessages('alpha\u0000 " OR (*')).not.toThrow();
  });

  it("removes deleted messages from the index", () => {
    registry.initDb().prepare("DELETE FROM messages WHERE session_id = 'search-b'").run();
    expect(registry.searchMessages("result", 20, { sessionId: "search-b" })).toEqual([]);
  });

  it("resumes a chunked historical backfill without duplicating rows", async () => {
    seedSession("backfill", "2026-08-17T07:00:00.000Z");
    registry.insertMessage("backfill", "user", "historical apricot one");
    registry.insertMessage("backfill", "assistant", "historical apricot two");
    registry.insertMessage("backfill", "notification", "historical apricot hidden");

    const database = registry.initDb();
    const max = (database.prepare("SELECT MAX(rowid) AS max FROM messages").get() as { max: number }).max;
    database.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)").run("backfill");
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_backfill_max', ?)").run(String(max));
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_backfill_rowid', '0')").run();
    database.prepare("DELETE FROM meta WHERE key = 'fts_backfill_done'").run();

    expect(registry.isFtsBackfillPending(database)).toBe(true);
    await registry.scheduleFtsBackfill(database, 1);
    expect(registry.isFtsBackfillPending(database)).toBe(false);
    expect(registry.searchMessages("historical apricot", 20, { sessionId: "backfill" })).toHaveLength(2);
  });
});
