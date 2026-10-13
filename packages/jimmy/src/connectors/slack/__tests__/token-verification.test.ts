import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bolt 4.x verifies the bot token inside the App constructor by default: it
// fires `auth.test` and keeps the promise without awaiting or catching it. A
// revoked token or an unreachable Slack API then surfaces as an unhandled
// rejection, which Node 22 answers by terminating the gateway.
//
// The real Bolt App is used on purpose (wrapped only to capture its options),
// so this pins the behavior and not just the option name. Nothing here reaches
// Slack: every Web API method funnels through WebClient#apiCall, stubbed below.

const { appOptions } = vi.hoisted(() => ({ appOptions: vi.fn() }));

vi.mock("@slack/bolt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/bolt")>();
  return {
    ...actual,
    App: class extends actual.App {
      constructor(options: ConstructorParameters<typeof actual.App>[0]) {
        appOptions(options);
        super(options);
      }
    },
  };
});

const { webApi } = await import("@slack/bolt");
const { SlackConnector } = await import("../index.js");

const CONFIG = { botToken: "xoxb-test-token", appToken: "xapp-test-token" };

describe("SlackConnector construction — Bolt token verification", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  let apiCall: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    unhandled.length = 0;
    appOptions.mockClear();
    apiCall = vi.spyOn(webApi.WebClient.prototype, "apiCall").mockRejectedValue(new Error("invalid_auth"));
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.restoreAllMocks();
  });

  it("tells Bolt not to verify the token inside the constructor", () => {
    new SlackConnector(CONFIG);

    expect(appOptions).toHaveBeenCalledTimes(1);
    expect(appOptions.mock.calls[0][0]).toMatchObject({
      token: CONFIG.botToken,
      appToken: CONFIG.appToken,
      socketMode: true,
      tokenVerificationEnabled: false,
    });
  });

  it("leaves no un-awaited Slack call behind when the token is rejected", async () => {
    new SlackConnector(CONFIG);
    // An unhandled rejection is reported once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(apiCall).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

// Bolt runs its authorize function before every incoming event. With the
// constructor-time check off, Bolt 4.7 answers each of those with a fresh
// auth.test: the ack waits for it, and when it fails no listener is called and
// socket mode acks the event away — the message is lost without a trace.
describe("SlackConnector — auth.test for incoming events", () => {
  const identity = { ok: true, user_id: "U-BOT", bot_id: "B-BOT" };
  let apiCall: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiCall = vi.spyOn(webApi.WebClient.prototype, "apiCall").mockResolvedValue(identity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** What Bolt does before it dispatches one event. */
  const authorizeEvent = (connector: InstanceType<typeof SlackConnector>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connector as any).app.authorize({ isEnterpriseInstall: false }, {}) as Promise<Record<string, unknown>>;
  const authTestCalls = () =>
    (apiCall.mock.calls as Array<[string, { token?: string }?]>).filter(([method]) => method === "auth.test");

  it("asks Slack once, however many events arrive", async () => {
    const connector = new SlackConnector(CONFIG);
    expect(authTestCalls()).toHaveLength(0);

    for (let event = 0; event < 5; event++) {
      await expect(authorizeEvent(connector)).resolves.toMatchObject({ botUserId: "U-BOT", botId: "B-BOT" });
    }

    expect(authTestCalls()).toHaveLength(1);
  });

  it("keeps trying while Slack is failing, and stops once it has an answer", async () => {
    const connector = new SlackConnector(CONFIG);
    apiCall
      .mockRejectedValueOnce(new Error("request timed out"))
      .mockRejectedValueOnce(new Error("request timed out"));

    await expect(authorizeEvent(connector)).rejects.toThrow("request timed out");
    await expect(authorizeEvent(connector)).rejects.toThrow("request timed out");
    await expect(authorizeEvent(connector)).resolves.toMatchObject({ botUserId: "U-BOT" });
    await authorizeEvent(connector);
    await authorizeEvent(connector);

    // Two failed attempts, the one that succeeded, and nothing after it.
    expect(authTestCalls()).toHaveLength(3);
  });

  it("reuses the answer the connector fetched for itself while starting", async () => {
    const connector = new SlackConnector(CONFIG);

    // start() resolves the bot user ID through the same client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((connector as any).app.client.auth.test()).resolves.toMatchObject({ user_id: "U-BOT" });
    await authorizeEvent(connector);
    await authorizeEvent(connector);

    expect(authTestCalls()).toHaveLength(1);
  });

  it("keeps each connector's answer to itself", async () => {
    const first = new SlackConnector(CONFIG);
    const second = new SlackConnector({ botToken: "xoxb-other-token", appToken: "xapp-other-token" });

    await authorizeEvent(first);
    await authorizeEvent(second);
    await authorizeEvent(first);
    await authorizeEvent(second);

    expect(authTestCalls().map(([, args]) => args?.token)).toEqual([CONFIG.botToken, "xoxb-other-token"]);
  });
});
