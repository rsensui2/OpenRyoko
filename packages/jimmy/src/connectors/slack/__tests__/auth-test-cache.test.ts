import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberAuthTest } from "../auth-test-cache.js";

interface Identity { user_id: string; bot_id: string }

function fixture() {
  const request = vi.fn<(args?: { token?: string }) => Promise<Identity>>()
    .mockResolvedValue({ user_id: "U1", bot_id: "B1" });
  const auth = { test: request as (args?: { token?: string }) => Promise<Identity> };
  rememberAuthTest(auth);
  return { auth, request };
}

describe("rememberAuthTest", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("does not call auth.test until somebody asks", () => {
    const { request } = fixture();

    expect(request).not.toHaveBeenCalled();
  });

  it("asks Slack once and answers every later caller from memory", async () => {
    const { auth, request } = fixture();

    const first = await auth.test({ token: "xoxb-test-token" });
    const second = await auth.test({ token: "xoxb-test-token" });
    const third = await auth.test();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ token: "xoxb-test-token" });
    expect([first, second, third]).toEqual(Array(3).fill({ user_id: "U1", bot_id: "B1" }));
  });

  it("shares one request between callers that arrive while it is in flight", async () => {
    const { auth, request } = fixture();
    let release!: (identity: Identity) => void;
    request.mockReturnValueOnce(new Promise<Identity>((resolve) => { release = resolve; }));

    const waiting = [auth.test(), auth.test(), auth.test()];
    release({ user_id: "U1", bot_id: "B1" });

    await expect(Promise.all(waiting)).resolves.toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure: the next caller asks again", async () => {
    const { auth, request } = fixture();
    request.mockRejectedValueOnce(new Error("request timed out")).mockRejectedValueOnce(new Error("request timed out"));

    await expect(auth.test()).rejects.toThrow("request timed out");
    await expect(auth.test()).rejects.toThrow("request timed out");

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("recovers once Slack answers again, and then stops asking", async () => {
    const { auth, request } = fixture();
    request.mockRejectedValueOnce(new Error("request timed out"));

    await expect(auth.test()).rejects.toThrow("request timed out");
    await expect(auth.test()).resolves.toEqual({ user_id: "U1", bot_id: "B1" });
    await auth.test();
    await auth.test();

    // One failed attempt, one that succeeded, nothing after it.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("hands a failure to every caller waiting on it and leaves nothing unhandled", async () => {
    const { auth, request } = fixture();
    let fail!: (reason: Error) => void;
    request.mockReturnValueOnce(new Promise<Identity>((_resolve, reject) => { fail = reject; }));

    const waiting = [auth.test(), auth.test()];
    fail(new Error("invalid_auth"));

    const settled = await Promise.allSettled(waiting);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });
});
