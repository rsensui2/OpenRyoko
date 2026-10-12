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
