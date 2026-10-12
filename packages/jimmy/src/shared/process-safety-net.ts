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

const guarded = new WeakSet<object>();

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
  if (guarded.has(target)) return false;
  guarded.add(target);

  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? Date.now;
  let recent: number[] = [];

  target.on("unhandledRejection", (reason) => {
    report(`Unhandled promise rejection: ${describeFault(reason)}`);
  });

  target.on("uncaughtException", (error) => {
    report(`Uncaught exception: ${describeFault(error)}`);
    // State after an uncaught exception is not guaranteed. One fault is worth
    // surviving; a stream of them means the gateway is no longer working and
    // would only fill the log, so hand control back to whatever supervises it.
    const at = now();
    recent = [...recent.filter((seen) => at - seen < UNCAUGHT_EXCEPTION_BURST_WINDOW_MS), at];
    if (recent.length < UNCAUGHT_EXCEPTION_BURST_LIMIT) return;
    report(
      `${recent.length} uncaught exceptions within ${UNCAUGHT_EXCEPTION_BURST_WINDOW_MS / 1000}s — exiting instead of running on in a broken state`,
    );
    exit(1);
  });

  return true;
}
