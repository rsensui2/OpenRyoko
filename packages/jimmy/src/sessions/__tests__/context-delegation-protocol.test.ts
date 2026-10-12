import { describe, it, expect, vi } from "vitest";
import { notifyParentSession } from "../callbacks.js";
import { COMPLETION_BATCH_MAX_ITEMS } from "../completion-batching.js";
import { buildContext } from "../context.js";
import { createSession, getMessages, getSession, updateSession } from "../registry.js";

// Sibling of context-process-lifetime.test.ts (issue #38): the same failure shape, one level
// up. The delegation protocol used to promise unconditionally that the onComplete callback
// "will message you automatically" — and until PR #67 that callback was rejected with 401 and
// dropped without a trace, so orchestrators ended their turn and were never woken.
//
// The fix is NOT to make the orchestrator poll inside its turn (a turn has a hard time limit,
// and a blocked turn cannot answer anyone). The notification stays the primary wake-up; the
// protocol must be honest that delivery is attempted rather than guaranteed, name the
// conditions under which it is skipped, and give the orchestrator a safety net.
describe("buildContext — employee delegation protocol", () => {
  const baseOpts = {
    source: "slack",
    channel: "C123",
    user: "U123",
  };

  const stubConfig = {
    jinn: { version: "0.0.0" },
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "" },
      codex: { bin: "codex", model: "" },
    },
    connectors: {},
    logging: { level: "info", stdout: false, file: "" },
  };

  // The delegation protocol is COO-only: it is omitted when `employee` is set.
  function cooContext(): string {
    return buildContext({ ...baseOpts, config: stubConfig as never });
  }

  it("includes the delegation protocol for a COO session", () => {
    expect(cooContext()).toContain("## Employee Delegation Protocol");
  });

  it("omits the delegation protocol for an employee session", () => {
    const ctx = buildContext({ ...baseOpts, employee: "some-employee" as never, config: stubConfig as never });
    expect(ctx).not.toContain("## Employee Delegation Protocol");
  });

  it("tells the orchestrator to reply immediately and end the turn, not to poll inside it", () => {
    const ctx = cooContext();
    expect(ctx).toContain("**Respond immediately**");
    expect(ctx).toContain("Do NOT poll or sleep-loop inside your turn");
    expect(ctx).toContain("**Never poll or sleep-loop inside your turn**");
  });

  it("keeps the onComplete notification as the primary wake-up", () => {
    const ctx = cooContext();
    expect(ctx).toContain("**onComplete notification** (the primary wake-up");
    expect(ctx).toContain("let the notification wake you");
  });

  it("never promises unconditional delivery", () => {
    const ctx = cooContext();
    expect(ctx).toContain("attempted, not guaranteed");
    expect(ctx).toContain("**The notification is not a guarantee**");
    // The old wording was an unconditional promise, and agents followed it.
    expect(ctx).not.toContain("will message you automatically");
    expect(ctx).not.toMatch(/no polling needed/i);
    expect(ctx).not.toContain("NEVER poll or wait for child sessions");
  });

  it("names the two conditions under which the notification is skipped", () => {
    const ctx = cooContext();
    expect(ctx).toContain("skipped silently when either of these holds");
    expect(ctx).toContain("spawned without your `parentSessionId`");
    expect(ctx).toContain("the employee sets `alwaysNotify: false`");
  });

  // A parent in error used to be the third "skipped silently" case, and the protocol said
  // so. The completion is now written into the parent's transcript instead. An orchestrator
  // still told it is dropped never looks for it there.
  it("says a completion that finds the parent in error is kept in its transcript, in the words the record carries", async () => {
    const ctx = cooContext();
    expect(ctx).not.toContain("your session is already in `error`");
    expect(ctx).toContain("If your session is in `error` when a child finishes");
    expect(ctx).toContain("you are not woken: the notification is written into your transcript, marked \"Not acted on\"");
    expect(ctx).toContain("ryoko api GET /api/sessions/<your-session-id>?last=20");

    const key = `web:delegation-protocol-${Date.now()}`;
    const parent = createSession({ engine: "claude", source: "web", sourceRef: key, connector: "web", sessionKey: key, prompt: "Delegate this" });
    updateSession(parent.id, { status: "error", lastError: "Usage limit reached" });
    const child = createSession({ engine: "claude", source: "web", sourceRef: `${key}:child`, connector: "web", sessionKey: `${key}:child`, prompt: "Do the work", parentSessionId: parent.id, employee: "writer" });

    notifyParentSession(child, { result: "Done." });

    await vi.waitFor(() => expect(getMessages(parent.id).at(-1)?.content).toContain("Not acted on"));
    expect(getMessages(parent.id).at(-1)).toMatchObject({ role: "notification" });
    expect(getSession(parent.id)?.status).toBe("error"); // recorded, and no turn started
  });

  it("says a parent whose engine process died is woken all the same", () => {
    expect(cooContext()).toMatch(/failed because the engine process died does not count: you are woken as usual/);
  });

  it("says completions that pile up behind a busy parent arrive as one turn, with the limit the gateway uses", () => {
    expect(cooContext()).toContain(`reach you together as one turn (up to ${COMPLETION_BATCH_MAX_ITEMS} at a time)`);
  });

  it("says a failed POST only reaches the gateway log", () => {
    expect(cooContext()).toContain("a warning goes to the gateway log — not to you");
  });

  it("requires parentSessionId on spawn so a notification is at least attempted", () => {
    const ctx = cooContext();
    expect(ctx).toContain("**Always pass `parentSessionId`**");
    expect(ctx).toContain("no notification is even attempted");
  });

  it("gives a safety net: read the child directly, or arm a job-runner watchdog", () => {
    const ctx = cooContext();
    expect(ctx).toContain("ryoko api GET /api/sessions/<child-id>?last=5");
    expect(ctx).toContain("ryoko job run --name watchdog-<employee> --session <your-session-id> -- 'sleep 1800'");
    expect(ctx).toContain("The job runner guarantees a wake-up on exit (success or failure)");
  });
});
