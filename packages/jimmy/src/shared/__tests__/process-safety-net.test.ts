import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNCAUGHT_EXCEPTION_BURST_LIMIT,
  UNCAUGHT_EXCEPTION_BURST_WINDOW_MS,
  getProcessSafetyNetStats,
  installProcessSafetyNet,
} from "../process-safety-net.js";

// The net is always installed on a throwaway emitter here: attaching it to the
// real `process` would change how every other suite in this worker fails.

function fixture() {
  const target = new EventEmitter();
  const exit = vi.fn();
  let clock = 1_000_000;
  const installed = installProcessSafetyNet({ target, exit, now: () => clock });
  return {
    target,
    exit,
    installed,
    advance: (ms: number) => { clock += ms; },
  };
}

describe("installProcessSafetyNet", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    // The real logger is kept so its redaction is part of what is asserted.
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an unhandled rejection with its stack and keeps the process alive", () => {
    const f = fixture();
    const reason = new Error("slack auth.test failed");

    f.target.emit("unhandledRejection", reason, Promise.resolve());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ERROR] Unhandled promise rejection: Error: slack auth.test failed");
    expect(lines[0]).toContain("process-safety-net.test.ts");
    expect(f.exit).not.toHaveBeenCalled();
  });

  it("logs an uncaught exception with its stack and keeps the process alive", () => {
    const f = fixture();

    f.target.emit("uncaughtException", new TypeError("boom"), "uncaughtException");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ERROR] Uncaught exception: TypeError: boom");
    expect(lines[0]).toContain("process-safety-net.test.ts");
    expect(f.exit).not.toHaveBeenCalled();
  });

  it("reports reasons that are not errors, including ones that cannot be printed", () => {
    const f = fixture();

    expect(() => {
      f.target.emit("unhandledRejection", "plain string reason");
      f.target.emit("unhandledRejection", undefined);
      f.target.emit("uncaughtException", Object.create(null));
    }).not.toThrow();

    expect(lines[0]).toContain("Unhandled promise rejection: plain string reason");
    expect(lines[1]).toContain("Unhandled promise rejection: undefined");
    expect(lines[2]).toContain("Uncaught exception: [unprintable object]");
    expect(f.exit).not.toHaveBeenCalled();
  });

  it("logs only the stack, never the objects attached to the error", () => {
    const f = fixture();
    const error = Object.assign(new Error("request failed", { cause: new Error("inner-cause-detail") }), {
      config: { headers: { cookie: "session-cookie-value" } },
    });

    f.target.emit("unhandledRejection", error);

    expect(lines[0]).toContain("request failed");
    expect(lines[0]).not.toContain("inner-cause-detail");
    expect(lines[0]).not.toContain("session-cookie-value");
  });

  it("passes the reason through the logger's secret redaction", () => {
    const f = fixture();
    const slackToken = "xoxb-" + "1234567890-abcdefghijklmnop";
    const bearer = "sk-live_" + "1234567890abcdef";

    f.target.emit("unhandledRejection", new Error(`invalid_auth for ${slackToken}`));
    f.target.emit("uncaughtException", `Authorization: Bearer ${bearer}`);

    const output = lines.join("\n");
    expect(output).not.toContain(slackToken);
    expect(output).not.toContain(bearer);
    expect(output).toContain("[REDACTED]");
  });

  it("exits once uncaught exceptions keep arriving inside the window", () => {
    const f = fixture();

    for (let i = 1; i < UNCAUGHT_EXCEPTION_BURST_LIMIT; i++) {
      f.target.emit("uncaughtException", new Error(`fault ${i}`));
      f.advance(1_000);
    }
    expect(f.exit).not.toHaveBeenCalled();

    f.target.emit("uncaughtException", new Error("one too many"));

    expect(f.exit).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledWith(1);
    expect(lines.at(-2)).toContain("Uncaught exception: Error: one too many");
    expect(lines.at(-1)).toContain(`${UNCAUGHT_EXCEPTION_BURST_LIMIT} uncaught exceptions`);
  });

  it("does not count exceptions that have aged out of the window", () => {
    const f = fixture();

    for (let i = 1; i < UNCAUGHT_EXCEPTION_BURST_LIMIT; i++) {
      f.target.emit("uncaughtException", new Error(`fault ${i}`));
    }
    f.advance(UNCAUGHT_EXCEPTION_BURST_WINDOW_MS);
    for (let i = 1; i < UNCAUGHT_EXCEPTION_BURST_LIMIT; i++) {
      f.target.emit("uncaughtException", new Error(`later fault ${i}`));
    }

    expect(f.exit).not.toHaveBeenCalled();
  });

  it("never exits on unhandled rejections alone", () => {
    const f = fixture();

    for (let i = 0; i < UNCAUGHT_EXCEPTION_BURST_LIMIT * 3; i++) {
      f.target.emit("unhandledRejection", new Error(`rejection ${i}`));
    }

    expect(f.exit).not.toHaveBeenCalled();
  });

  it("installs once per target", () => {
    const f = fixture();
    expect(f.installed).toBe(true);

    expect(installProcessSafetyNet({ target: f.target, exit: f.exit })).toBe(false);

    expect(f.target.listenerCount("unhandledRejection")).toBe(1);
    expect(f.target.listenerCount("uncaughtException")).toBe(1);
    f.target.emit("unhandledRejection", new Error("logged once"));
    expect(lines).toHaveLength(1);
  });
});

