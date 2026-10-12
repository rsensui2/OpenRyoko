import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_LOGIN_OUTPUT, OAUTH_CODE, OAUTH_STATE, makeHarness, settle } from "../../../provider-auth/__tests__/support.js";

type Listener = (args: any) => Promise<void>;

const world = vi.hoisted(() => ({
  apps: [] as any[],
  core: undefined as any,
  serviceRequests: 0,
  log: [] as string[],
}));

vi.mock("@slack/bolt", () => ({
  App: class {
    client = {
      auth: { test: vi.fn(async () => ({ user_id: "UBOT" })) },
      chat: {
        postMessage: vi.fn(async () => ({ ts: "900.000" })), update: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})), postEphemeral: vi.fn(async () => ({})),
      },
      views: { open: vi.fn(async () => ({})) },
      users: { info: vi.fn(async () => ({ user: { name: "operator" } })) },
      conversations: { info: vi.fn(async () => ({ channel: { name: "dm" } })), replies: vi.fn(async () => ({ messages: [] })) },
      reactions: { add: vi.fn(async () => ({})) },
    };
    actions: Array<[RegExp, Listener]> = [];
    views: Array<[string, Listener]> = [];
    onMessage?: Listener;
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    constructor() { world.apps.push(this); }
    action(pattern: RegExp, listener: Listener) { this.actions.push([pattern, listener]); }
    view(callbackId: string, listener: Listener) { this.views.push([callbackId, listener]); }
    message(listener: Listener) { this.onMessage = listener; }
    event() {}
  },
}));

// No test may reach a real login CLI: the PTY module is a stub, and the shared
// flow engine is replaced by one whose PTY, status command and clock are fakes.
vi.mock("node-pty", () => ({ spawn: vi.fn(() => { throw new Error("a test tried to spawn a real PTY"); }) }));
vi.mock("../../../provider-auth/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../provider-auth/index.js")>(),
  getProviderAuthService: () => { world.serviceRequests += 1; return world.core.service; },
}));
vi.mock("../../../shared/logger.js", () => {
  const record = (message: string) => { world.log.push(message); };
  return { logger: { info: record, warn: record, error: record, debug: record } };
});

const { SlackConnector } = await import("../index.js");

const OPERATOR = "UOPERATOR";
const DM = "D0OPERATOR";

async function connect(config: Record<string, unknown> = {}, operator: string | undefined = OPERATOR) {
  const connector = new SlackConnector(
    { appToken: "xapp-test", botToken: "xoxb-test", ...config } as never,
    { getOperatorSlackId: () => operator },
  );
  const routed = vi.fn();
  connector.onMessage(routed);
  await connector.start();
  const app = world.apps.at(-1);
  let sequence = 0;
  const receive = async (text: string, extra: Record<string, unknown> = {}) => {
    sequence += 1;
    await app.onMessage({ event: {
      user: OPERATOR, channel: DM, channel_type: "im", ts: `${Math.floor(Date.now() / 1000) + 60}.${String(sequence).padStart(6, "0")}`, text, ...extra,
    } });
    await settle();
  };
  const authAction = app.actions.find(([pattern]: [RegExp, Listener]) => pattern.test("ryoko_auth_start_claude"))?.[1] as Listener | undefined;
  const click = async (actionId: string, value?: string) => {
    await authAction!({
      ack: vi.fn(async () => {}), action: { action_id: actionId, value },
      body: { user: { id: OPERATOR }, channel: { id: DM }, trigger_id: "t1", message: { ts: "900.000" } },
    });
    await settle();
  };
  return { connector, app, routed, receive, click, authAction };
}

