import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PTY_SNAPSHOTS_DIR } from "../shared/paths.js";

export const PTY_SNAPSHOT_MAX_BYTES = 256 * 1024;
const VERSION = 1;

interface PersistedSnapshot { version: number; data: string }

/** Atomic, debounced persistence for the raw xterm byte stream already kept by
 * InteractiveClaudeEngine. The browser's xterm remains the renderer. */
export class PtySnapshotStore {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private epochs = new Map<string, number>();

  constructor(private directory = PTY_SNAPSHOTS_DIR, private debounceMs = 250) {}

  loadSync(sessionId: string): Buffer | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(sessionId), "utf8")) as Partial<PersistedSnapshot>;
      if (parsed.version !== VERSION || typeof parsed.data !== "string") return undefined;
      const value = Buffer.from(parsed.data, "base64");
      if (value.length === 0 || value.length > PTY_SNAPSHOT_MAX_BYTES) return undefined;
      return value;
    } catch { return undefined; }
  }

  schedule(sessionId: string, read: () => Buffer): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    const epoch = this.epochs.get(sessionId) ?? 0;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      const data = read();
      if (data.length === 0 || (this.epochs.get(sessionId) ?? 0) !== epoch) return;
      this.writeAtomic(sessionId, data.subarray(Math.max(0, data.length - PTY_SNAPSHOT_MAX_BYTES)), epoch);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  flushSync(sessionId: string, read: () => Buffer): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    const data = read();
    if (data.length > 0) this.writeAtomic(sessionId, data.subarray(Math.max(0, data.length - PTY_SNAPSHOT_MAX_BYTES)), this.epochs.get(sessionId) ?? 0);
  }

  deleteSync(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
    try { fs.rmSync(this.fileFor(sessionId), { force: true }); } catch { /* best effort */ }
  }

  private writeAtomic(sessionId: string, data: Buffer, epoch: number): void {
    if ((this.epochs.get(sessionId) ?? 0) !== epoch) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.fileFor(sessionId);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: VERSION, data: data.toString("base64") }), { mode: 0o600 });
      if ((this.epochs.get(sessionId) ?? 0) !== epoch) return;
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private fileFor(sessionId: string): string {
    return path.join(this.directory, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  }
}

export const ptySnapshotStore = new PtySnapshotStore();
