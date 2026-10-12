import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_LOGIN_OUTPUT, CLAUDE_URL, CODEX_DEVICE_CODE, CODEX_LOGIN_OUTPUT, CODEX_URL, OAUTH_CODE, OAUTH_STATE,
  makeHarness, settle,
} from "../../../provider-auth/__tests__/support.js";
import { FLOW_TTL_MS } from "../../../provider-auth/service.js";
import { SlackProviderAuth } from "../provider-auth.js";

const OPERATOR = "UOPERATOR";
const DM = "D0OPERATOR";

type Args = Record<string, any>;

function fixture(options: {
  operator?: string | undefined; readOperator?: () => string | undefined; allowed?: (user: string) => boolean; stale?: boolean;
} = {}) {
  const core = makeHarness();
  let sequence = 100;
  const postMessage = vi.fn(async (args: Args) => ({ ts: `${++sequence}.000`, channel: String(args.channel).startsWith("U") ? DM : args.channel }));
  const update = vi.fn(async (_args: Args) => ({}));
  const remove = vi.fn(async (_args: Args) => ({}));
  const open = vi.fn(async (_args: Args) => ({}));
  const listeners: { action?: (args: Args) => Promise<void>; view?: (args: Args) => Promise<void>; actionPattern?: RegExp; viewId?: string } = {};
  const app = {
    client: { chat: { postMessage, update, delete: remove }, views: { open } },
    action: (pattern: RegExp, listener: (args: Args) => Promise<void>) => { listeners.actionPattern = pattern; listeners.action = listener; },
    view: (callbackId: string, listener: (args: Args) => Promise<void>) => { listeners.viewId = callbackId; listeners.view = listener; },
  };
  const logged: string[] = [];
  const record = (message: string) => { logged.push(message); };
  const operator = "operator" in options ? options.operator : OPERATOR;
  const auth = new SlackProviderAuth({
    client: app.client,
    service: core.service,
    getOperatorSlackId: options.readOperator ?? (() => operator),
    isAllowedUser: options.allowed ?? (() => true),
    isStaleEvent: () => options.stale === true,
    logger: { info: record, warn: record, error: record },
  });
  auth.register(app);

  const message = (text: string, extra: Args = {}) =>
    auth.handleMessage({ user: OPERATOR, channel: DM, channel_type: "im", ts: "50.000", text, ...extra });
  const ack = vi.fn(async (_response?: Args) => {});
  const click = async (actionId: string, extra: { user?: string; channel?: string; value?: string; threadTs?: string } = {}) => {
    await listeners.action!({
      ack,
      action: { action_id: actionId, value: extra.value },
      body: {
        user: { id: extra.user ?? OPERATOR },
        channel: { id: extra.channel ?? DM },
        trigger_id: "trigger-1",
        message: { ts: "100.000", ...(extra.threadTs ? { thread_ts: extra.threadTs } : {}) },
      },
    });
    await settle();
  };
  const submit = async (value: string, metadata: string, user = OPERATOR) => {
    const viewAck = vi.fn(async (_response?: Args) => {});
    await listeners.view!({
      ack: viewAck,
      body: { user: { id: user } },
      view: { private_metadata: metadata, state: { values: { ryoko_auth_code_block: { ryoko_auth_code_value: { value } } } } },
    });
    await settle();
    return viewAck;
  };
  /** Every word Slack was asked to show, anywhere, so far. */
  const shown = () => JSON.stringify([...postMessage.mock.calls, ...update.mock.calls]);
  const lastRendered = () => (update.mock.calls.at(-1) ?? postMessage.mock.calls.at(-1))![0];
  const buttons = (args: Args): Args[] =>
    (args.blocks as Args[]).filter((block) => block.type === "actions").flatMap((block) => block.elements as Args[]);
  const button = (args: Args, actionId: string) => buttons(args).find((element) => element.action_id === actionId);
  return { core, auth, app, listeners, postMessage, update, remove, open, logged, message, click, submit, ack, shown, lastRendered, buttons, button };
}

/** Start a flow from the operator's DM and return the handle of its PTY. */
async function startLogin(f: ReturnType<typeof fixture>, provider: "claude" | "codex") {
  await f.click(`ryoko_auth_start_${provider}`);
  return f.core.ptys.at(-1)!;
}