describe("Slack connector — providerAuth wiring", () => {
  beforeEach(() => {
    world.apps.length = 0;
    world.log.length = 0;
    world.serviceRequests = 0;
    world.core = makeHarness();
  });

  it.each([
    ["absent", {}],
    ["disabled", { providerAuth: { enabled: false } }],
    ["not a boolean true", { providerAuth: { enabled: "yes" } }],
  ])("changes nothing when providerAuth is %s", async (_name, config) => {
    const { app, routed, receive } = await connect(config);

    expect(world.serviceRequests).toBe(0);
    expect(app.actions.some(([pattern]: [RegExp, Listener]) => pattern.test("ryoko_auth_start_claude"))).toBe(false);
    expect(app.views).toEqual([]);

    await receive("ログイン");
    expect(routed).toHaveBeenCalledTimes(1);
    expect(routed.mock.calls[0][0].text).toBe("ログイン");
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();

    world.core.service.reportAuthFailure("claude");
    await settle();
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
    expect(world.core.spawnPty).not.toHaveBeenCalled();
  });

  it("handles the operator's login command itself and leaves every other message to the session", async () => {
    const { app, routed, receive } = await connect({ providerAuth: { enabled: true } });

    expect(app.actions.some(([pattern]: [RegExp, Listener]) => pattern.test("ryoko_auth_start_claude"))).toBe(true);
    expect(app.views.map(([callbackId]: [string, Listener]) => callbackId)).toEqual(["ryoko_auth_code"]);
    expect(world.log.join("\n")).toContain("[slack] provider-auth: enabled");

    await receive("ログイン");
    expect(routed).not.toHaveBeenCalled();
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(app.client.chat.postMessage.mock.calls[0][0]).toMatchObject({ channel: DM, text: "Claude / Codex のログイン" });
    expect(app.client.reactions.add).not.toHaveBeenCalled();

    await receive("こんにちは");
    await receive("ログイン", { user: "UOTHER" });
    expect(routed.mock.calls.map(([message]) => [message.userId, message.text])).toEqual([[OPERATOR, "こんにちは"], ["UOTHER", "ログイン"]]);
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a pasted code out of the connector's message log and out of the session", async () => {
    const { app, routed, receive } = await connect({ providerAuth: { enabled: true } });

    await receive(`${OAUTH_CODE}#${OAUTH_STATE}`);

    expect(routed).not.toHaveBeenCalled();
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(world.log.join("\n")).not.toContain(OAUTH_CODE.slice(0, 20));
    expect(world.log.join("\n")).not.toContain("Received message event");
  });

  it("routes an ordinary request that merely mentions a callback URL or an anchor", async () => {
    const { app, routed, receive } = await connect({ providerAuth: { enabled: true } });
    const requests = [
      "この <http://localhost:3000/callback?code=abc&amp;state=xyz> が 500 になる。調べて",
      "docs の installation-and-setup-guide#troubleshooting を直して",
    ];

    for (const text of requests) await receive(text);

    expect(routed.mock.calls.map(([message]) => message.text)).toEqual(requests);
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["with a file attached", { subtype: "file_share", files: [] as unknown[] }, (code: string) => code],
    ["also sent to the DM from a thread", { subtype: "thread_broadcast" }, (code: string) => code],
    ["in backticks", {}, (code: string) => `\`${code}\``],
    ["inside a sentence", {}, (code: string) => `コードは${code}です`],
  ])("during a login, keeps a code pasted %s out of the message log and the session", async (_name, extra, wrap) => {
    const { app, routed, receive, click } = await connect({ providerAuth: { enabled: true } });
    await click("ryoko_auth_start_claude");
    world.core.ptys[0].emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    world.log.length = 0;
    app.client.chat.postMessage.mockClear();

    await receive(wrap(`${OAUTH_CODE}#${OAUTH_STATE}`), extra);

    expect(routed).not.toHaveBeenCalled();
    expect(world.log.join("\n")).not.toContain(OAUTH_CODE.slice(0, 20));
    expect(world.log.join("\n")).not.toContain("Received message event");
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(world.core.ptys[0].write).not.toHaveBeenCalled();
  });

  it("applies allowFrom before the operator's command", async () => {
    const { app, routed, receive } = await connect({ providerAuth: { enabled: true }, allowFrom: ["USOMEONE"] });

    await receive("ログイン");

    expect(routed).not.toHaveBeenCalled();
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("starts nothing for a connector that cannot tell who the operator is", async () => {
    const connector = new SlackConnector({ appToken: "xapp-test", botToken: "xoxb-test", providerAuth: { enabled: true } } as never, {});
    await connector.start();

    expect(world.serviceRequests).toBe(0);
    expect(world.apps.at(-1).views).toEqual([]);
    expect(world.log.join("\n")).toContain("providerAuth");
  });

  it("warns at startup when the operator's Slack ID is missing, and stays inert", async () => {
    const { app, routed, receive } = await connect({ providerAuth: { enabled: true } }, "");

    expect(world.log.join("\n")).toContain("portal.operatorSlackId");
    await receive("ログイン");
    expect(routed).toHaveBeenCalledTimes(1);
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("stops a login in progress when the connector stops", async () => {
    const { connector, app, click } = await connect({ providerAuth: { enabled: true } });
    await click("ryoko_auth_start_claude");
    const pty = world.core.ptys[0];
    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();

    await connector.stop();

    expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    expect(world.core.service.activeFlow("claude")).toBeUndefined();
    expect(app.client.chat.update.mock.calls.at(-1)[0].text).toContain("中断");
    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("DMs the operator when a turn fails on a lost login", async () => {
    const { app } = await connect({ providerAuth: { enabled: true } });

    world.core.service.reportAuthFailure("claude");
    world.core.service.reportAuthFailure("claude");
    await settle();

    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(app.client.chat.postMessage.mock.calls[0][0].channel).toBe(OPERATOR);
  });
});
