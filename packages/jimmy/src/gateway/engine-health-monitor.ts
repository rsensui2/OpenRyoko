/**
 * Re-checks an engine that is known to be out of allowance, so a record that
 * has stopped being true does not keep steering sessions away.
 *
 * Nothing here polls. A timer exists only while the store holds a limit an
 * engine itself declared — and, for a stated outage, one that names the window
 * it is held on — and it asks the provider, never spends a turn:
 *
 *  - on a doubling backoff from the moment the limit was seen (one minute,
 *    doubling to a half-hour cap, twelve times), and
 *  - once more at a stated outage's re-probe point, when that falls before the
 *    stated reset — a multi-day window, in practice.
 *
 * A reading is weaker evidence than a turn, so what the timer may do with one is
 * narrow. It may end an outage the provider no longer shows, and it may put a
 * date on a limit the engine declared without naming one. It never stretches a
 * stated outage: past the re-probe point a real turn decides, exactly as it
 * would without this timer. A probe that cannot tell changes nothing.
 */

import path from "node:path";
import { setEngineInstallProbe, usageLimitReason } from "../sessions/engine-health-gate.js";
import { spentClaudeWindowFor, windowCanHoldRecord } from "../shared/claude-limit-reset.js";
import { collectClaudeUsage, type ClaudeUsageResponse } from "../shared/claude-usage.js";
import {
  clearEngineHealth,
  onEngineHealthChange,
  readEngineHealth,
  recordEngineUnavailable,
  type EngineHealth,
} from "../shared/engine-health.js";
import { logger } from "../shared/logger.js";
import { tryResolveBin } from "../shared/resolveBin.js";

export type EngineHealthProbeVerdict =
  | { kind: "available" }
  | { kind: "exhausted"; resetsAt: number; window?: string }
  | { kind: "unknown" };

/** Asks the provider, without spending a turn, whether the engine a record is
 *  held against can serve again. */
export type EngineHealthProbe = (record: EngineHealth, now: Date) => Promise<EngineHealthProbeVerdict>;

export interface EngineHealthMonitor {
  stop: () => void;
}

/** The first re-check, the cap its doubling settles at, and how many re-checks
 *  one limit gets (the bounds upstream puts on parking against an unstated limit). */
const FIRST_DELAY_MS = 60_000;
const MAX_DELAY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 12;
/** setTimeout's ceiling; a longer delay would fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/** The backoff against one limit. `key` tells a new limit from a repeat of the same one. */
interface Watch { key: string; attempts: number; dueAt: number }

const time = (iso: string | undefined): number => (iso === undefined ? NaN : Date.parse(iso));

/** A limit the engine declared: a stated outage, or a declared limit still
 *  waiting for its reset to be learned. Nothing else is the timer's business.
 *
 *  A reading ends an outage only by showing the window it is held on open
 *  again. An outage that names no window leaves it nothing to look at, so it
 *  is not asked about: a served turn, or its stated reset, is what ends it. */
function watchKey(engine: string, record: EngineHealth | undefined): string | undefined {
  if (record?.state === "exhausted") return record.window === undefined ? undefined : `exhausted|${record.until ?? ""}`;
  return record?.state === "degraded" && record.reason === usageLimitReason(engine) ? "degraded" : undefined;
}

class HealthRecheckTimer implements EngineHealthMonitor {
  private readonly engines: string[];
  private readonly watches = new Map<string, Watch>();
  /** The re-probe point already asked about, per engine: asked once, not looped on. */
  private readonly asked = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firing = false;
  private stopped = false;

  constructor(private readonly probes: Readonly<Record<string, EngineHealthProbe>>) {
    this.engines = Object.keys(probes);
    this.unsubscribe = onEngineHealthChange(() => this.plan());
    this.plan();
  }

  stop = (): void => {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  };

  /** A stated outage's re-probe point, when it precedes the reset and is still unasked. */
  private reprobeAt(engine: string, record: EngineHealth): number | undefined {
    const recheckAt = time(record.recheckAt);
    if (record.state !== "exhausted" || !(recheckAt < time(record.until))) return undefined;
    return this.asked.get(engine) === record.recheckAt ? undefined : recheckAt;
  }

  /** When `engine` is next worth asking about, or undefined when it is not. */
  private nextCheck(engine: string, record: EngineHealth | undefined, now: number): number | undefined {
    const key = watchKey(engine, record);
    if (!record || key === undefined) {
      this.watches.delete(engine);
      this.asked.delete(engine);
      return undefined;
    }
    let watch = this.watches.get(engine);
    if (watch?.key !== key) {
      const observedAt = time(record.observedAt);
      watch = { key, attempts: 0, dueAt: (Number.isFinite(observedAt) ? observedAt : now) + FIRST_DELAY_MS };
      this.watches.set(engine, watch);
    }
    const due = [watch.attempts < MAX_ATTEMPTS ? watch.dueAt : undefined, this.reprobeAt(engine, record)]
      .filter((at): at is number => at !== undefined);
    return due.length > 0 ? Math.min(...due) : undefined;
  }

