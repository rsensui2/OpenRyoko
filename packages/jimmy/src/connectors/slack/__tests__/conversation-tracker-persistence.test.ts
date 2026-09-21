import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTracker, type ConversationTrackerOptions } from "../conversation-tracker.js";

const message = { channel: "C1", threadTs: "100.1", ts: "100.2", userId: "U1" };
let directory: string;
let statePath: string;
let trackers: ConversationTracker[];
let now: number;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-conversation-test-"));
  statePath = path.join(directory, "state", "conversations.json");
  trackers = [];
  now = 1000;
});
afterEach(() => {
  for (const tracker of trackers) tracker.flush();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});
function create(options: ConversationTrackerOptions = {}) {
  const tracker = new ConversationTracker({ statePath, now: () => now, idleTimeoutMs: 100, ...options });
  trackers.push(tracker);
  return tracker;
}
function savedSnapshot() {
  const original = create();
  original.recordAwaitingInput(message);
  original.flush();
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

describe("ConversationTracker persistence", () => {
  it("restores next-day pending input with its known recipient and thread membership", () => {
    const original = create();
    original.recordAwaitingInput(message);
    original.flush();
    now += 24 * 60 * 60 * 1000;
    const restarted = create();
    expect(restarted.getContext(message)).toMatchObject({ status: "awaiting_input", awaitingUserId: "U1" });
    expect(restarted.isDmEquivalent(message)).toBe(true);
    expect(restarted.isBotEngagedThread("C1", "100.1")).toBe(true);
    restarted.recordHumanMessage(message);
    restarted.recordAcceptedMessage(message);
    expect(restarted.getContext(message).status).toBe("conversing");
  });

  it("restores completed thread membership without restoring bypass", () => {
    const original = create();
    original.recordBotReply(message);
    original.recordCompleted(message);
    original.flush();
    const restarted = create();
    expect(restarted.getContext(message).status).toBe("completed");
    expect(restarted.isDmEquivalent(message)).toBe(false);
    expect(restarted.isBotEngagedThread("C1", "100.1")).toBe(true);
  });

  it("retains the exact pending bot reply across human observations and restart", () => {
    const original = create();
    original.recordBotReply(message, { messageTs: "100.3" });
    original.setThreadState("C1", "100.1", "awaiting_input", "U1");
    original.recordHumanMessage({ ...message, ts: "100.4", userId: "U2" });
    original.recordBotReaction(message);
    original.flush();
    expect(create().getContext(message)).toMatchObject({
      status: "awaiting_input", awaitingUserId: "U1", lastBotMessageTs: "100.3",
    });
  });

  it("loads older snapshots without inventing a pending bot message identity", () => {
    const snapshot = savedSnapshot();
    delete snapshot.entries[0].state.lastBotMessageTs;
    fs.writeFileSync(statePath, JSON.stringify(snapshot));
    expect(create().getContext(message)).toMatchObject({
      status: "awaiting_input", awaitingUserId: "U1", lastBotMessageTs: null,
    });
  });

  it("restores root/thread links and completes both after a thread answer", () => {
    const original = create();
    const root = { channel: "C1", userId: "U1", ts: "100.1" };
    original.recordBotReply(root);
    original.recordBotReply(message);
    original.linkRootConversation("C1", "U1", "100.1");
    original.setThreadState("C1", "100.1", "awaiting_input", "U1");
    original.flush();
    now += 24 * 60 * 60 * 1000;
    const restarted = create();
    restarted.recordAcceptedMessage(message);
    expect(restarted.getContext(root).status).toBe("conversing");
    restarted.setThreadState("C1", "100.1", "completed", "U1");
    expect(restarted.getContext(root).status).toBe("completed");
    expect(restarted.getContext(message).status).toBe("completed");
  });

  it("does not let an older persisted thread close a newer pending root alias", () => {
    const original = create();
    const root = { channel: "C1", userId: "U1" };
    for (const threadTs of ["100.1", "200.1"]) {
      original.recordBotReply(root);
      original.recordBotReply({ ...root, threadTs });
      original.linkRootConversation("C1", "U1", threadTs);
      original.setThreadState("C1", threadTs, "awaiting_input", "U1");
    }
    original.flush();
    const restarted = create();
    restarted.recordAcceptedMessage(message);
    restarted.setThreadState("C1", "100.1", "completed", "U1");
    expect(restarted.getContext(root).status).toBe("awaiting_input");
    expect(restarted.getContext({ ...root, threadTs: "200.1" }).status).toBe("awaiting_input");
  });

  it("expires ordinary conversations across downtime", () => {
    const original = create();
    original.recordBotReply(message);
    original.flush();
    now += 101;
    const restarted = create();
    expect(restarted.getContext(message).status).toBe("none");
    expect(restarted.isDmEquivalent(message)).toBe(false);
    expect(restarted.isBotEngagedThread("C1", "100.1")).toBe(true);
  });

  it("preserves the distinction between unknown recipients and bot-created roots", () => {
    const original = create();
    original.recordBotThreadReply("C1", "100.1");
    original.recordBotInitiatedThread("C1", "200.1");
    original.flush();
    const restarted = create();
    restarted.recordHumanMessage(message);
    expect(restarted.isDmEquivalent(message)).toBe(false);
    const ownThread = { ...message, threadTs: "200.1" };
    restarted.recordHumanMessage(ownThread);
    expect(restarted.isDmEquivalent(ownThread)).toBe(true);
  });

  it("restores reaction context without ever granting conversation membership", () => {
    const original = create();
    original.recordBotReaction(message);
    original.flush();
    const restarted = create();
    expect(restarted.getContext(message).status).toBe("reacted");
    expect(restarted.isDmEquivalent(message)).toBe(false);
    expect(restarted.isBotEngagedThread("C1", "100.1")).toBe(false);
  });

  it("writes private atomic snapshots containing no message text or ambient-only entries", () => {
    const original = create();
    const extra = { ...message, text: "confidential content must never be retained" };
    original.recordHumanMessage(extra);
    original.recordAwaitingInput(message);
    original.recordHumanMessage({ ...message, channel: "AMBIENT" });
    original.flush();
    const content = fs.readFileSync(statePath, "utf8");
    expect(content).not.toContain("confidential");
    expect(content).not.toContain("AMBIENT");
    expect(JSON.parse(content).entries).toHaveLength(1);
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(statePath))).toEqual(["conversations.json"]);
  });

  it("does not create snapshots for passive channel observations", () => {
    const original = create();
    original.recordHumanMessage(message);
    original.flush();
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("debounces writes and flushes invalidations on shutdown", () => {
    vi.useFakeTimers();
    const original = create();
    original.recordAwaitingInput(message);
    original.recordBotReaction(message);
    vi.advanceTimersByTime(99);
    expect(fs.existsSync(statePath)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(fs.existsSync(statePath)).toBe(true);
    original.invalidate("C1:thread:100.1");
    original.flush();
    expect(create().size()).toBe(0);
  });

  it("starts empty on invalid JSON without crashing", () => {
    fs.mkdirSync(path.dirname(statePath));
    fs.writeFileSync(statePath, "not JSON");
    expect(create().size()).toBe(0);
  });

  it("rejects snapshots larger than 2 MiB before parsing", () => {
    fs.mkdirSync(path.dirname(statePath));
    fs.writeFileSync(statePath, " ".repeat(2 * 1024 * 1024 + 1));
    expect(create().size()).toBe(0);
  });

  it.each([
    ["unknown status", (row: any) => { row.state.status = "skip_all_gates"; }],
    ["invalid time", (row: any) => { row.state.lastMessageAt = -1; }],
    ["non-numeric time", (row: any) => { row.state.lastMessageAt = "tomorrow"; }],
    ["too many participants", (row: any) => { row.state.humanSpeakers = ["U1", "U2", "U3"]; }],
    ["invalid actor", (row: any) => { row.state.lastActor = "system"; }],
    ["oversized ID", (row: any) => { row.state.awaitingUserId = "U".repeat(257); }],
    ["message text", (row: any) => { row.state.text = "This must never be loaded"; }],
    ["invalid key", (row: any) => { row.key = "not-a-conversation"; }],
    ["invalid linked thread", (row: any) => { row.state.linkedThreadTs = "secret content / invalid"; }],
    ["invalid linked user", (row: any) => { row.state.rootUserId = ["U1"]; }],
    ["invalid bot message identity", (row: any) => { row.state.lastBotMessageTs = "invalid / text"; }],
  ])("rejects entire snapshots with %s", (_name, corrupt) => {
    const snapshot = savedSnapshot();
    corrupt(snapshot.entries[0]);
    fs.writeFileSync(statePath, JSON.stringify(snapshot));
    expect(create().size()).toBe(0);
  });

  it("rejects nonfinite JSON times", () => {
    savedSnapshot();
    const raw = fs.readFileSync(statePath, "utf8").replace('"lastMessageAt":1000', '"lastMessageAt":1e999');
    fs.writeFileSync(statePath, raw);
    expect(create().size()).toBe(0);
  });

  it("rejects duplicate entries and snapshots above the configured record limit", () => {
    const snapshot = savedSnapshot();
    snapshot.entries.push(snapshot.entries[0]);
    fs.writeFileSync(statePath, JSON.stringify(snapshot));
    expect(create().size()).toBe(0);
    snapshot.entries[1] = { ...snapshot.entries[1], key: "C2:thread:100.1" };
    fs.writeFileSync(statePath, JSON.stringify(snapshot));
    expect(create({ maxEntries: 1 }).size()).toBe(0);
  });

  it("keeps operation available when the snapshot cannot be written", () => {
    const original = create({ statePath: directory });
    expect(() => {
      original.recordAwaitingInput(message);
      original.flush();
    }).not.toThrow();
    expect(original.isDmEquivalent(message)).toBe(true);
  });
});
