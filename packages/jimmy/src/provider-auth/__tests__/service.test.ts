import { describe, expect, it } from "vitest";
import { FLOW_TTL_MS } from "../service.js";
import {
  CLAUDE_LOGIN_OUTPUT, CLAUDE_URL, CODEX_DEVICE_CODE, CODEX_LOGIN_OUTPUT, CODEX_URL, COMMANDS,
  OAUTH_CODE, OAUTH_STATE, makeHarness, makeListener, settle,
} from "./support.js";

async function startFlow(harness: ReturnType<typeof makeHarness>, provider: "claude" | "codex") {
  const observed = makeListener();
  const result = await harness.service.start(provider, observed.listener);
  if (!result.ok) throw new Error(`flow did not start: ${result.reason}`);
  return { ...observed, flowId: result.flowId, pty: harness.ptys.at(-1)! };
}

describe("ProviderAuthService — Claude", () => {
  it("runs the login in the engine's own home and environment", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    expect(flow.pty.file).toBe(COMMANDS.claude.file);
    expect(flow.pty.args).toEqual(["auth", "login", "--claudeai"]);
    expect(flow.pty.options.env).toEqual(COMMANDS.claude.env);
    expect(flow.pty.options.cwd).toBe(COMMANDS.claude.cwd);
  });

  it("shows the link, takes code#state, and reports success only after the CLI confirms it", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    flow.pty.emitData(CLAUDE_LOGIN_OUTPUT);
    expect(flow.prompts).toEqual([{ flowId: flow.flowId, provider: "claude", url: CLAUDE_URL, acceptsInput: true }]);

    expect(harness.service.submitInput("claude", flow.flowId, `${OAUTH_CODE}#${OAUTH_STATE}`)).toEqual({ ok: true });
    // The code and the Enter that submits it are separate writes: a CLI reading
    // its prompt in raw mode takes a CR inside the same chunk as pasted text.
    expect(flow.pty.write.mock.calls).toEqual([[`${OAUTH_CODE}#${OAUTH_STATE}`]]);
    harness.clock.advance(150);
    expect(flow.pty.write.mock.calls).toEqual([[`${OAUTH_CODE}#${OAUTH_STATE}`], ["\r"]]);

    flow.pty.emitExit(0);
    expect(flow.outcomes).toEqual([]);
    await settle();

    expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(
      COMMANDS.claude.file,
      ["auth", "status", "--json"],
      expect.objectContaining({ env: COMMANDS.claude.env, cwd: COMMANDS.claude.cwd }),
    );
    // Claude's status output names the account; none of it leaves the flow engine.
    expect(flow.outcomes).toEqual([{ status: "succeeded" }]);
    expect(flow.events).toEqual(["prompt", "verifying", "settled:succeeded"]);
    expect(harness.service.activeFlow("claude")).toBeUndefined();
  });

  it("rebuilds code#state from a loopback callback URL", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    const callback = `http://localhost:58741/callback?code=${OAUTH_CODE}&state=${OAUTH_STATE}`;
    expect(harness.service.submitInput("claude", flow.flowId, callback)).toEqual({ ok: true });
    harness.clock.advance(150);
    expect(flow.pty.write.mock.calls).toEqual([[`${OAUTH_CODE}#${OAUTH_STATE}`], ["\r"]]);
  });

  it("does not press Enter for a login that ended before the keystroke was due", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    harness.service.submitInput("claude", flow.flowId, `${OAUTH_CODE}#${OAUTH_STATE}`);
    harness.service.cancel("claude", flow.flowId);
    harness.clock.advance(150);

    expect(flow.pty.write.mock.calls).toEqual([[`${OAUTH_CODE}#${OAUTH_STATE}`]]);
  });

  it("finishes one code before typing the next", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    const first = `${OAUTH_CODE}#${OAUTH_STATE}`;
    const second = `${"Cd".repeat(24)}#${OAUTH_STATE}`;

    harness.service.submitInput("claude", flow.flowId, first);
    harness.service.submitInput("claude", flow.flowId, second);
    harness.clock.advance(150);

    expect(flow.pty.write.mock.calls).toEqual([[first], ["\r"], [second], ["\r"]]);
  });

  it("survives a CLI that has gone away by the time Enter is due", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    flow.pty.write.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("EIO"); });

    expect(harness.service.submitInput("claude", flow.flowId, `${OAUTH_CODE}#${OAUTH_STATE}`)).toEqual({ ok: true });
    expect(() => harness.clock.advance(150)).not.toThrow();
    expect(flow.pty.write).toHaveBeenCalledTimes(2);
  });

  it("never passes input to the CLI unless it is code#state or a loopback callback", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    for (const input of [
      "", "hello", "y\n", "rm -rf ~", OAUTH_CODE, "sk-ant-oat01-" + "a".repeat(60),
      `${OAUTH_CODE}#${OAUTH_STATE}\nexit`, `https://example.com/callback?code=${OAUTH_CODE}&state=${OAUTH_STATE}`,
      "\u0003", "ab12-cd34",
    ]) {
      expect(harness.service.submitInput("claude", flow.flowId, input), JSON.stringify(input)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(flow.pty.write).not.toHaveBeenCalled();
  });

  it("refuses a short code as malformed: Claude's prompt discards a line without '#' and keeps waiting", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    for (const input of ["AB12-CD34", "FHI3-TCJKF"]) {
      expect(harness.service.submitInput("claude", flow.flowId, input)).toEqual({ ok: false, reason: "invalid" });
    }
    harness.clock.advance(150);
    expect(flow.pty.write).not.toHaveBeenCalled();
  });

  it("refuses input for a flow that is not the one in progress", async () => {
    const harness = makeHarness();
    const input = `${OAUTH_CODE}#${OAUTH_STATE}`;
    expect(harness.service.submitInput("claude", "missing", input)).toEqual({ ok: false, reason: "no-flow" });

    const flow = await startFlow(harness, "claude");
    expect(harness.service.submitInput("claude", "another-flow", input)).toEqual({ ok: false, reason: "no-flow" });
    expect(harness.service.submitInput("codex", flow.flowId, input)).toEqual({ ok: false, reason: "no-flow" });

    flow.pty.emitExit(0);
    expect(harness.service.submitInput("claude", flow.flowId, input)).toEqual({ ok: false, reason: "no-flow" });
    expect(flow.pty.write).not.toHaveBeenCalled();
  });

  it("reports a failed write instead of pretending the code was sent", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    flow.pty.write.mockImplementation(() => { throw new Error("EIO"); });

    expect(harness.service.submitInput("claude", flow.flowId, `${OAUTH_CODE}#${OAUTH_STATE}`)).toEqual({ ok: false, reason: "write-failed" });
  });
});

