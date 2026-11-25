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

function seedSession(
  id: string,
  lastActivity: string,
  employee: string | null = null,
  source = "web",
  parentSessionId: string | null = null,
): void {
  registry.initDb().prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, employee, parent_session_id, status, created_at, last_activity)
    VALUES (?, 'claude', ?, ?, ?, ?, 'idle', ?, ?)
  `).run(id, source, `${source}:${id}`, employee, parentSessionId, lastActivity, lastActivity);
}

function seedMessage(sessionId: string, role: string, content: string, timestamp: number): void {
  registry.initDb().prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  ).run(`${sessionId}-${timestamp}`, sessionId, role, content, timestamp);
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

describe("message search in unsegmented scripts", () => {
  it("finds a Japanese word in the middle of a sentence, which the word index cannot", () => {
    seedSession("ja-a", "2026-08-18T01:00:00.000Z");
    seedSession("ja-b", "2026-08-18T02:00:00.000Z");
    seedMessage("ja-a", "user", "来週のセミナーの請求書を先方に送っておいて", 5000);
    seedMessage("ja-a", "assistant", "請求書は下書きに保存しました。記憶にも残します", 5001);
    seedMessage("ja-b", "user", "記憶の整理は今夜でよい", 5002);
    seedMessage("ja-b", "notification", "請求書の通知（内部）", 5003);

    expect(registry.searchMessages("請求書").map((r) => r.messageId)).toEqual(["ja-a-5001", "ja-a-5000"]);
    // A two-character word: too short for a trigram index, still a substring.
    expect(registry.searchMessages("記憶").map((r) => r.sessionId).sort()).toEqual(["ja-a", "ja-b"]);
  });

  it("requires every term, matches Latin terms without regard to case, and marks the hit", () => {
    seedSession("ja-c", "2026-08-18T03:00:00.000Z");
    seedMessage("ja-c", "user", "Linear のチケットに議事録を貼っておいて", 6000);
    seedMessage("ja-c", "assistant", "議事録はまだありません", 6001);

    const hits = registry.searchMessages("linear 議事録");
    expect(hits.map((r) => r.messageId)).toEqual(["ja-c-6000"]);
    expect(hits[0].snippet).toContain("«");
    expect(hits[0].snippet.length).toBeLessThan(200);
  });

  it("treats LIKE wildcards in the query as literal characters", () => {
    seedSession("ja-d", "2026-08-18T04:00:00.000Z");
    seedMessage("ja-d", "user", "割引は50%で確定", 7000);
    seedMessage("ja-d", "user", "割引は50円で確定", 7001);
    seedMessage("ja-d", "user", "型は a_b で確定", 7002);
    seedMessage("ja-d", "user", "型は axb で確定", 7003);

    expect(registry.searchMessages("50%で").map((r) => r.messageId)).toEqual(["ja-d-7000"]);
    expect(registry.searchMessages("a_b で").map((r) => r.messageId)).toEqual(["ja-d-7002"]);
  });

  it("falls back to a substring match when a Latin query is only part of a word", () => {
    seedSession("partial", "2026-08-18T05:00:00.000Z");
    seedMessage("partial", "assistant", "the reconciliation finished", 8000);

    expect(registry.searchMessages("reconcil").map((r) => r.messageId)).toEqual(["partial-8000"]);
  });

  it("adds messages where a Latin word runs straight into unspaced text, after the whole-word matches", () => {
    seedSession("glued", "2026-08-18T06:00:00.000Z");
    seedMessage("glued", "user", "Zephyr is down again", 9000);
    // No space on either side: the word index holds these as one long token each.
    seedMessage("glued", "assistant", "Zephyrの設定を変えました", 9001);
    seedMessage("glued", "user", "新しいZephyrを試す", 9002);
    seedMessage("glued", "user", "nothing to see here", 9003);

    expect(registry.searchMessages("Zephyr").map((r) => r.messageId)).toEqual(["glued-9000", "glued-9002", "glued-9001"]);
    expect(registry.searchMessages("zephyr", 20, { role: "assistant" }).map((r) => r.messageId)).toEqual(["glued-9001"]);
    // A page the whole-word matches already fill is left as it is.
    expect(registry.searchMessages("Zephyr", 1).map((r) => r.messageId)).toEqual(["glued-9000"]);
    expect(registry.searchMessages("Zephyr", 2).map((r) => r.messageId)).toEqual(["glued-9000", "glued-9002"]);
  });

  it("applies the same filters to what it adds", () => {
    seedSession("glued-job", "2026-08-18T06:10:00.000Z", null, "cron");
    seedSession("glued-child", "2026-08-18T06:11:00.000Z", null, "web", "glued");
    seedSession("glued-slack", "2026-08-18T06:12:00.000Z", null, "slack");
    seedMessage("glued-job", "user", "毎朝Quokkaの数字を確認する", 9100);
    seedMessage("glued-child", "user", "Quokkaの資料を作って", 9101);
    seedMessage("glued-slack", "user", "Quokkaは先週から止まっている", 9102);
    seedMessage("glued-slack", "assistant", "Quokka was restarted", 9103);

    expect(registry.searchMessages("Quokka").map((r) => r.messageId)).toEqual(["glued-slack-9103", "glued-slack-9102", "glued-child-9101", "glued-job-9100"]);
    expect(registry.searchMessages("Quokka", 20, { scope: "conversations" }).map((r) => r.messageId)).toEqual(["glued-slack-9103", "glued-slack-9102"]);
    expect(registry.searchMessages("Quokka", 20, { sources: ["cron"] }).map((r) => r.messageId)).toEqual(["glued-job-9100"]);
    expect(registry.searchMessages("Quokka", 20, { sessionId: "glued-child" }).map((r) => r.messageId)).toEqual(["glued-child-9101"]);
  });

  it("adds nothing from a cut-down query, so every result holds every term", () => {
    seedSession("many", "2026-08-18T06:20:00.000Z");
    const nine = "t1x t2x t3x t4x t5x t6x t7x t8x t9x";
    seedMessage("many", "user", `${nine} whole`, 9200);
    // Holds the first eight terms inside longer words, and not the ninth.
    seedMessage("many", "user", "t1xa t2xa t3xa t4xa t5xa t6xa t7xa t8xa", 9201);

    expect(registry.searchMessages(nine).map((r) => r.messageId)).toEqual(["many-9200"]);
    // Up to eight terms, the appended half is exact as well.
    expect(registry.searchMessages("t1x t2x t3x t4x t5x t6x t7x t8x").map((r) => r.messageId)).toEqual(["many-9200", "many-9201"]);
    const long = "w".repeat(70);
    seedMessage("many", "user", `${long} whole`, 9202);
    seedMessage("many", "user", `${"w".repeat(64)}zz glued`, 9203);
    expect(registry.searchMessages(long).map((r) => r.messageId)).toEqual(["many-9202"]);
  });
});

describe("message search scope", () => {
  it("can leave out scheduled-job and delegated prompts, and reports where a hit came from", () => {
    seedSession("scope-chat", "2026-08-19T01:00:00.000Z", null, "slack");
    seedSession("scope-cron", "2026-08-19T02:00:00.000Z", null, "cron");
    seedSession("scope-flow", "2026-08-19T03:00:00.000Z", null, "workflow");
    seedSession("scope-child", "2026-08-19T04:00:00.000Z", "alice", "web", "scope-chat");
    seedMessage("scope-chat", "user", "quarterly zebra report", 9000);
    seedMessage("scope-cron", "user", "quarterly zebra report", 9001);
    seedMessage("scope-flow", "user", "quarterly zebra report", 9002);
    seedMessage("scope-child", "user", "quarterly zebra report", 9003);

    expect(registry.searchMessages("zebra").map((r) => r.sessionId).sort()).toEqual([
      "scope-chat", "scope-child", "scope-cron", "scope-flow",
    ]);
    const conversations = registry.searchMessages("zebra", 20, { scope: "conversations" });
    expect(conversations.map((r) => r.sessionId)).toEqual(["scope-chat"]);
    expect(conversations[0].source).toBe("slack");
    expect(registry.searchMessages("zebra", 20, { sources: ["cron", "workflow"] }).map((r) => r.sessionId).sort()).toEqual([
      "scope-cron", "scope-flow",
    ]);
  });

  it("applies the scope to Japanese queries too", () => {
    seedSession("scope-ja-chat", "2026-08-19T05:00:00.000Z", null, "slack");
    seedSession("scope-ja-cron", "2026-08-19T06:00:00.000Z", null, "cron");
    seedMessage("scope-ja-chat", "user", "週次の棚卸しを始めて", 9100);
    seedMessage("scope-ja-cron", "user", "【週次の棚卸し】を実行する", 9101);

    expect(registry.searchMessages("棚卸し", 20, { scope: "conversations" }).map((r) => r.sessionId)).toEqual(["scope-ja-chat"]);
  });
});
