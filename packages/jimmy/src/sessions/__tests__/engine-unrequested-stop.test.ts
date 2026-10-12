import { afterEach, describe, expect, it, vi } from "vitest";
import { engineFallbackFailure, runEngineWithResponseTimeout } from "../engine-fallback.js";
import { createSession, getSession, updateSession } from "../registry.js";
import { beginGatewayShutdown, prepareRestartResume, readRestartResumeState } from "../restart-resume.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";
import type { Engine, EngineResult, JinnConfig } from "../../shared/types.js";

// An engine reports every run that ends early as "Interrupted: …" — whether the
// gateway asked for the stop (a newer message, /stop, an engine switch, a
// shutdown) or the engine's own process died. The runners treat "Interrupted"
// as a quiet, deliberate end: no reply, no error, status idle. So a crashed
// Claude process left a Slack thread without an answer and a cron run "green".
//
// The engine now marks the stops it was asked for (`interruptRequested`), and
// the one function every engine run goes through turns the rest into what they
// are: failed runs.
const config = { engines: { default: "claude", claude: { bin: "claude" }, codex: { bin: "codex" } }, sessions: {}, connectors: {} } as unknown as JinnConfig;
let sequence = 0;

function engineReturning(result: EngineResult, name = "claude"): Engine {
  return { name, run: vi.fn(async () => result) } as Engine;
}

const run = (engine: Engine, sessionId = `unrequested-${++sequence}`) =>
  runEngineWithResponseTimeout(engine, { prompt: "task", cwd: "/tmp", sessionId }, config);

// A boot is what ends "shutting down" (the next process starts clean).
afterEach(() => { prepareRestartResume(); });

describe("an engine run that stopped without being asked to", () => {
  it("is a failed run: it says what happened, and it is not retried as a stale session", async () => {
    const result = await run(engineReturning({ sessionId: "native", result: "", error: "Interrupted: claude process exited" }));

    expect(result.error).toBe("claude stopped unexpectedly: claude process exited");
    expect(result.error?.startsWith("Interrupted")).toBe(false); // nothing downstream takes it for a requested stop
    // Not an invitation to run the prompt again on a fresh engine session: the dead turn may have run tools.
    expect(result.retryable).toBe(false);
    expect(isDeadSessionError(result)).toBe(false);
    expect(engineFallbackFailure(result)).toBeNull();
    expect(result.sessionId).toBe("native");
  });

  it("names the engine that stopped", async () => {
    const result = await run(engineReturning({ sessionId: "", result: "", error: "Interrupted" }, "codex"));
    expect(result.error).toBe("codex stopped unexpectedly: no reason reported");
  });

  it("stays a timeout — and so stays eligible for another engine — when it was the engine's own turn deadline", async () => {
    const result = await run(engineReturning({ sessionId: "native", result: "", error: "Interrupted: interactive turn timed out" }));

    expect(result.error).toBe("claude stopped unexpectedly: interactive turn timed out");
    expect(engineFallbackFailure(result)).toBe("timeout");
    expect(result.retryable).toBeUndefined();
  });
});

describe("an engine run the gateway asked to stop", () => {
  it.each([
    "Interrupted: new message received",
    "Interrupted by user",
    "Interrupted: engine switched",
    "Interrupted: gateway shutting down",
  ])("is still the interruption it was: %s", async (error) => {
    const stopped: EngineResult = { sessionId: "native", result: "", error, interruptRequested: true };

    expect(await run(engineReturning(stopped))).toMatchObject({ error, interruptRequested: true });
  });
});

describe("results that are not interruptions", () => {
  it.each([
    [{ sessionId: "native", result: "done" }],
    [{ sessionId: "native", result: "", error: "Usage limit reached" }],
    [{ sessionId: "native", result: "", error: "Not logged in · Please run /login" }],
  ] as Array<[EngineResult]>)("are passed through untouched", async (result) => {
    expect(await run(engineReturning(result))).toMatchObject(result);
  });
});

describe("while the gateway is shutting down", () => {
  // Under a process supervisor that signals the whole control group, Claude's
  // PTY gets the SIGTERM itself and can be gone before the gateway reaches its
  // own kill. Nobody called kill(), but it is the shutdown that stopped it.
  it("an engine that stops was stopped by the shutdown — not a failure, and marked for the restart nudge", async () => {
    const session = createSession({ engine: "claude", source: "slack", sourceRef: "slack:C1:1.1", connector: "slack", sessionKey: "slack:C1:1.1", replyContext: { channel: "C1", thread: "1.1" } });
    updateSession(session.id, { status: "running" });
    beginGatewayShutdown();

    const result = await run(engineReturning({ sessionId: "native", result: "", error: "Interrupted: claude process exited" }), session.id);

    expect(result.error).toBe("Interrupted: claude process exited");
    // Even if the shutdown's own marking never sees this session running again.
    expect(readRestartResumeState(getSession(session.id)!.transportMeta).interruptedAt).toEqual(expect.any(String));
  });

  it("the next process starts clean", async () => {
    beginGatewayShutdown();
    prepareRestartResume();

    const result = await run(engineReturning({ sessionId: "native", result: "", error: "Interrupted: claude process exited" }));

    expect(result.error).toBe("claude stopped unexpectedly: claude process exited");
  });
});