describe("ProviderAuthService — Codex", () => {
  it("shows the link and device code, then confirms the login with the CLI", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "codex");

    expect(flow.pty.file).toBe(COMMANDS.codex.file);
    expect(flow.pty.args).toEqual(["login", "--device-auth"]);
    expect(flow.pty.options.env).toEqual(COMMANDS.codex.env);

    flow.pty.emitData(CODEX_LOGIN_OUTPUT);
    expect(flow.prompts).toEqual([
      { flowId: flow.flowId, provider: "codex", url: CODEX_URL, deviceCode: CODEX_DEVICE_CODE, acceptsInput: false },
    ]);

    flow.pty.emitExit(0);
    await settle();

    expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(
      COMMANDS.codex.file, ["login", "status"], expect.objectContaining({ env: COMMANDS.codex.env }),
    );
    // The outcome carries what the CLI itself says about the login it now holds.
    expect(flow.outcomes).toEqual([{ status: "succeeded", cliStatus: "Logged in using ChatGPT" }]);
  });

  it.each([
    ["written to stderr", { stdout: "", stderr: "Logged in using ChatGPT\n", exitCode: 0 }, "Logged in using ChatGPT"],
    ["colored and padded", { stdout: "\r\n  \u001b[32mLogged in using ChatGPT\u001b[0m  \r\nsecond line\r\n", exitCode: 0 }, "Logged in using ChatGPT"],
    ["carrying a full key", { stdout: "Logged in using an API key - sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n", exitCode: 0 }, "Logged in using an API key - [REDACTED]"],
    ["longer than a line should be", { stdout: `Logged in as ${"x".repeat(500)}\n`, exitCode: 0 }, `Logged in as ${"x".repeat(107)}`],
  ])("passes on the status line %s in a form that is safe to show", async (_name, answer, expected) => {
    const harness = makeHarness({ status: { codex: answer } });
    const flow = await startFlow(harness, "codex");
    flow.pty.emitExit(0);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "succeeded", cliStatus: expected }]);
  });

  it("reports success without a status line when the CLI prints nothing", async () => {
    const harness = makeHarness({ status: { codex: { stdout: "", exitCode: 0 } } });
    const flow = await startFlow(harness, "codex");
    flow.pty.emitExit(0);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "succeeded" }]);
  });

  it("takes no input: the device flow is completed in the browser", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "codex");

    expect(harness.service.submitInput("codex", flow.flowId, CODEX_DEVICE_CODE)).toEqual({ ok: false, reason: "unsupported" });
    expect(flow.pty.write).not.toHaveBeenCalled();
  });

  it("re-renders when the code arrives after the link, and stays quiet on repeats", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "codex");
    const cut = CODEX_LOGIN_OUTPUT.indexOf("2. Enter");
    const [first, second] = [CODEX_LOGIN_OUTPUT.slice(0, cut), CODEX_LOGIN_OUTPUT.slice(cut)];
    expect(first).toContain(`${CODEX_URL}\u001b[0m\r\n`);
    expect(first).not.toContain(CODEX_DEVICE_CODE);

    flow.pty.emitData(first);
    flow.pty.emitData(second);
    flow.pty.emitData(CODEX_LOGIN_OUTPUT);

    expect(flow.prompts.map(({ url, deviceCode }) => ({ url, deviceCode }))).toEqual([
      { url: CODEX_URL, deviceCode: undefined },
      { url: CODEX_URL, deviceCode: CODEX_DEVICE_CODE },
    ]);
  });
});

