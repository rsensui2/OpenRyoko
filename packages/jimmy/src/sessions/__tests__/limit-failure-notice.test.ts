import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetUsageLimitAnnouncements, claimUsageLimitAnnouncement, usageLimitAnnounced } from "../engine-health-gate.js";
import { deliverUnlessAlreadyTold, limitFailureOf, noteLimitFailure } from "../limit-failure-notice.js";
import type { TurnDelivery } from "../turn-delivery.js";
import type { EngineResult, Session } from "../../shared/types.js";

const RESET = "2026-10-17T03:00:00.000Z";
const NEXT_RESET = "2026-10-24T03:00:00.000Z";

let sequence = 0;
const session = (source: string, transportMeta: Record<string, unknown> = {}): Session =>
  ({ id: `session-${++sequence}`, source, engine: "claude", transportMeta }) as unknown as Session;
const cronFire = (channel = "C-briefing", jobId = "morning-briefing") =>
  session("cron", { cronJobId: jobId, deliveryConnector: "slack", deliveryChannel: channel });

/** The answer of a turn that met a limit it will not wait for. A new object every time, as each turn's is. */
const limitFailure = (resetsAt = RESET): EngineResult =>
  noteLimitFailure({ sessionId: "s", result: "", error: `claude usage limit reached. It resets (${resetsAt})`, retryable: false }, { engine: "claude", resetsAt });

const delivered: TurnDelivery = { deliveredReply: true };
const deliver = vi.fn(async (): Promise<TurnDelivery> => delivered);

beforeEach(() => {
  vi.clearAllMocks();
  _resetUsageLimitAnnouncements();
});

