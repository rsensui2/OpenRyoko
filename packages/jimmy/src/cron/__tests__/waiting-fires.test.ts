import { describe, expect, it } from "vitest";
import { createSession, updateSession } from "../../sessions/registry.js";
import type { Session } from "../../shared/types.js";
import { fireWaitingOnUsageLimit, trackFire } from "../waiting-fires.js";

let sequence = 0;
const jobId = () => `waiting-fires-${++sequence}`;

/** A fire's session, as the session manager would have left it. */
function sessionFor(job: string, status?: Session["status"], lastError?: string) {
  const sessionKey = `cron:${job}:${++sequence}`;
  const session = createSession({ engine: "claude", source: "cron", sourceRef: sessionKey, connector: "cron", sessionKey, prompt: "Write the briefing" });
  if (status) updateSession(session.id, { status, lastError: lastError ?? null });
  return { sessionKey, id: session.id };
}

describe("fireWaitingOnUsageLimit", () => {
  it("reports a fire in flight whose session is waiting, with the reset that wait expects", () => {
    const job = jobId();
    const waiting = sessionFor(job, "waiting", "claude usage limit — resumes 2026-10-12T09:00:00.000Z");
    trackFire(job, waiting.sessionKey);

    expect(fireWaitingOnUsageLimit(job)).toEqual({ waitingSessionId: waiting.id, resetsAt: "2026-10-12T09:00:00.000Z" });
  });

  it("reports no reset when the wait does not know one", () => {
    const job = jobId();
    const waiting = sessionFor(job, "waiting", "claude usage limit — waiting for reset");
    trackFire(job, waiting.sessionKey);

    expect(fireWaitingOnUsageLimit(job)).toEqual({ waitingSessionId: waiting.id });
  });

  it("does not report a fire that is running, or one whose session does not exist yet", () => {
    const job = jobId();
    trackFire(job, sessionFor(job, "running").sessionKey);
    trackFire(job, `cron:${job}:not-created-yet`);

    expect(fireWaitingOnUsageLimit(job)).toBeNull();
  });

  it("does not report a fire once it has come back, though its session still says it is waiting", () => {
    const job = jobId();
    const fireSettled = trackFire(job, sessionFor(job, "waiting").sessionKey);

    fireSettled();

    expect(fireWaitingOnUsageLimit(job)).toBeNull();
  });

  // What a gateway that went down mid-wait leaves behind: nothing will resume it.
  it("does not report a waiting session that no fire of this process started", () => {
    const job = jobId();
    sessionFor(job, "waiting", "claude usage limit — resumes 2026-10-12T09:00:00.000Z");

    expect(fireWaitingOnUsageLimit(job)).toBeNull();
  });

  it("looks only at the job it is asked about, and keeps a job's other fires when one comes back", () => {
    const [job, other] = [jobId(), jobId()];
    const waiting = sessionFor(job, "waiting");
    trackFire(job, waiting.sessionKey);
    const runningSettled = trackFire(job, sessionFor(job, "running").sessionKey);

    runningSettled();

    expect(fireWaitingOnUsageLimit(other)).toBeNull();
    expect(fireWaitingOnUsageLimit(job)).toEqual({ waitingSessionId: waiting.id });
  });
});