  /** Aim the one timer at the earliest thing worth asking about, or at nothing. */
  private plan(): void {
    if (this.stopped || this.firing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = new Date();
    const health = readEngineHealth(now);
    const next = Math.min(...this.engines.map((engine) => this.nextCheck(engine, health[engine], now.getTime()) ?? Infinity));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => { void this.fire(); }, Math.min(Math.max(0, next - now.getTime()), MAX_TIMER_MS));
    this.timer.unref?.();
  }

  /** Move the backoff on; `done` ends it for this limit. */
  private advance(engine: string, now: number, done = false): void {
    const watch = this.watches.get(engine);
    if (!watch) return;
    const attempts = done ? MAX_ATTEMPTS : watch.attempts + 1;
    this.watches.set(engine, { ...watch, attempts, dueAt: now + Math.min(FIRST_DELAY_MS * 2 ** attempts, MAX_DELAY_MS) });
  }

  private settle(engine: string, record: EngineHealth, verdict: EngineHealthProbeVerdict, now: Date): void {
    if (record.state === "exhausted") {
      if (verdict.kind === "available") {
        if (clearEngineHealth(engine)) logger.info(`Engine health: ${engine} re-checked — its allowance is available again`);
        return;
      }
      // Still spent, or no answer: asked, and left as it is. Past the re-probe
      // point the next real turn decides.
      if (time(record.recheckAt) <= now.getTime()) this.asked.set(engine, record.recheckAt ?? "");
      this.advance(engine, now.getTime());
      return;
    }
    if (verdict.kind === "exhausted") {
      // The engine declared the limit minutes ago; the provider now says when it ends.
      recordEngineUnavailable(engine, usageLimitReason(engine), verdict.resetsAt, now, verdict.window);
      logger.info(`Engine health: ${engine} is out of allowance until ${new Date(verdict.resetsAt * 1000).toISOString()}`);
      return;
    }
    // Nothing spent on the provider's side means there is no reset to learn.
    this.advance(engine, now.getTime(), verdict.kind === "available");
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.firing) return;
    this.firing = true;
    this.timer = undefined;
    try {
      for (const engine of this.engines) {
        const now = new Date();
        const record = readEngineHealth(now)[engine];
        const due = this.nextCheck(engine, record, now.getTime());
        if (!record || due === undefined || due > now.getTime()) continue;
        const verdict = await Promise.resolve()
          .then(() => this.probes[engine](record, now))
          .catch((): EngineHealthProbeVerdict => ({ kind: "unknown" }));
        if (this.stopped) return;
        this.settle(engine, record, verdict, new Date());
      }
    } catch (error) {
      logger.warn(`Engine health re-check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.firing = false;
      this.plan();
    }
  }
}

export function startEngineHealthMonitor(options: { probes: Readonly<Record<string, EngineHealthProbe>> }): EngineHealthMonitor {
  return new HealthRecheckTimer(options.probes);
}

/**
 * Claude's probe: the account's own usage source, which the dashboard already
 * reads. "Available" is claimed only when no window that could be holding the
 * record is spent; a spent window that names no reset still ahead, like a
 * source that did not answer, is "cannot tell".
 *
 * So is a stated outage that names no window — `claude -p` reports a rejection
 * with its reset and nothing else. It may be held by a window scoped to one
 * model, which is not among those looked at for a record that names none, and
 * the shared windows being open says nothing about that one.
 */
export function claudeUsageProbe(
  collect: (options: { timeoutMs?: number }) => Promise<ClaudeUsageResponse> = collectClaudeUsage,
): EngineHealthProbe {
  return async (record, now) => {
    const usage = await collect({});
    if (!usage.available) return { kind: "unknown" };
    const spent = spentClaudeWindowFor(usage.windows, record.window, now.getTime());
    if (spent?.resetsAt !== undefined) return { kind: "exhausted", resetsAt: spent.resetsAt, window: spent.name };
    if (record.state === "exhausted" && record.window === undefined) return { kind: "unknown" };
    const unclear = usage.windows.some((window) => window.usedPercent >= 100 && windowCanHoldRecord(window.name, record.window));
    return unclear ? { kind: "unknown" } : { kind: "available" };
  };
}

/**
 * Whether an engine binary is on this machine, as far as can be told without
 * running it: the same lookup the onboarding probe starts with. A relative path
 * is resolved by the spawn against its own working directory, not by PATH, so
 * it is never ruled out here.
 */
export function engineBinaryInstalled(bin: string): boolean {
  if (!path.isAbsolute(bin) && /[\\/]/.test(bin)) return true;
  return tryResolveBin(bin) !== null;
}

/**
 * Everything the gateway process owes engine health for as long as it runs: the
 * re-check timer, and the installed-binary check the session layer consults
 * before handing a session to a fallback engine. Returns the teardown.
 */
export function startEngineHealth(): () => void {
  setEngineInstallProbe(engineBinaryInstalled);
  const monitor = startEngineHealthMonitor({ probes: { claude: claudeUsageProbe() } });
  return () => {
    monitor.stop();
    setEngineInstallProbe(undefined);
  };
}
