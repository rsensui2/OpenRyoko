import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  createSession,
  enqueueQueueItem,
  getQueueItem,
  getQueueItems,
  initDb,
  markQueueItemRunning,
  migrateSessionsSchema,
} from "../registry.js";
import {
  COMPLETION_BATCH_MAX_CHARS,
  COMPLETION_BATCH_MAX_ITEMS,
  acceptChildCompletion,
  completionBatchPrompt,
  completionChildOf,
  isCompletionBatchItem,
  queueChildCompletion,
  queuedPrompt,
} from "../completion-batching.js";
import { SessionQueue } from "../queue.js";
import type { Session } from "../../shared/types.js";

let sequence = 0;

function parent(): Session {
  const key = `slack:C_BATCH:${++sequence}`;
  return createSession({ engine: "claude", source: "slack", sourceRef: key, connector: "slack", sessionKey: key, replyContext: { channel: "C_BATCH", thread: String(sequence) } });
}

function childOf(parentSession: Session, employee: string): Session {
  const key = `web:child:${++sequence}`;
  return createSession({ engine: "claude", source: "web", sourceRef: key, connector: "web", sessionKey: key, employee, parentSessionId: parentSession.id });
}

/** Occupy a session's queue slot with a turn that has already started, like a parent busy in its engine. */
async function busyTurn(queue: SessionQueue, sessionKey: string): Promise<{ turn: Promise<void>; finish: () => void }> {
  let finish!: () => void;
  const turn = queue.enqueue(sessionKey, () => new Promise<void>((resolve) => { finish = resolve; }));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  return { turn, finish: () => finish() };
}

const done = (employee: string) => `📩 Employee "${employee}" replied in session s-${employee}.\nRead the latest messages: GET /api/sessions/s-${employee}?last=N\n\nPreview: ${employee} finished`;

beforeEach(() => {
  const db = initDb();
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
});

describe("completionBatchPrompt", () => {
  it("is the message itself for a single completion", () => {
    expect(completionBatchPrompt([done("a")])).toBe(done("a"));
  });

  it("numbers every update and tells the session to answer once", () => {
    const prompt = completionBatchPrompt([done("a"), done("b"), done("c")]);

    expect(prompt).toContain("3 child-session updates");
    expect(prompt).toContain("answer once");
    expect(prompt).toContain(`--- Update 1 of 3 ---\n${done("a")}`);
    expect(prompt).toContain(`--- Update 2 of 3 ---\n${done("b")}`);
    expect(prompt).toContain(`--- Update 3 of 3 ---\n${done("c")}`);
    expect(prompt.indexOf(done("a"))).toBeLessThan(prompt.indexOf(done("b")));
  });
});