describe("ProviderAuthService — lifecycle", () => {
  it("allows one flow per provider at a time", async () => {
    const harness = makeHarness();
    const first = makeListener();
    const second = makeListener();

    const results = await Promise.all([
      harness.service.start("claude", first.listener),
      harness.service.start("claude", second.listener),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, reason: "busy" });
    expect(await harness.service.start("claude", second.listener)).toEqual({ ok: false, reason: "busy" });
    expect(harness.spawnPty).toHaveBeenCalledTimes(1);

    expect((await harness.service.start("codex", second.listener)).ok).toBe(true);
    expect(harness.spawnPty).toHaveBeenCalledTimes(2);
  });

  it("stays busy while the result is being verified, then frees the provider", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    flow.pty.emitExit(0);

    expect(await harness.service.start("claude", makeListener().listener)).toEqual({ ok: false, reason: "busy" });
    await settle();
    expect((await harness.service.start("claude", makeListener().listener)).ok).toBe(true);
  });

  it("stops the CLI and reports expiry after 600 seconds", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "codex");
    expect(FLOW_TTL_MS).toBe(600_000);
    expect(harness.clock.delays()).toContain(600_000);

    flow.pty.emitData(CODEX_LOGIN_OUTPUT);
    harness.clock.advance(599_999);
    expect(flow.pty.kill).not.toHaveBeenCalled();
    expect(flow.outcomes).toEqual([]);

    harness.clock.advance(1);
    expect(flow.pty.kill).toHaveBeenCalledTimes(1);
    expect(flow.outcomes).toEqual([{ status: "expired" }]);
    expect(harness.service.activeFlow("codex")).toBeUndefined();

    flow.pty.emitData(CODEX_LOGIN_OUTPUT.replace(CODEX_DEVICE_CODE, "ZZZZ-99999"));
    flow.pty.emitExit(0);
    await settle();
    expect(flow.prompts).toHaveLength(1);
    expect(flow.outcomes).toEqual([{ status: "expired" }]);
    expect(harness.runCommand).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL when the CLI ignores the first signal", async () => {
    const harness = makeHarness();
    const stubborn = await startFlow(harness, "claude");
    harness.clock.advance(FLOW_TTL_MS);
    expect(stubborn.pty.kill.mock.calls).toEqual([[]]);
    harness.clock.advance(2_000);
    expect(stubborn.pty.kill.mock.calls).toEqual([[], ["SIGKILL"]]);

    const polite = await startFlow(harness, "claude");
    harness.clock.advance(FLOW_TTL_MS);
    polite.pty.emitExit(129);
    harness.clock.advance(2_000);
    expect(polite.pty.kill.mock.calls).toEqual([[]]);
  });

  it("cancels on request", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    expect(harness.service.cancel("claude", "another-flow")).toBe(false);
    expect(harness.service.cancel("claude", flow.flowId)).toBe(true);
    expect(flow.pty.kill).toHaveBeenCalledTimes(1);
    expect(flow.outcomes).toEqual([{ status: "cancelled" }]);
    expect(harness.service.cancel("claude", flow.flowId)).toBe(false);
  });

  it("stops one flow at once when the connector that owns it goes away", async () => {
    const harness = makeHarness();
    const claude = await startFlow(harness, "claude");
    const codex = await startFlow(harness, "codex");

    expect(harness.service.abort("claude", "another-flow")).toBe(false);
    expect(harness.service.abort("claude", claude.flowId)).toBe(true);

    expect(claude.pty.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
    expect(claude.outcomes).toEqual([{ status: "failed", reason: "stopped" }]);
    expect(codex.pty.kill).not.toHaveBeenCalled();
    expect(codex.outcomes).toEqual([]);
    expect((await harness.service.start("claude", makeListener().listener)).ok).toBe(true);
  });

  it("kills every CLI at shutdown and starts nothing afterwards", async () => {
    const harness = makeHarness();
    const claude = await startFlow(harness, "claude");
    const codex = await startFlow(harness, "codex");

    harness.service.stop();

    for (const flow of [claude, codex]) {
      expect(flow.pty.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
      expect(flow.outcomes).toEqual([{ status: "failed", reason: "stopped" }]);
    }
    expect(await harness.service.start("claude", makeListener().listener)).toEqual({ ok: false, reason: "stopped" });
    expect(harness.spawnPty).toHaveBeenCalledTimes(2);
  });

  it("waits at shutdown until the outcome has been shown, with the CLI already dead", async () => {
    const harness = makeHarness();
    const observed = makeListener();
    let finishShowing!: () => void;
    const shown = new Promise<void>((resolve) => { finishShowing = resolve; });
    await harness.service.start("claude", {
      ...observed.listener,
      onSettled: (outcome) => { void observed.listener.onSettled(outcome); return shown; },
    });
    const pty = harness.ptys[0];

    let stopped = false;
    const stopping = harness.service.stop().then(() => { stopped = true; });
    // Nothing is awaited before the CLI is killed and the flow is over.
    expect(pty.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
    expect(observed.outcomes).toEqual([{ status: "failed", reason: "stopped" }]);
    await settle();
    expect(stopped).toBe(false);

    finishShowing();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("stops waiting for the outcome to be shown after 1.5 seconds", async () => {
    const harness = makeHarness();
    await harness.service.start("codex", { onPrompt: () => {}, onSettled: () => new Promise<void>(() => {}) });

    let stopped = false;
    const stopping = harness.service.stop().then(() => { stopped = true; });
    harness.clock.advance(1_499);
    await settle();
    expect(stopped).toBe(false);

    harness.clock.advance(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("shuts down at once when no login is running, or when showing the outcome fails", async () => {
    const idle = makeHarness();
    await idle.service.stop();
    expect(idle.clock.delays()).toEqual([]);

    const failing = makeHarness();
    await failing.service.start("codex", { onPrompt: () => {}, onSettled: async () => { throw new Error("slack is down"); } });
    await failing.service.stop();
    expect(failing.clock.delays()).toEqual([]);
  });

  it("does not leave a CLI running when shutdown lands while it is being spawned", async () => {
    const harness = makeHarness();
    const starting = harness.service.start("claude", makeListener().listener);
    harness.service.stop();

    expect(await starting).toEqual({ ok: false, reason: "stopped" });
    for (const pty of harness.ptys) expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("frees the provider when the CLI cannot be started", async () => {
    const harness = makeHarness();
    harness.spawnPty.mockImplementationOnce(() => { throw Object.assign(new Error("spawn /opt/bin/claude ENOENT"), { code: "ENOENT" }); });
    const failed = makeListener();

    expect(await harness.service.start("claude", failed.listener)).toEqual({ ok: false, reason: "spawn-failed" });
    expect(failed.events).toEqual([]);
    expect((await harness.service.start("claude", makeListener().listener)).ok).toBe(true);
  });
});

describe("ProviderAuthService — verification", () => {
  it("fails without asking the CLI when the login process exits non-zero", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    flow.pty.emitExit(1);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "failed", reason: "exit" }]);
    expect(harness.runCommand).not.toHaveBeenCalled();
  });

  it("does not take a CLI killed by a signal for one that finished", async () => {
    // node-pty reports a signal death as exit code 0 plus the signal number.
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    flow.pty.emitExit(0, 9);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "failed", reason: "exit" }]);
    expect(harness.runCommand).not.toHaveBeenCalled();

    const clean = await startFlow(harness, "claude");
    clean.pty.emitExit(0, 0);
    await settle();
    expect(clean.outcomes).toEqual([{ status: "succeeded" }]);
  });

  it.each([
    ["the CLI's logged-out answer", { stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 }],
    ["a logged-out answer with a clean exit", { stdout: JSON.stringify({ loggedIn: false }), exitCode: 0 }],
    ["a logged-in answer from a failed probe", { stdout: JSON.stringify({ loggedIn: true }), exitCode: 1 }],
    ["unreadable output from a failed probe", { stdout: "Error: something went wrong", exitCode: 1 }],
    ["a probe that could not run", new Error("spawn ENOENT")],
  ])("treats %s as not verified (Claude)", async (_name, answer) => {
    const harness = makeHarness({ status: { claude: answer } });
    const flow = await startFlow(harness, "claude");
    flow.pty.emitExit(0);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "failed", reason: "unverified" }]);
  });

  // `claude auth status --json` exits `loggedIn ? 0 : 1`. Its JSON is drawn
  // through Ink, which wraps at 80 columns when piped: a long value is broken
  // across lines and the output stops being JSON.
  const WRAPPED_BY_INK = [
    "{",
    '  "loggedIn": true,',
    '  "authMethod": "claude.ai",',
    '  "apiProvider": "firstParty",',
    '  "email": "an-operator-with-a-rather-long-mailbox-name@a-company-with-a-long-nam',
    'e.example.com",',
    '  "orgName": "An Organization Whose Name Is Longer Than The Eighty Columns Ink Wr',
    'aps At When Its Output Is Piped",',
    '  "subscriptionType": "max"',
    "}",
  ].join("\n");

  it.each([
    ["JSON broken by line wrapping", { stdout: WRAPPED_BY_INK, exitCode: 0 }],
    ["output that is not JSON", { stdout: "Logged in", exitCode: 0 }],
    ["an answer of an unexpected shape", { stdout: JSON.stringify({ loggedIn: "yes" }), exitCode: 0 }],
    ["no output at all", { stdout: "", exitCode: 0 }],
  ])("goes by the exit status when the answer is %s (Claude)", async (_name, answer) => {
    expect(() => JSON.parse(WRAPPED_BY_INK)).toThrow();
    const harness = makeHarness({ status: { claude: answer } });
    const flow = await startFlow(harness, "claude");
    flow.pty.emitExit(0);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "succeeded" }]);
  });

  it("treats a non-zero `codex login status` as not verified", async () => {
    const harness = makeHarness({ status: { codex: { stdout: "Not logged in\n", exitCode: 1 } } });
    const flow = await startFlow(harness, "codex");
    flow.pty.emitExit(0);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "failed", reason: "unverified" }]);
  });

  it("keeps a cancellation that lands during verification", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");
    flow.pty.emitExit(0);
    expect(harness.service.cancel("claude", flow.flowId)).toBe(true);
    await settle();

    expect(flow.outcomes).toEqual([{ status: "cancelled" }]);
  });
});

