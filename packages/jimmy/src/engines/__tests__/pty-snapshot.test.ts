import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PTY_SNAPSHOT_MAX_BYTES, PtySnapshotStore } from "../pty-snapshot.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("durable PTY snapshot store", () => {
  it("atomically persists bounded raw xterm scrollback under a hashed filename", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-pty-snapshot-"));
    roots.push(root);
    const store = new PtySnapshotStore(root, 0);
    const source = Buffer.from(`old-${"x".repeat(PTY_SNAPSHOT_MAX_BYTES)}-latest`);
    store.flushSync("session/unsafe", () => source);

    const restored = store.loadSync("session/unsafe")!;
    expect(restored.length).toBe(PTY_SNAPSHOT_MAX_BYTES);
    expect(restored.toString().endsWith("-latest")).toBe(true);
    expect(fs.readdirSync(root)).toHaveLength(1);
    expect(fs.readdirSync(root)[0]).not.toContain("session");
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, fs.readdirSync(root)[0])).mode & 0o777).toBe(0o600);
  });

  it("cancels pending persistence and removes the snapshot on deletion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-pty-snapshot-delete-"));
    roots.push(root);
    const store = new PtySnapshotStore(root, 10);
    store.schedule("deleted", () => Buffer.from("stale"));
    store.deleteSync("deleted");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.loadSync("deleted")).toBeUndefined();
  });
});