describe("acceptChildCompletion", () => {
  it("opens a row holding the message unchanged — one completion is one ordinary notification turn", () => {
    const p = parent();

    const accepted = acceptChildCompletion(p.id, p.sessionKey, done("a"));

    expect(accepted).toMatchObject({ joined: false, size: 1, prompt: done("a") });
    expect(getQueueItem(accepted.queueItemId)).toMatchObject({ sessionId: p.id, sessionKey: p.sessionKey, status: "pending", prompt: done("a") });
    expect(isCompletionBatchItem(accepted.queueItemId)).toBe(true);
  });

  it("joins the pending tail row instead of opening another", () => {
    const p = parent();
    const first = acceptChildCompletion(p.id, p.sessionKey, done("a"));

    const second = acceptChildCompletion(p.id, p.sessionKey, done("b"));
    const third = acceptChildCompletion(p.id, p.sessionKey, done("c"));

    expect(second).toMatchObject({ queueItemId: first.queueItemId, joined: true, size: 2 });
    expect(third).toMatchObject({ queueItemId: first.queueItemId, joined: true, size: 3 });
    expect(getQueueItems(p.sessionKey)).toHaveLength(1);
    // The row now carries all three, in the order they arrived.
    expect(getQueueItem(first.queueItemId)?.prompt).toBe(completionBatchPrompt([done("a"), done("b"), done("c")]));
    expect(third.prompt).toBe(getQueueItem(first.queueItemId)?.prompt);
  });

  it("never joins a row whose turn has already started", () => {
    const p = parent();
    const first = acceptChildCompletion(p.id, p.sessionKey, done("a"));
    expect(markQueueItemRunning(first.queueItemId)).toBe(true);

    const second = acceptChildCompletion(p.id, p.sessionKey, done("b"));

    expect(second.joined).toBe(false);
    expect(second.queueItemId).not.toBe(first.queueItemId);
    expect(getQueueItem(first.queueItemId)?.prompt).toBe(done("a")); // the running turn's prompt is not rewritten
  });

  it("does not reach past another kind of queued work", () => {
    const p = parent();
    const first = acceptChildCompletion(p.id, p.sessionKey, done("a"));
    // An operator message, a detached-job wake-up or a restart nudge queued behind it is an ordering fence.
    const other = enqueueQueueItem(p.id, p.sessionKey, "先にこちらを確認して");

    const second = acceptChildCompletion(p.id, p.sessionKey, done("b"));

    expect(second.joined).toBe(false);
    expect(isCompletionBatchItem(other)).toBe(false);
    expect(getQueueItem(other)?.prompt).toBe("先にこちらを確認して");
    expect(getQueueItems(p.sessionKey).map((item) => item.id)).toEqual([first.queueItemId, other, second.queueItemId]);
    // …and the batch behind the fence grows on its own.
    expect(acceptChildCompletion(p.id, p.sessionKey, done("c"))).toMatchObject({ queueItemId: second.queueItemId, joined: true, size: 2 });
  });

  it("keeps each parent's completions apart", () => {
    const p1 = parent();
    const p2 = parent();
    const a = acceptChildCompletion(p1.id, p1.sessionKey, done("a"));

    const b = acceptChildCompletion(p2.id, p2.sessionKey, done("b"));

    expect(b.joined).toBe(false);
    expect(getQueueItem(a.queueItemId)?.prompt).toBe(done("a"));
  });

  it(`caps a batch at ${COMPLETION_BATCH_MAX_ITEMS} completions`, () => {
    const p = parent();
    const first = acceptChildCompletion(p.id, p.sessionKey, done("e0"));
    for (let i = 1; i < COMPLETION_BATCH_MAX_ITEMS; i++) {
      expect(acceptChildCompletion(p.id, p.sessionKey, done(`e${i}`))).toMatchObject({ queueItemId: first.queueItemId, joined: true, size: i + 1 });
    }

    const overflow = acceptChildCompletion(p.id, p.sessionKey, done("overflow"));

    expect(overflow).toMatchObject({ joined: false, size: 1 });
    expect(overflow.queueItemId).not.toBe(first.queueItemId);
    expect(getQueueItem(first.queueItemId)?.prompt).not.toContain("overflow");
    // The overflow row is the new tail and takes what comes next.
    expect(acceptChildCompletion(p.id, p.sessionKey, done("next"))).toMatchObject({ queueItemId: overflow.queueItemId, joined: true, size: 2 });
  });

  it(`caps a batch at ${COMPLETION_BATCH_MAX_CHARS} characters`, () => {
    const p = parent();
    const big = (label: string) => `${label}:${"x".repeat(COMPLETION_BATCH_MAX_CHARS / 2 - 1_000)}`;
    const first = acceptChildCompletion(p.id, p.sessionKey, big("a"));
    expect(acceptChildCompletion(p.id, p.sessionKey, big("b"))).toMatchObject({ queueItemId: first.queueItemId, joined: true });

    const third = acceptChildCompletion(p.id, p.sessionKey, big("c"));

    expect(third.joined).toBe(false);
    expect(getQueueItem(first.queueItemId)!.prompt.length).toBeLessThanOrEqual(COMPLETION_BATCH_MAX_CHARS);
    expect(getQueueItem(third.queueItemId)?.prompt).toBe(big("c"));
  });
});