describe("ProviderAuthService — reading the CLI", () => {
  it("waits for a link to be complete, and accepts it once the output goes quiet", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    flow.pty.emitData(`visit: ${CLAUDE_URL.slice(0, 80)}`);
    flow.pty.emitData(CLAUDE_URL.slice(80));
    expect(flow.prompts).toEqual([]);

    harness.clock.advance(1_500);
    expect(flow.prompts.map((prompt) => prompt.url)).toEqual([CLAUDE_URL]);
  });

  it("finds a link at the start of a chunk larger than the buffer it keeps", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    flow.pty.emitData(`${CLAUDE_LOGIN_OUTPUT}\r\n${"·".repeat(20_000)}\r\n`);
    expect(flow.prompts.map((prompt) => prompt.url)).toEqual([CLAUDE_URL]);
  });

  it("does not replace the provider's sign-in link with an unrelated one", async () => {
    const harness = makeHarness();
    const flow = await startFlow(harness, "claude");

    flow.pty.emitData(CLAUDE_LOGIN_OUTPUT);
    flow.pty.emitData(`\r\n${"·".repeat(20_000)}\r\nNeed help? https://example.com/help\r\n`);
    // By now the sign-in link has scrolled out of the buffer; only the help link is left in it.
    flow.pty.emitData("Still waiting…\r\n");
    harness.clock.advance(1_500);
    expect(flow.prompts.map((prompt) => prompt.url)).toEqual([CLAUDE_URL]);
  });

  it("tells the listener when no sign-in link has appeared after 30 seconds", async () => {
    const harness = makeHarness();
    const silent = await startFlow(harness, "claude");
    silent.pty.emitData("Welcome to a CLI whose output we cannot read\r\n");
    harness.clock.advance(30_000);
    expect(silent.events).toEqual(["stalled"]);

    const fine = await startFlow(harness, "codex");
    fine.pty.emitData(CODEX_LOGIN_OUTPUT);
    harness.clock.advance(30_000);
    expect(fine.events).toEqual(["prompt"]);
  });

  it("keeps running when a listener throws", async () => {
    const harness = makeHarness();
    const outcomes: string[] = [];
    const result = await harness.service.start("claude", {
      onPrompt: () => { throw new Error("render failed"); },
      onSettled: async (outcome) => { outcomes.push(outcome.status); throw new Error("render failed"); },
    });
    expect(result.ok).toBe(true);
    const pty = harness.ptys[0];

    pty.emitData(CLAUDE_LOGIN_OUTPUT);
    pty.emitExit(0);
    await settle();
    expect(outcomes).toEqual(["succeeded"]);
  });
});