describe("Slack provider login — who may use it", () => {
  it("opens the login menu for the operator's own DM, without routing the message", async () => {
    const f = fixture();

    expect(await f.message("ログイン")).toBe(true);

    expect(f.postMessage).toHaveBeenCalledTimes(1);
    const menu = f.postMessage.mock.calls[0][0];
    expect(menu.channel).toBe(DM);
    expect(f.buttons(menu).map((element) => element.action_id)).toEqual(["ryoko_auth_start_claude", "ryoko_auth_start_codex"]);
    expect(f.buttons(menu).map((element) => element.text.text)).toEqual(["Claude にログイン", "Codex にログイン"]);
  });

  it.each(["再ログイン", "login", "/login", " ログイン ", "<@UBOT> ログイン"])("accepts the command form %j", async (text) => {
    const f = fixture();
    expect(await f.message(text)).toBe(true);
    expect(f.postMessage).toHaveBeenCalledTimes(1);
  });

  it("answers inside the thread the operator wrote in", async () => {
    const f = fixture();
    await f.message("ログイン", { thread_ts: "40.000" });
    expect(f.postMessage.mock.calls[0][0]).toMatchObject({ channel: DM, thread_ts: "40.000" });
  });

  it("is invisible to everyone else and everywhere else", async () => {
    const f = fixture();

    expect(await f.message("ログイン", { user: "UOTHER" })).toBe(false);
    expect(await f.message("ログイン", { channel: "C1", channel_type: "channel" })).toBe(false);
    expect(await f.message("ログイン", { channel: "G1", channel_type: "mpim" })).toBe(false);
    expect(await f.message("ログイン", { channel: "C1", channel_type: "group" })).toBe(false);
    expect(await f.message("ログイン", { bot_id: "B1" })).toBe(false);
    expect(await f.message("ログイン", { subtype: "file_share" })).toBe(false);
    expect(await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`, { user: "UOTHER" })).toBe(false);
    expect(await f.message("ログインできない件を調べて")).toBe(false);

    await f.click("ryoko_auth_start_claude", { user: "UOTHER" });
    await f.click("ryoko_auth_start_claude", { channel: "C1" });
    const stranger = await f.submit(`${OAUTH_CODE}#${OAUTH_STATE}`, JSON.stringify({ provider: "claude", flowId: "x" }), "UOTHER");

    expect(f.ack).toHaveBeenCalledTimes(2);
    expect(stranger).toHaveBeenCalledExactlyOnceWith();
    expect(f.core.spawnPty).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("does nothing while no operator Slack ID is configured", async () => {
    const f = fixture({ operator: undefined });

    expect(await f.message("ログイン")).toBe(false);
    await f.click("ryoko_auth_start_claude");
    f.core.service.reportAuthFailure("claude");
    await settle();

    expect(f.core.spawnPty).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("treats an unreadable config as no operator, without failing the message", async () => {
    const f = fixture({ readOperator: () => { throw new Error("config.yaml is being rewritten"); } });

    expect(await f.message("ログイン")).toBe(false);
    await f.click("ryoko_auth_start_claude");
    f.core.service.reportAuthFailure("claude");
    await settle();

    expect(f.core.spawnPty).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("does not look the operator up for ordinary DM messages", async () => {
    const readOperator = vi.fn(() => OPERATOR);
    const f = fixture({ readOperator });

    expect(await f.message("今日の予定を教えて")).toBe(false);
    expect(await f.message("AB12-CD34")).toBe(false);
    expect(readOperator).not.toHaveBeenCalled();
  });

  it("requires the operator to pass allowFrom as well", async () => {
    const f = fixture({ allowed: (user) => user !== OPERATOR });

    expect(await f.message("ログイン")).toBe(false);
    await f.click("ryoko_auth_start_claude");
    expect(f.core.spawnPty).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("leaves a command replayed from before boot to the normal old-message drop", async () => {
    const f = fixture({ stale: true });
    expect(await f.message("ログイン")).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});

describe("Slack provider login — Claude", () => {
  it("walks the operator from the button to a confirmed login, taking the code in a modal", async () => {
    const f = fixture();
    await f.message("ログイン");
    const pty = await startLogin(f, "claude");

    expect(pty.args).toEqual(["auth", "login", "--claudeai"]);
    expect(f.postMessage).toHaveBeenCalledTimes(2);
    const started = f.postMessage.mock.calls[1][0];
    expect(started.channel).toBe(DM);

    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    const prompt = f.update.mock.calls.at(-1)![0];
    expect(prompt).toMatchObject({ channel: DM, ts: "102.000" });
    expect(f.button(prompt, "ryoko_auth_open_claude")!.url).toBe(CLAUDE_URL);
    expect(JSON.stringify(prompt.blocks)).toContain(`"text":"${CLAUDE_URL}"`);
    const flowId = f.button(prompt, "ryoko_auth_input_claude")!.value;
    expect(f.core.service.activeFlow("claude")).toEqual({ flowId, acceptsInput: true });

    await f.click("ryoko_auth_input_claude", { value: flowId });
    expect(f.open).toHaveBeenCalledTimes(1);
    const modal = f.open.mock.calls[0][0];
    expect(modal.trigger_id).toBe("trigger-1");
    expect(modal.view).toMatchObject({ type: "modal", callback_id: "ryoko_auth_code" });
    expect(f.listeners.viewId).toBe("ryoko_auth_code");

    const viewAck = await f.submit(` ${OAUTH_CODE}#${OAUTH_STATE}\n`, modal.view.private_metadata);
    expect(viewAck).toHaveBeenCalledExactlyOnceWith();
    f.core.clock.advance(150);
    expect(pty.write.mock.calls).toEqual([[`${OAUTH_CODE}#${OAUTH_STATE}`], ["\r"]]);

    pty.emitExit(0);
    await settle();
    const done = f.update.mock.calls.at(-1)![0];
    expect(done).toMatchObject({ channel: DM, ts: "102.000" });
    expect(done.text).toContain("Claude にログインしました");
    expect(f.buttons(done)).toEqual([]);
    expect(JSON.stringify(done)).not.toContain("claude.ai");
    expect(f.core.service.activeFlow("claude")).toBeUndefined();
  });

  it("keeps the modal open with a reason when the code is not a code", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");
    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    const flowId = f.button(f.lastRendered(), "ryoko_auth_input_claude")!.value;
    await f.click("ryoko_auth_input_claude", { value: flowId });
    const metadata = f.open.mock.calls[0][0].view.private_metadata;

    for (const value of ["hello", OAUTH_CODE, "sk-ant-oat01-" + "a".repeat(60), `${OAUTH_CODE}#${OAUTH_STATE}; exit`]) {
      const viewAck = await f.submit(value, metadata);
      expect(viewAck).toHaveBeenCalledExactlyOnceWith({
        response_action: "errors",
        errors: { ryoko_auth_code_block: expect.stringContaining("形式") },
      });
    }
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("refuses a modal that belongs to a login which is over", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");
    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    const flowId = f.button(f.lastRendered(), "ryoko_auth_input_claude")!.value;
    await f.click("ryoko_auth_input_claude", { value: flowId });
    const metadata = f.open.mock.calls[0][0].view.private_metadata;
    f.core.clock.advance(FLOW_TTL_MS);
    await settle();

    const viewAck = await f.submit(`${OAUTH_CODE}#${OAUTH_STATE}`, metadata);
    expect(viewAck).toHaveBeenCalledExactlyOnceWith({
      response_action: "errors",
      errors: { ryoko_auth_code_block: expect.stringContaining("終了") },
    });
    expect(pty.write).not.toHaveBeenCalled();

    f.postMessage.mockClear();
    await f.click("ryoko_auth_input_claude", { value: flowId });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.postMessage.mock.calls[0][0].text).toContain("終了");
  });

  it("does not take a code pasted into the chat, and says where it goes instead", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");
    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    f.postMessage.mockClear();

    const callback = `<http://localhost:58741/callback?code=${OAUTH_CODE}&amp;state=${OAUTH_STATE}>`;
    for (const pasted of [`${OAUTH_CODE}#${OAUTH_STATE}`, callback, "AB12-CD34"]) {
      expect(await f.message(pasted), pasted).toBe(true);
    }

    expect(pty.write).not.toHaveBeenCalled();
    expect(f.postMessage).toHaveBeenCalledTimes(3);
    for (const [reply] of f.postMessage.mock.calls) expect(reply.text).toContain("コードを入力");
    expect(f.shown()).not.toContain(OAUTH_CODE);
  });

  it("keeps an OAuth artifact out of the conversation even when no login is running", async () => {
    const f = fixture();

    expect(await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`)).toBe(true);
    expect(await f.message("AB12-CD34")).toBe(false);

    expect(f.postMessage).toHaveBeenCalledTimes(1);
    expect(f.postMessage.mock.calls[0][0].text).toContain("進行中のログインはありません");
    expect(f.shown()).not.toContain(OAUTH_CODE);
  });

  it("swallows a pasted code replayed from before boot without answering it", async () => {
    const f = fixture({ stale: true });
    expect(await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`)).toBe(true);
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});

describe("Slack provider login — Codex", () => {
  it("shows the link and the device code, then confirms once the browser step is done", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    expect(pty.args).toEqual(["login", "--device-auth"]);

    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    const prompt = f.lastRendered();
    expect(f.button(prompt, "ryoko_auth_open_codex")!.url).toBe(CODEX_URL);
    expect(JSON.stringify(prompt.blocks)).toContain(CODEX_DEVICE_CODE);
    expect(f.button(prompt, "ryoko_auth_input_codex")).toBeUndefined();
    expect(f.button(prompt, "ryoko_auth_cancel_codex")).toBeDefined();

    pty.emitExit(0);
    await settle();
    const done = f.lastRendered();
    expect(done.text).toContain("Codex にログインしました");
    expect(JSON.stringify(done)).not.toContain(CODEX_DEVICE_CODE);
    expect(JSON.stringify(done)).not.toContain("openai.com");
  });
});

describe("Slack provider login — endings", () => {
  const endings: Array<[string, (f: ReturnType<typeof fixture>, pty: ReturnType<typeof makeHarness>["ptys"][number]) => Promise<void> | void, string]> = [
    ["the CLI gives up", (_f, pty) => pty.emitExit(1), "完了しませんでした"],
    ["the login is not confirmed", (f, pty) => { f.core.status.codex = { stdout: "", exitCode: 1 }; pty.emitExit(0); }, "確認できませんでした"],
    ["ten minutes pass", (f) => f.core.clock.advance(FLOW_TTL_MS), "10 分"],
    ["the operator cancels", async (f) => {
      await f.click("ryoko_auth_cancel_codex", { value: f.button(f.lastRendered(), "ryoko_auth_cancel_codex")!.value });
    }, "キャンセル"],
    ["the connector stops", async (f) => { await f.auth.stop(); }, "中断"],
  ];

  it.each(endings)("blanks the link and the device code when %s", async (_name, end, expected) => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    const promptTs = f.lastRendered().ts;
    expect(JSON.stringify(f.lastRendered())).toContain(CODEX_DEVICE_CODE);

    await end(f, pty);
    await settle();

    const final = f.lastRendered();
    expect(final).toMatchObject({ channel: DM, ts: promptTs });
    expect(final.text).toContain(expected);
    expect(f.buttons(final)).toEqual([]);
    expect(JSON.stringify(final)).not.toContain(CODEX_DEVICE_CODE);
    expect(JSON.stringify(final)).not.toContain("https://");
    expect(f.core.service.activeFlow("codex")).toBeUndefined();
  });

  it("posts the login in the thread its button was pressed in", async () => {
    const f = fixture();
    await f.click("ryoko_auth_start_codex", { threadTs: "40.000" });
    expect(f.postMessage.mock.calls[0][0]).toMatchObject({ channel: DM, thread_ts: "40.000" });
  });

  it("kills the CLI when the connector stops", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");

    await f.auth.stop();

    expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    expect(f.core.service.activeFlow("claude")).toBeUndefined();
    expect(await f.message("ログイン")).toBe(false);
  });

  it("waits at shutdown for a blanking edit that is still on its way to Slack", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    const pending: Array<() => void> = [];
    f.update.mockImplementation(() => new Promise((resolve) => { pending.push(() => resolve({})); }));

    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    pty.emitExit(1);
    await settle();
    expect(pending).toHaveLength(1);
    pending[0]();
    await settle();
    expect(pending).toHaveLength(2);
    expect(f.update.mock.calls[1][0].text).toContain("完了しませんでした");

    let stopped = false;
    const stopping = f.auth.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);

    pending[1]();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("removes the message when it cannot be edited, and still reports the outcome", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    const promptTs = f.lastRendered().ts;
    f.update.mockRejectedValue(Object.assign(new Error("An API error occurred: cant_update_message"), { data: { error: "cant_update_message" } }));
    f.postMessage.mockClear();

    pty.emitExit(0);
    await settle();

    expect(f.remove).toHaveBeenCalledExactlyOnceWith({ channel: DM, ts: promptTs });
    expect(f.postMessage.mock.calls.at(-1)![0].text).toContain("Codex にログインしました");
  });

  it("says so when a message holding a code could be neither edited nor removed", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    f.update.mockRejectedValue(new Error("network"));
    f.remove.mockRejectedValue(new Error("network"));
    f.postMessage.mockClear();

    pty.emitExit(0);
    await settle();

    expect(f.postMessage.mock.calls.at(-1)![0].text).toContain("伏せられませんでした");
  });
});

describe("Slack provider login — refusals the operator hears about", () => {
  it("says a login is already in progress instead of starting a second one", async () => {
    const f = fixture();
    await startLogin(f, "claude");
    f.postMessage.mockClear();

    await f.click("ryoko_auth_start_claude");

    expect(f.core.spawnPty).toHaveBeenCalledTimes(1);
    expect(f.postMessage.mock.calls[0][0].text).toContain("すでに進行中");
  });

  it("says the CLI could not be started", async () => {
    const f = fixture();
    f.core.spawnPty.mockImplementationOnce(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });

    await f.click("ryoko_auth_start_codex");

    expect(f.postMessage).toHaveBeenCalledTimes(1);
    expect(f.postMessage.mock.calls[0][0].text).toContain("起動できませんでした");
  });

  it("gives the reason when Slack will not open the modal", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");
    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    const flowId = f.button(f.lastRendered(), "ryoko_auth_input_claude")!.value;
    f.open.mockRejectedValueOnce(Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } }));
    f.postMessage.mockClear();

    await f.click("ryoko_auth_input_claude", { value: flowId });

    expect(f.postMessage.mock.calls[0][0].text).toContain("missing_scope");
  });

  it("tells the operator when no sign-in link can be read from the CLI", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");
    pty.emitData("an output format this version does not understand\r\n");

    f.core.clock.advance(30_000);
    await settle();

    expect(f.lastRendered().text).toContain("読み取れていません");
    expect(f.button(f.lastRendered(), "ryoko_auth_cancel_claude")).toBeDefined();
  });

  it("acknowledges a click on the link button and does nothing else", async () => {
    const f = fixture();
    await f.click("ryoko_auth_open_claude");
    expect(f.ack).toHaveBeenCalledTimes(1);
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});

describe("Slack provider login — the automatic notice", () => {
  it("DMs the operator once with a button for the provider that failed", async () => {
    const f = fixture();

    for (let turn = 0; turn < 5; turn += 1) f.core.service.reportAuthFailure("codex");
    await settle();

    expect(f.postMessage).toHaveBeenCalledTimes(1);
    const notice = f.postMessage.mock.calls[0][0];
    expect(notice.channel).toBe(OPERATOR);
    expect(f.buttons(notice).map((element) => element.action_id)).toEqual(["ryoko_auth_start_codex"]);

    await f.click("ryoko_auth_start_codex");
    expect(f.core.ptys).toHaveLength(1);
  });

  it("stops notifying once the connector has stopped", async () => {
    const f = fixture();
    await f.auth.stop();

    f.core.service.reportAuthFailure("claude");
    await settle();
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});

describe("Slack provider login — secrets", () => {
  it("never puts the link or a code in a notification text or in the log", async () => {
    const f = fixture();
    await f.message("ログイン");
    const claude = await startLogin(f, "claude");
    claude.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    const flowId = f.button(f.lastRendered(), "ryoko_auth_input_claude")!.value;
    await f.click("ryoko_auth_input_claude", { value: flowId });
    await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`);
    await f.submit("not a code", f.open.mock.calls[0][0].view.private_metadata);
    await f.submit(`${OAUTH_CODE}#${OAUTH_STATE}`, f.open.mock.calls[0][0].view.private_metadata);
    claude.emitExit(0);
    await settle();
    const codex = await startLogin(f, "codex");
    codex.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    f.update.mockRejectedValueOnce(Object.assign(new Error(`cannot update ${CODEX_URL} ${CODEX_DEVICE_CODE}`), { data: { error: "cant_update_message" } }));
    codex.emitExit(1);
    await settle();

    // The top-level `text` is what Slack puts in push notifications, and what
    // the connector's own message log echoes back for bot messages.
    const texts = [...f.postMessage.mock.calls, ...f.update.mock.calls].map(([args]) => String(args.text));
    const log = [...f.logged, ...f.core.logged].join("\n");
    expect(f.logged.length).toBeGreaterThan(3);
    for (const secret of [CLAUDE_URL, "claude.ai", OAUTH_CODE, OAUTH_STATE, CODEX_DEVICE_CODE, CODEX_URL, "openai.com"]) {
      expect(texts.join("\n"), secret).not.toContain(secret);
      expect(log, secret).not.toContain(secret);
    }
    expect(log).not.toMatch(/https?:\/\//);
  });
});