describe("queue_items.batch — existing instances", () => {
  // An instance upgraded by `npm update` keeps its database. Without the column
  // every child completion would fail in the /message route (500), and a
  // failed callback means a parent that is never woken.
  it("is added to a queue_items table created by an earlier release", () => {
    const old = new Database(":memory:");
    old.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, engine TEXT NOT NULL, engine_session_id TEXT, source TEXT NOT NULL, source_ref TEXT NOT NULL,
        employee TEXT, model TEXT, status TEXT DEFAULT 'idle', created_at TEXT NOT NULL, last_activity TEXT NOT NULL, last_error TEXT
      );
      CREATE TABLE queue_items (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_key TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, internal INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO queue_items (id, session_id, session_key, prompt, created_at) VALUES ('q1', 's1', 'k1', 'queued before the upgrade', '2026-10-01T00:00:00.000Z');
    `);

    migrateSessionsSchema(old);
    migrateSessionsSchema(old); // and a second boot does not trip over it

    const columns = (old.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("batch");
    // A row queued before the upgrade is simply not a batch.
    expect(old.prepare("SELECT prompt, batch FROM queue_items WHERE id = 'q1'").get()).toEqual({ prompt: "queued before the upgrade", batch: null });
    old.close();
  });

  it("treats a row without batch data as ordinary queued work", () => {
    const p = parent();
    const plain = enqueueQueueItem(p.id, p.sessionKey, "ordinary");

    expect(isCompletionBatchItem(plain)).toBe(false);
    expect(isCompletionBatchItem("no-such-row")).toBe(false);
  });
});

describe("completionChildOf", () => {
  it("names the child only when the caller says so and it really is this session's child", () => {
    const p = parent();
    const child = childOf(p, "worker");
    const stranger = childOf(parent(), "stranger");

    expect(completionChildOf(p, { completionOf: child.id })).toBe(child.id);
    expect(completionChildOf(p, { completionOf: stranger.id })).toBeNull();
    expect(completionChildOf(p, { completionOf: "no-such-session" })).toBeNull();
    expect(completionChildOf(p, { completionOf: 42 })).toBeNull();
    expect(completionChildOf(p, {})).toBeNull();
    expect(completionChildOf(p, null)).toBeNull();
  });
});

describe("queueChildCompletion — what the notification route calls", () => {
  it("batches a marked completion from a real child, and declines everything else", () => {
    const p = parent();
    const child = childOf(p, "worker");
    const queue = new SessionQueue();

    // Nobody dispatches in this test, so every row is one a restart left behind: it needs a dispatcher.
    expect(queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("worker"), queue)).toMatchObject({ joined: false, size: 1, needsDispatch: true });
    expect(queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("worker-2"), queue)).toMatchObject({ joined: true, size: 2, needsDispatch: true });
    // Unmarked (a failure, a job wake-up, a restart nudge) or not this session's child: the caller queues it as before.
    expect(queueChildCompletion(p, p.sessionKey, {}, "⚠️ failed", queue)).toBeNull();
    expect(queueChildCompletion(p, p.sessionKey, { completionOf: "someone-else" }, done("x"), queue)).toBeNull();
    expect(getQueueItems(p.sessionKey)).toHaveLength(1);
  });

  it("joins a row its dispatcher is still going to run, without asking for a second dispatcher", async () => {
    const p = parent();
    const child = childOf(p, "worker");
    const queue = new SessionQueue();
    const busy = await busyTurn(queue, p.sessionKey);
    const first = queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("a"), queue)!;
    const dispatched = queue.enqueue(p.sessionKey, async () => {}, first.queueItemId);

    expect(queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("b"), queue))
      .toMatchObject({ queueItemId: first.queueItemId, joined: true, needsDispatch: false });

    busy.finish();
    await Promise.all([busy.turn, dispatched]);
  });

  it("does not join a row a stop has cancelled — that row will be closed without running", async () => {
    const p = parent();
    const child = childOf(p, "worker");
    const queue = new SessionQueue();
    const busy = await busyTurn(queue, p.sessionKey);
    const first = queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("before-stop"), queue)!;
    let cancelledRan = false;
    const cancelled = queue.enqueue(p.sessionKey, async () => { cancelledRan = true; }, first.queueItemId);

    queue.clearQueue(p.sessionKey); // POST /api/sessions/:id/stop
    const after = queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("after-stop"), queue)!;

    // A completion that arrives after the stop is new work: its own row, its own dispatcher.
    expect(after).toMatchObject({ joined: false, needsDispatch: true });
    expect(after.queueItemId).not.toBe(first.queueItemId);
    expect(getQueueItem(first.queueItemId)?.prompt).toBe(done("before-stop"));
    let afterRan = false;
    const fresh = queue.enqueue(p.sessionKey, async () => { afterRan = true; }, after.queueItemId);
    busy.finish();
    await Promise.all([busy.turn, cancelled, fresh]);
    expect(cancelledRan).toBe(false);
    expect(afterRan).toBe(true);
  });

  it("never costs a notification: when batching cannot work it declines instead of throwing", () => {
    const p = parent();
    const child = childOf(p, "worker");
    const queue = new SessionQueue();
    const db = initDb();
    // The worst case for an upgraded instance: the column is not there.
    db.exec("ALTER TABLE queue_items DROP COLUMN batch");
    try {
      expect(queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("worker"), queue)).toBeNull();
      expect(getQueueItems(p.sessionKey)).toHaveLength(0); // nothing half-written; the route enqueues it itself
    } finally {
      migrateSessionsSchema(db);
    }
    expect(queueChildCompletion(p, p.sessionKey, { completionOf: child.id }, done("worker"), queue)).toMatchObject({ joined: false });
  });
});

describe("queuedPrompt", () => {
  it("is what the row holds now, not what the dispatcher captured", () => {
    const p = parent();
    const first = acceptChildCompletion(p.id, p.sessionKey, done("a"));
    acceptChildCompletion(p.id, p.sessionKey, done("b"));

    expect(queuedPrompt(first.queueItemId, done("a"))).toBe(completionBatchPrompt([done("a"), done("b")]));
    // No row, or a row that is gone: the captured prompt stands.
    expect(queuedPrompt(undefined, "captured")).toBe("captured");
    expect(queuedPrompt("no-such-row", "captured")).toBe("captured");
  });
});

describe("SessionQueue.dispatchState", () => {
  it("is live from enqueue until the row's task has drained, and none for a row nobody dispatched", async () => {
    const p = parent();
    const queue = new SessionQueue();
    const row = enqueueQueueItem(p.id, p.sessionKey, "work");
    const orphan = enqueueQueueItem(p.id, p.sessionKey, "left pending by a restart");
    let finish!: () => void;

    const task = queue.enqueue(p.sessionKey, () => new Promise<void>((resolve) => { finish = resolve; }), row);

    expect(queue.dispatchState(row)).toBe("live"); // already owned while it waits its turn
    expect(queue.dispatchState(orphan)).toBe("none");
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.dispatchState(row)).toBe("live");
    finish();
    await task;
    expect(queue.dispatchState(row)).toBe("none");
  });

  it("is cancelled once a stop has cancelled every task holding the row, and live again for a later dispatcher", async () => {
    const p = parent();
    const queue = new SessionQueue();
    const row = enqueueQueueItem(p.id, p.sessionKey, "work");
    const busy = await busyTurn(queue, p.sessionKey);
    const waiting = queue.enqueue(p.sessionKey, async () => {}, row);
    expect(queue.dispatchState(row)).toBe("live");

    queue.clearQueue(p.sessionKey);
    expect(queue.dispatchState(row)).toBe("cancelled");

    const later = enqueueQueueItem(p.id, p.sessionKey, "after the stop");
    const fresh = queue.enqueue(p.sessionKey, async () => {}, later);
    expect(queue.dispatchState(later)).toBe("live");
    busy.finish();
    await Promise.all([busy.turn, waiting, fresh]);
    expect(queue.dispatchState(row)).toBe("none");
  });

  it("stays live while a second dispatcher of the same row is still queued", async () => {
    const p = parent();
    const queue = new SessionQueue();
    const row = enqueueQueueItem(p.id, p.sessionKey, "work");
    let finish!: () => void;
    // The second dispatcher waits behind a blocker of its own, so the first drains while it is still queued.
    const blocker = queue.enqueue("other-chain", () => new Promise<void>((resolve) => { finish = resolve; }));
    const second = queue.enqueue("other-chain", async () => {}, row);

    await queue.enqueue(p.sessionKey, async () => {}, row);

    expect(queue.dispatchState(row)).toBe("live");
    finish();
    await blocker;
    await second;
    expect(queue.dispatchState(row)).toBe("none");
  });
});