describe("ProviderAuthService — secrets", () => {
  it("logs the course of a login without the link, the codes, or the CLI's output", async () => {
    const harness = makeHarness();

    const claude = await startFlow(harness, "claude");
    claude.pty.emitData(CLAUDE_LOGIN_OUTPUT);
    harness.service.submitInput("claude", claude.flowId, "not-a-code token=super-secret-value");
    harness.service.submitInput("claude", claude.flowId, `http://localhost:58741/callback?code=${OAUTH_CODE}&state=${OAUTH_STATE}`);
    claude.pty.emitData(`${OAUTH_CODE}#${OAUTH_STATE}\r\nLogin successful for operator@example.com\r\n`);
    claude.pty.emitExit(0);
    await settle();

    const codex = await startFlow(harness, "codex");
    codex.pty.emitData(CODEX_LOGIN_OUTPUT);
    harness.clock.advance(FLOW_TTL_MS);
    await settle();

    const failing = await startFlow(harness, "codex");
    failing.pty.emitData(CODEX_LOGIN_OUTPUT);
    failing.pty.emitExit(1);
    harness.spawnPty.mockImplementationOnce(() => { throw new Error(`cannot open ${CLAUDE_URL}`); });
    await harness.service.start("claude", makeListener().listener);
    await settle();

    expect(harness.logged.length).toBeGreaterThan(5);
    const everything = harness.logged.join("\n");
    for (const secret of [
      CLAUDE_URL, "claude.ai/oauth", "state123", "challenge123", OAUTH_CODE, OAUTH_STATE,
      CODEX_DEVICE_CODE, CODEX_URL, "super-secret-value", "operator@example.com", "localhost:58741",
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(everything).not.toMatch(/https?:\/\//);
  });
});