// Keeping the process alive has a cost: a connection that a crash-and-restart
// used to re-establish can now stay broken. What the net caught has to be
// visible from outside, not only in the log.
describe("getProcessSafetyNetStats", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports nothing caught for a target the net was never installed on", () => {
    expect(getProcessSafetyNetStats(new EventEmitter())).toEqual({
      unhandledRejections: 0,
      uncaughtExceptions: 0,
      lastCaughtAt: null,
    });
  });

  it("reports nothing caught right after the net is installed", () => {
    const f = fixture();

    expect(getProcessSafetyNetStats(f.target)).toEqual({
      unhandledRejections: 0,
      uncaughtExceptions: 0,
      lastCaughtAt: null,
    });
  });

  it("counts each kind of fault and remembers when the last one was caught", () => {
    const f = fixture();

    f.target.emit("unhandledRejection", new Error("first"));
    f.advance(5_000);
    f.target.emit("unhandledRejection", "second");
    f.advance(5_000);
    f.target.emit("uncaughtException", new Error("third"));

    expect(getProcessSafetyNetStats(f.target)).toEqual({
      unhandledRejections: 2,
      uncaughtExceptions: 1,
      lastCaughtAt: new Date(1_000_000 + 10_000).toISOString(),
    });
  });

  it("never carries what was caught, only how many and when", () => {
    const f = fixture();
    const secret = "xoxb-" + "1234567890-abcdefghijklmnop";

    f.target.emit("unhandledRejection", new Error(`invalid_auth for ${secret}`));
    f.target.emit("uncaughtException", new Error(`boom ${secret}`));

    const stats = getProcessSafetyNetStats(f.target);
    expect(Object.keys(stats).sort()).toEqual(["lastCaughtAt", "uncaughtExceptions", "unhandledRejections"]);
    expect(JSON.stringify(stats)).not.toContain(secret);
    expect(JSON.stringify(stats)).not.toContain("invalid_auth");
  });

  it("hands out a snapshot that later faults do not change", () => {
    const f = fixture();
    f.target.emit("unhandledRejection", new Error("first"));
    const before = getProcessSafetyNetStats(f.target);

    f.target.emit("unhandledRejection", new Error("second"));

    expect(before.unhandledRejections).toBe(1);
    expect(getProcessSafetyNetStats(f.target).unhandledRejections).toBe(2);
  });

  it("keeps separate counts for separate targets", () => {
    const first = fixture();
    const second = fixture();

    first.target.emit("uncaughtException", new Error("only here"));

    expect(getProcessSafetyNetStats(first.target).uncaughtExceptions).toBe(1);
    expect(getProcessSafetyNetStats(second.target).uncaughtExceptions).toBe(0);
  });

  it("reads the real process by default, which no test installs the net on", () => {
    expect(getProcessSafetyNetStats()).toEqual({
      unhandledRejections: 0,
      uncaughtExceptions: 0,
      lastCaughtAt: null,
    });
  });
});
