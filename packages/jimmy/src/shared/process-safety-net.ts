import { logger } from "./logger.js";

/**
 * Last-resort handlers for the process that runs the gateway.
 *
 * Node 22 terminates on an unhandled rejection, so one stray promise — an SDK
 * that fires a request from a constructor, a timer callback nobody awaits —
 * took every connector and every running session down with it. The gateway
 * now logs the fault and stays up.
 *
 * Call this only from the entry points that become the gateway process (the
 * foreground `ryoko start` and the daemon child). A short-lived CLI command
 * should still fail loudly, and a test worker must keep its own handlers.
 */

/** This many uncaught exceptions inside the window is a crash loop, not a stray fault. */
export const UNCAUGHT_EXCEPTION_BURST_LIMIT = 10;
export const UNCAUGHT_EXCEPTION_BURST_WINDOW_MS = 60_000;

/** The slice of `process` the net attaches to — tests pass a plain EventEmitter. */
export interface SafetyNetTarget {
  on(event: "unhandledRejection" | "uncaughtException", listener: (fault: unknown) => void): unknown;
}

export interface ProcessSafetyNetOptions {
  target?: SafetyNetTarget;
  exit?: (code: number) => void;
  now?: () => number;
}

/**
 * What the net has caught since it was installed. Keeping the process alive
 * has a cost — a connection that a crash-and-restart used to re-establish can
 * stay broken — so this has to be visible from outside, not only in the log.
 * Counts and a time, never what was caught.
 */
export interface ProcessSafetyNetStats {
  unhandledRejections: number;
  uncaughtExceptions: number;
  /** ISO time of the most recent fault of either kind; null when none was caught. */
  lastCaughtAt: string | null;
}

interface Tally {
  unhandledRejections: number;
  uncaughtExceptions: number;
  lastCaughtAtMs: number | null;
}

const NOTHING_CAUGHT: Tally = { unhandledRejections: 0, uncaughtExceptions: 0, lastCaughtAtMs: null };

/** One entry per target the net is installed on. Entries are replaced, never mutated. */
const tallies = new WeakMap<object, Tally>();

function tally(target: object, kind: "unhandledRejections" | "uncaughtExceptions", at: number): void {
  const before = tallies.get(target) ?? NOTHING_CAUGHT;
  tallies.set(target, { ...before, [kind]: before[kind] + 1, lastCaughtAtMs: at });
}

/** A snapshot for `target` (the real process by default); zeros when the net is not installed. */
export function getProcessSafetyNetStats(target: object = process): ProcessSafetyNetStats {
  const { unhandledRejections, uncaughtExceptions, lastCaughtAtMs } = tallies.get(target) ?? NOTHING_CAUGHT;
  return {
    unhandledRejections,
    uncaughtExceptions,
    lastCaughtAt: lastCaughtAtMs === null ? null : new Date(lastCaughtAtMs).toISOString(),
  };
}

/**
 * The stack for an Error, and only the stack: `cause`, and whatever an SDK
 * hangs off its errors (request config, headers), stay out of the log. The
 * logger redacts token-shaped strings in what is left.
 */
function describeFault(fault: unknown): string {
  if (fault instanceof Error) return fault.stack ?? fault.message;
  try {
    return String(fault);
  } catch {
    return `[unprintable ${typeof fault}]`;
  }
}

/** Throwing from inside these handlers would end the process on the spot. */
function report(message: string): void {
  try {
    logger.error(message);
  } catch {
    // Nothing is left to report to.
  }
}

/**
 * Install the handlers once per target. Returns false when they were already
 * there, so calling it from more than one entry path is harmless.
 */
export function installProcessSafetyNet(options: ProcessSafetyNetOptions = {}): boolean {
  const target = options.target ?? process;
  if (tallies.has(target)) return false;
  tallies.set(target, NOTHING_CAUGHT);

  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? Date.now;
  let recent: number[] = [];

  target.on("unhandledRejection", (reason) => {
    tally(target, "unhandledRejections", now());
    report(`Unhandled promise rejection: ${describeFault(reason)}`);
  });

  target.on("uncaughtException", (error) => {
    const at = now();
    tally(target, "uncaughtExceptions", at);
    report(`Uncaught exception: ${describeFault(error)}`);
    // State after an uncaught exception is not guaranteed. One fault is worth
    // surviving; a stream of them means the gateway is no longer working and
    // would only fill the log, so hand control back to whatever supervises it.
    recent = [...recent.filter((seen) => at - seen < UNCAUGHT_EXCEPTION_BURST_WINDOW_MS), at];
    if (recent.length < UNCAUGHT_EXCEPTION_BURST_LIMIT) return;
    report(
      `${recent.length} uncaught exceptions within ${UNCAUGHT_EXCEPTION_BURST_WINDOW_MS / 1000}s — exiting instead of running on in a broken state`,
    );
    exit(1);
  });

  return true;
}
