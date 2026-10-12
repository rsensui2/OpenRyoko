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
    // One clock for the flow engine and the connector, as in production.
    clock: core.clock,
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

  it.each([
    "C0CHANNEL1", "D0OPERATOR", "G0GROUP1", "B0BOT", "#general", "operator", "u0operator", " UOPERATOR", "UOPERATOR ",
    "U-OPERATOR", "@UOPERATOR", "U",
  ])("treats an operator ID that is not a Slack user ID as unset: %j", async (configured) => {
    const f = fixture({ operator: configured });

    // Not even a message "from" that ID is accepted, and no notice is sent "to" it:
    // with a channel ID here, the notice — buttons included — would land in that channel.
    expect(await f.message("ログイン", { user: configured })).toBe(false);
    await f.click("ryoko_auth_start_claude", { user: configured });
    f.core.service.reportAuthFailure("claude");
    await settle();

    expect(f.core.spawnPty).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it.each(["U0123ABCDE", "W0123ABCDE"])("accepts a Slack user ID: %s", async (configured) => {
    const f = fixture({ operator: configured });

    expect(await f.message("ログイン", { user: configured })).toBe(true);
    f.core.service.reportAuthFailure("codex");
    await settle();

    expect(f.postMessage.mock.calls.map(([args]) => args.channel)).toEqual([DM, configured]);
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

    for (const value of ["hello", OAUTH_CODE, "sk-ant-oat01-" + "a".repeat(60), `${OAUTH_CODE}#${OAUTH_STATE}; exit`, "AB12-CD34"]) {
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

  it.each([
    "この http://localhost:3000/callback?code=abc&state=xyz が 500 になる。調べて",
    "この <http://localhost:3000/callback?code=abc&amp;state=xyz> が 500 になる。調べて",
    "docs の installation-and-setup-guide#troubleshooting を直して",
    `さっきの ${OAUTH_CODE}#${OAUTH_STATE} は何のコード？`,
    "http://localhost:3000/callback?code=abc&state=xyz",
  ])("leaves an ordinary request to the session when no login is running: %s", async (text) => {
    const f = fixture();

    expect(await f.message(text)).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("takes a message that is nothing but a callback URL even when no login is running", async () => {
    const f = fixture();

    expect(await f.message(`<http://localhost:58741/callback?code=${OAUTH_CODE}&amp;state=${OAUTH_STATE}>`)).toBe(true);
    expect(f.postMessage.mock.calls[0][0].text).toContain("進行中のログインはありません");
  });

  it.each([
    ["with a file attached", `${OAUTH_CODE}#${OAUTH_STATE}`, { subtype: "file_share", files: [{ id: "F1" }] }],
    ["also sent to the DM from a thread", `${OAUTH_CODE}#${OAUTH_STATE}`, { subtype: "thread_broadcast", thread_ts: "40.000" }],
    ["in backticks", `\`${OAUTH_CODE}#${OAUTH_STATE}\``, {}],
    ["in bold", `*${OAUTH_CODE}#${OAUTH_STATE}*`, {}],
    ["inside a sentence", `コードは${OAUTH_CODE}#${OAUTH_STATE}です`, {}],
    ["as a callback URL inside a sentence", `これです <http://localhost:58741/callback?code=${OAUTH_CODE}&amp;state=${OAUTH_STATE}> お願いします`, {}],
    ["as a device code inside a sentence", `コードは ${CODEX_DEVICE_CODE} でした`, {}],
  ] as const)("while a login is running, swallows a code pasted %s", async (_name, text, extra) => {
    const f = fixture();
    const pty = await startLogin(f, "claude");
    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    await settle();
    f.postMessage.mockClear();

    expect(await f.message(text, extra)).toBe(true);

    expect(pty.write).not.toHaveBeenCalled();
    expect(f.postMessage).toHaveBeenCalledTimes(1);
    expect(f.postMessage.mock.calls[0][0].text).toContain("コードを入力");
    // The match is deliberately broad for these ten minutes; say how to get an ordinary message through.
    expect(f.postMessage.mock.calls[0][0].text).toContain("ログインが終わってから");
    expect(f.shown()).not.toContain(OAUTH_CODE);
  });

  it("while a login is running, still routes messages that carry no code, and ignores everyone but the operator", async () => {
    const f = fixture();
    await startLogin(f, "claude");
    f.postMessage.mockClear();

    expect(await f.message("今日の予定を教えて")).toBe(false);
    expect(await f.message("資料です", { subtype: "file_share", files: [{ id: "F1" }] })).toBe(false);
    expect(await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`, { user: "UOTHER" })).toBe(false);
    expect(await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`, { bot_id: "B1", subtype: "bot_message" })).toBe(false);
    expect(await f.message(`${OAUTH_CODE}#${OAUTH_STATE}`, { channel: "C1", channel_type: "channel" })).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
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

  it("on success, shows what the CLI says it is logged in as and asks the operator to confirm it was them", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();

    pty.emitExit(0);
    await settle();

    const done = f.lastRendered();
    const shown = JSON.stringify(done.blocks);
    // A device code can be approved by anyone who sees it — with their own account.
    expect(shown).toContain("Logged in using ChatGPT");
    expect(shown).toContain("ご自身で");
    expect(shown).toContain("やり直してください");
    expect(done.text).toContain("確認してください");
    // The status line may name an account: it stays out of the notification text and the message log.
    expect(done.text).not.toContain("Logged in using ChatGPT");
    expect([...f.logged, ...f.core.logged].join("\n")).not.toContain("Logged in using ChatGPT");
  });

  it("asks for the same confirmation when the CLI says nothing about the login", async () => {
    const f = fixture();
    f.core.status.codex = { stdout: "", exitCode: 0 };
    const pty = await startLogin(f, "codex");

    pty.emitExit(0);
    await settle();

    const done = f.lastRendered();
    expect(done.text).toContain("Codex にログインしました");
    expect(JSON.stringify(done.blocks)).toContain("ご自身で");
    expect(JSON.stringify(done.blocks)).not.toContain("CLI の表示");
  });

  it("says a Claude login could not be confirmed — not that it succeeded — when a clean exit comes with 'Not logged in'", async () => {
    const f = fixture();
    f.core.status.claude = { stdout: "Not logged in\n", exitCode: 0 };
    const pty = await startLogin(f, "claude");

    pty.emitExit(0);
    await settle();

    const done = f.lastRendered();
    expect(done.text).toContain("確認できませんでした");
    expect(done.text).not.toContain("ログインしました");
  });

  it("does not ask for it after a Claude login, whose code only ever goes in through the dialog", async () => {
    const f = fixture();
    const pty = await startLogin(f, "claude");

    pty.emitExit(0);
    await settle();

    const done = f.lastRendered();
    expect(done.text).toContain("Claude にログインしました");
    expect(JSON.stringify(done)).not.toContain("ご自身で");
    expect(JSON.stringify(done)).not.toContain("operator@example.com");
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

  it("at gateway shutdown, the login is stopped and its message blanked before anything else is waited for", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    let finishEdit!: () => void;
    f.update.mockImplementationOnce(() => new Promise((resolve) => { finishEdit = () => resolve({}); }));

    let stopped = false;
    const stopping = f.core.service.stop().then(() => { stopped = true; });
    expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    await settle();
    // The service does not report itself stopped while the blanking edit is still on its way to Slack.
    expect(stopped).toBe(false);
    expect(f.update.mock.calls.at(-1)![0].text).toContain("中断");
    expect(JSON.stringify(f.update.mock.calls.at(-1)![0])).not.toContain(CODEX_DEVICE_CODE);

    finishEdit();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("does not wait again at connector stop for an edit that gateway shutdown has already given up on", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    // Slack never answers the edit that would blank the message.
    f.update.mockImplementation(() => new Promise(() => {}));

    // Shutdown, step one: the flow engine stops and gives the blanking 1.5 seconds.
    const gatewayStop = f.core.service.stop();
    f.core.clock.advance(1_500);
    await gatewayStop;

    // Later in the same shutdown the connector stops. The same unfinished edit
    // must not buy another 1.5 seconds out of the five the gateway has.
    let connectorStopped = false;
    const connectorStop = f.auth.stop().then(() => { connectorStopped = true; });
    await settle();
    expect(connectorStopped).toBe(true);
    await connectorStop;
  });

  it("on a connector reload, still gives a login it stops 1.5 seconds to have its message blanked", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    f.update.mockImplementation(() => new Promise(() => {}));

    let stopped = false;
    const stopping = f.auth.stop().then(() => { stopped = true; });
    expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    f.core.clock.advance(1_499);
    await settle();
    expect(stopped).toBe(false);

    f.core.clock.advance(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("gives a login that ended on its own only what is left of its 1.5 seconds", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    f.update.mockImplementation(() => new Promise(() => {}));
    pty.emitExit(1);
    await settle();
    f.core.clock.advance(1_000);

    let stopped = false;
    const stopping = f.auth.stop().then(() => { stopped = true; });
    f.core.clock.advance(499);
    await settle();
    expect(stopped).toBe(false);

    f.core.clock.advance(1);
    await stopping;
    expect(stopped).toBe(true);
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

  it("never posts the link again when an edit of the prompt fails while the login is ending", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    let failPromptEdit!: () => void;
    f.update.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failPromptEdit = () => reject(Object.assign(new Error("An API error occurred: ratelimited"), { data: { error: "ratelimited" } }));
    }));
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    const promptTs = f.update.mock.calls[0][0].ts;
    expect(JSON.stringify(f.update.mock.calls[0][0])).toContain(CODEX_DEVICE_CODE);

    // The login ends while Slack has not yet answered the edit that shows the prompt…
    pty.emitExit(1);
    await settle();
    f.postMessage.mockClear();
    // …and then that edit fails.
    failPromptEdit();
    await settle();

    const postedAfterTheEnd = JSON.stringify(f.postMessage.mock.calls);
    expect(postedAfterTheEnd).not.toContain(CODEX_DEVICE_CODE);
    expect(postedAfterTheEnd).not.toContain("https://");
    expect(f.remove).not.toHaveBeenCalled();
    const final = f.update.mock.calls.at(-1)![0];
    expect(final).toMatchObject({ channel: DM, ts: promptTs });
    expect(final.text).toContain("完了しませんでした");
    expect(f.buttons(final)).toEqual([]);
  });

  it("replaces an uneditable message with the outcome only, even when every edit fails", async () => {
    const f = fixture();
    const pty = await startLogin(f, "codex");
    f.update.mockRejectedValue(Object.assign(new Error("An API error occurred: cant_update_message"), { data: { error: "cant_update_message" } }));
    pty.emitData(CODEX_LOGIN_OUTPUT);
    await settle();
    f.postMessage.mockClear();

    pty.emitExit(1);
    await settle();

    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.postMessage).toHaveBeenCalledTimes(1);
    const replacement = f.postMessage.mock.calls[0][0];
    expect(replacement.text).toContain("完了しませんでした");
    expect(JSON.stringify(replacement)).not.toContain(CODEX_DEVICE_CODE);
    expect(f.buttons(replacement)).toEqual([]);
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