describe("deliverUnlessAlreadyTold", () => {
  it("posts a cron job's limit failure once per limit period, and holds the repeats back without calling them undelivered", async () => {
    expect(await deliverUnlessAlreadyTold(cronFire(), limitFailure(), deliver)).toBe(delivered);
    expect(await deliverUnlessAlreadyTold(cronFire(), limitFailure(), deliver)).toEqual({ deliveredReply: false });
    expect(await deliverUnlessAlreadyTold(cronFire(), limitFailure(), deliver)).toEqual({ deliveredReply: false });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("posts again when a new limit period begins", async () => {
    await deliverUnlessAlreadyTold(cronFire(), limitFailure(RESET), deliver);
    await deliverUnlessAlreadyTold(cronFire(), limitFailure(NEXT_RESET), deliver);
    await deliverUnlessAlreadyTold(cronFire(), limitFailure(NEXT_RESET), deliver);

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("counts by delivery channel: each is told once, whichever job is the one to tell it", async () => {
    await deliverUnlessAlreadyTold(cronFire("C-briefing", "morning-briefing"), limitFailure(), deliver);
    await deliverUnlessAlreadyTold(cronFire("C-briefing", "evening-digest"), limitFailure(), deliver);
    await deliverUnlessAlreadyTold(cronFire("C-sales", "sales-report"), limitFailure(), deliver);

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("counts by job when the job delivers nowhere in particular", async () => {
    const fire = (jobId: string) => session("cron", { cronJobId: jobId, deliveryConnector: null, deliveryChannel: null });
    await deliverUnlessAlreadyTold(fire("a"), limitFailure(), deliver);
    await deliverUnlessAlreadyTold(fire("a"), limitFailure(), deliver);
    await deliverUnlessAlreadyTold(fire("b"), limitFailure(), deliver);

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("leaves a post the channel refused for the next fire to try", async () => {
    deliver.mockResolvedValueOnce({ deliveredReply: false, failure: "channel_not_found" });

    expect(await deliverUnlessAlreadyTold(cronFire(), limitFailure(), deliver)).toEqual({ deliveredReply: false, failure: "channel_not_found" });
    expect(await deliverUnlessAlreadyTold(cronFire(), limitFailure(), deliver)).toBe(delivered);
    expect(await deliverUnlessAlreadyTold(cronFire(), limitFailure(), deliver)).toEqual({ deliveredReply: false });
  });

  it("tells a conversation every time", async () => {
    const conversation = session("slack", { channelExternal: false });
    for (let i = 0; i < 3; i++) await deliverUnlessAlreadyTold(conversation, limitFailure(), deliver);

    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("holds nothing else back: any other answer of a cron fire, and a cron session that is not a job's fire", async () => {
    const failed: EngineResult = { sessionId: "s", result: "", error: "Not logged in · Please run /login" };
    for (let i = 0; i < 2; i++) await deliverUnlessAlreadyTold(cronFire(), failed, deliver);
    for (let i = 0; i < 2; i++) await deliverUnlessAlreadyTold(cronFire(), { sessionId: "s", result: "Briefing is ready." }, deliver);
    const maintenance = session("cron", { maintenanceJobId: "update", maintenanceMode: "review" });
    for (let i = 0; i < 2; i++) await deliverUnlessAlreadyTold(maintenance, limitFailure(), deliver);

    expect(deliver).toHaveBeenCalledTimes(6);
  });
});

describe("what has been announced about a limit period", () => {
  it("is kept apart for each audience, and apart from what everyone was told", () => {
    expect(claimUsageLimitAnnouncement("claude", RESET, "cron-delivery:slack:C-briefing")).toBe(true);
    expect(claimUsageLimitAnnouncement("claude", RESET, "cron-delivery:slack:C-briefing")).toBe(false);
    expect(claimUsageLimitAnnouncement("claude", RESET, "cron-delivery:slack:C-sales")).toBe(true);
    // The notice that sessions are switching away from the engine is everyone's, and claimed on its own.
    expect(claimUsageLimitAnnouncement("claude", RESET)).toBe(true);
    expect(claimUsageLimitAnnouncement("claude", RESET)).toBe(false);
  });

  it("can be asked about without claiming it", () => {
    expect(usageLimitAnnounced("claude", RESET, "cron-delivery:slack:C-briefing")).toBe(false);
    expect(usageLimitAnnounced("claude", RESET, "cron-delivery:slack:C-briefing")).toBe(false);
    claimUsageLimitAnnouncement("claude", RESET, "cron-delivery:slack:C-briefing");

    expect(usageLimitAnnounced("claude", RESET, "cron-delivery:slack:C-briefing")).toBe(true);
    expect(usageLimitAnnounced("claude", NEXT_RESET, "cron-delivery:slack:C-briefing")).toBe(false);
    expect(usageLimitAnnounced("codex", RESET, "cron-delivery:slack:C-briefing")).toBe(false);
  });
});

// Whoever reports a failed turn onward — the cron runner, for its alert — asks
// here whether it was a usage limit, and which, instead of reading the wording.
describe("limitFailureOf", () => {
  const period = { engine: "claude", resetsAt: RESET };
  const failedOn = (sessionId: string, resetsAt = RESET): EngineResult =>
    noteLimitFailure({ sessionId: "s", result: "", error: `claude usage limit reached. It resets (${resetsAt})`, retryable: false }, { engine: "claude", resetsAt }, sessionId);

  it("names the limit period a session's turn failed on, while that failure is what the session records", () => {
    const failed = failedOn("limit-session-1");

    expect(limitFailureOf({ id: "limit-session-1", lastError: failed.error! })).toEqual(period);
  });

  it("names none once the session records something else: a later turn, or a reply that was not delivered", () => {
    failedOn("limit-session-2");

    expect(limitFailureOf({ id: "limit-session-2", lastError: null })).toBeUndefined();
    expect(limitFailureOf({ id: "limit-session-2", lastError: "Reply was not delivered: channel_not_found" })).toBeUndefined();
  });

  it("names none for a session that did not fail on such a limit, or for no session at all", () => {
    expect(limitFailureOf({ id: "limit-session-3", lastError: "claude usage limit reached. It resets (elsewhere)" })).toBeUndefined();
    expect(limitFailureOf(undefined)).toBeUndefined();
  });

  it("names the latest period for a session that has failed on a limit more than once", () => {
    failedOn("limit-session-4", RESET);
    const again = failedOn("limit-session-4", NEXT_RESET);

    expect(limitFailureOf({ id: "limit-session-4", lastError: again.error! })).toEqual({ engine: "claude", resetsAt: NEXT_RESET });
  });

  it("remembers a bounded number of sessions, the most recent ones", () => {
    const first = failedOn("limit-session-first");
    let last = first;
    for (let index = 0; index < 400; index++) last = failedOn(`limit-session-filler-${index}`);

    expect(limitFailureOf({ id: "limit-session-first", lastError: first.error! })).toBeUndefined();
    expect(limitFailureOf({ id: "limit-session-filler-399", lastError: last.error! })).toEqual(period);
  });
});
