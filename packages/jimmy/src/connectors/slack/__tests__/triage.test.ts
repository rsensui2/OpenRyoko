import { afterEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runTriage } from "../triage.js";
import { JEV_TRIAGE_QUESTIONS } from "../triage-jev.js";
import { logger } from "../../../shared/logger.js";

/**
 * Build a fake spawn that simulates `claude -p --output-format json` and
 * exposes stdout/stderr/close hooks so we can inject any scenario.
 */
function makeFakeSpawn(scenario: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  hangForever?: boolean;
  onSpawn?: (bin: string, args: string[]) => void;
}) {
  return (bin: string, args: string[]) => {
    scenario.onSpawn?.(bin, args);
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    setImmediate(() => {
      if (scenario.error) {
        proc.emit("error", scenario.error);
        return;
      }
      if (scenario.hangForever) return;
      if (scenario.stdout) proc.stdout.emit("data", Buffer.from(scenario.stdout));
      if (scenario.stderr) proc.stderr.emit("data", Buffer.from(scenario.stderr));
      proc.emit("close", scenario.exitCode ?? 0);
    });

    return proc;
  };
}

const baseInput = {
  botName: "Ryoko",
  channelType: "channel",
  channelDescription: "#general",
  speakerName: "Taro",
  speakerIsOperator: false,
  wasMentioned: false,
  recentThread: [],
  messageText: "hello",
};

function jevSilentResponse(): Response {
  const choices: Record<string, string> = {
    recipient: "other_human", intent: "statement", relation: "unrelated", response_value: "none", acknowledgment: "none",
  };
  return Response.json({
    model: "jev-1.13.0",
    answers: Object.fromEntries(Object.entries(JEV_TRIAGE_QUESTIONS).map(([axis, question]) => [axis, question.type === "noul" ? { type: "noul", noul: 0 } : {
      type: "choice", choice: choices[axis], confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === choices[axis] ? 1 : 0])),
    }])),
    usage: { input_tokens: 200, output_tokens: 30 },
  });
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("runTriage", () => {
  it("returns a reply decision when the model says so", async () => {
    const claudeEnvelope = JSON.stringify({
      type: "result",
      result: '{"action":"reply","reason":"test"}',
    });
    const decision = await runTriage(baseInput, {
      spawnImpl: makeFakeSpawn({ stdout: claudeEnvelope }) as any,
    });
    expect(decision.action).toBe("reply");
  });

  it("passes raw stdout through when not wrapped in a result envelope", async () => {
    const decision = await runTriage(baseInput, {
      spawnImpl: makeFakeSpawn({
        stdout: '{"action":"react","emoji":"thumbsup"}',
      }) as any,
    });
    expect(decision.action).toBe("react");
    expect(decision.emoji).toBe("thumbsup");
  });

  it("fails open to reply on non-zero exit (missing a reply is worse than a wrong reply)", async () => {
    const decision = await runTriage(baseInput, {
      spawnImpl: makeFakeSpawn({ exitCode: 2, stderr: "auth error" }) as any,
    });
    expect(decision).toEqual({ action: "reply", reason: "triage_error" });
  });

  it("fails open to reply on spawn error", async () => {
    const decision = await runTriage(baseInput, {
      spawnImpl: makeFakeSpawn({ error: new Error("ENOENT") }) as any,
    });
    expect(decision).toEqual({ action: "reply", reason: "triage_error" });
  });

  it("fails open to reply when output is unparseable", async () => {
    const decision = await runTriage(baseInput, {
      spawnImpl: makeFakeSpawn({
        stdout: JSON.stringify({ type: "result", result: "definitely not json" }),
      }) as any,
    });
    expect(decision).toEqual({ action: "reply", reason: "parse_failed" });
  });

  it("fails open to reply when the process times out", async () => {
    const decision = await runTriage(baseInput, {
      timeoutMs: 30,
      spawnImpl: makeFakeSpawn({ hangForever: true }) as any,
    });
    expect(decision).toEqual({ action: "reply", reason: "triage_error" });
  });

  it("can run through Codex with a lightweight model", async () => {
    let spawnedArgs: string[] = [];
    const codexJsonl = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: '{"action":"silent","reason":"ambient"}',
      },
    });
    const decision = await runTriage(baseInput, {
      engine: "codex",
      model: "gpt-5-nano",
      spawnImpl: makeFakeSpawn({
        stdout: codexJsonl,
        onSpawn: (_bin, args) => {
          spawnedArgs = args;
        },
      }) as any,
    });

    expect(spawnedArgs).toContain("exec");
    expect(spawnedArgs).toContain("--json");
    expect(spawnedArgs).toContain("gpt-5-nano");
    expect(decision).toEqual({ action: "silent", reason: "ambient" });
  });

  it("runs optional Claude classification without operational tools", async () => {
    let args: string[] = [];
    const decision = await runTriage(baseInput, {
      engine: "claude",
      spawnImpl: makeFakeSpawn({ stdout: '{"action":"silent"}', onSpawn: (_bin, spawned) => { args = spawned; } }) as any,
    });
    expect(decision.action).toBe("silent");
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("keeps the default backend on CLI even when Jev settings exist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const decision = await runTriage(baseInput, {
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fetchImpl },
      spawnImpl: makeFakeSpawn({ stdout: '{"action":"reply"}' }) as any,
    });
    expect(decision.action).toBe("reply");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses an accepted Jev decision without spawning a CLI", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "test-only-key");
    const spawnImpl = vi.fn() as any;
    const decision = await runTriage(baseInput, {
      backend: "jev",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jevSilentResponse()) },
      spawnImpl,
    });
    expect(decision.action).toBe("silent");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("retains the context-specific fail-open action if missing key and CLI both fail", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "");
    for (const failOpenAction of ["reply", "silent"] as const) {
      const decision = await runTriage(baseInput, {
        backend: "jev", failOpenAction,
        jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fallback: "cli" },
        spawnImpl: makeFakeSpawn({ error: new Error("ENOENT") }) as any,
      });
      expect(decision).toEqual({ action: failOpenAction, reason: "triage_error" });
    }
  });

  it("uses legacy classification after authentication failure, without logging provider text or keys", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "test-only-key");
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const decision = await runTriage({ ...baseInput, messageText: "private-message" }, {
      backend: "jev",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fallback: "cli", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("test-only-key private-message", { status: 401 })) },
      spawnImpl: makeFakeSpawn({ stdout: '{"action":"react","emoji":"eyes"}' }) as any,
    });
    expect(decision).toMatchObject({ action: "react", emoji: "eyes" });
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).toContain("http_error");
    expect(logged).not.toMatch(/test-only-key|private-message/);
  });

  it("does not ghost a DM or pending go-ahead when Jev and CLI fail", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "");
    for (const extra of [
      { dmEquivalent: true },
      { channelType: "im" },
      { messageText: "はい", previousWasSelf: true },
      { wasMentioned: true },
    ]) {
      const decision = await runTriage({ ...baseInput, ...extra }, {
        backend: "jev", failOpenAction: "silent",
        jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fallback: "cli" },
        spawnImpl: makeFakeSpawn({ error: new Error("ENOENT") }) as any,
      });
      expect(decision.action).toBe("reply");
    }
  });

  it("returns the CLI action without waiting for shadow and records later disagreement", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "test-only-key");
    const info = vi.spyOn(logger, "info");
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const decision = await runTriage({ ...baseInput, messageText: "private-message" }, {
      backend: "jev-shadow",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", timeoutMs: 1000, fetchImpl },
      spawnImpl: makeFakeSpawn({ stdout: '{"action":"react","emoji":"eyes"}' }) as any,
    });
    expect(decision).toMatchObject({ action: "react", emoji: "eyes" });
    expect(info).not.toHaveBeenCalled();
    resolveFetch(jevSilentResponse());
    await vi.waitFor(() => expect(info).toHaveBeenCalledOnce());
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("disagreed");
    expect(logged).toContain("true");
    expect(logged).not.toMatch(/test-only-key|private-message/);
    expect(decision.action).toBe("react");
  });

  it("does not mistake an old self-bot message in incomplete context for the immediate predecessor", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "test-only-key");
    const decision = await runTriage({ ...baseInput, messageText: "はい", previousWasSelf: true, contextIncomplete: true }, {
      backend: "jev",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY" },
      spawnImpl: makeFakeSpawn({ stdout: '{"action":"silent"}' }) as any,
    });
    expect(decision.action).toBe("silent");
  });

  it("shadow errors do not change the CLI action", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "test-only-key");
    const info = vi.spyOn(logger, "info");
    const decision = await runTriage(baseInput, {
      backend: "jev-shadow",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("test-only-key")) },
      spawnImpl: makeFakeSpawn({ stdout: '{"action":"silent"}' }) as any,
    });
    expect(decision.action).toBe("silent");
    await vi.waitFor(() => expect(info).toHaveBeenCalledOnce());
    expect(JSON.stringify(info.mock.calls)).not.toContain("test-only-key");
  });

  it.each(["missing_key", "timeout", "http_error", "ambiguous", "invalid_response"])("Jev-only never spawns a CLI on %s", async (failure) => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", failure === "missing_key" ? "" : "test-only-key");
    const fetchImpl = vi.fn<typeof fetch>();
    if (failure === "timeout") fetchImpl.mockImplementation(() => new Promise(() => {}));
    else if (failure === "http_error") fetchImpl.mockResolvedValue(new Response("auth", { status: 401 }));
    else if (failure === "invalid_response") fetchImpl.mockResolvedValue(Response.json({ invalid: true }));
    else if (failure === "ambiguous") {
      const body = await jevSilentResponse().json();
      body.answers.recipient.choice = "unknown";
      body.answers.recipient.probabilities = { bot: 0, other_human: 0, group: 0, unknown: 1 };
      fetchImpl.mockResolvedValue(Response.json(body));
    }
    const spawnImpl = vi.fn() as any;
    const decision = await runTriage(baseInput, {
      backend: "jev",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", timeoutMs: 10, fetchImpl },
      spawnImpl,
    });
    expect(decision).toMatchObject({ action: "silent", reason: "jev_uncertain_ambient" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each([
    { channelType: "im" },
    { dmEquivalent: true },
    { wasMentioned: true },
    { previousWasSelf: true, messageText: "続けて" },
    { messageText: "Ryoko、問い合わせを集計して" },
  ])("Jev-only preserves known directed requests without a CLI: %j", async (extra) => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "");
    const spawnImpl = vi.fn() as any;
    const decision = await runTriage({ ...baseInput, ...extra }, {
      backend: "jev", failOpenAction: "silent",
      jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY", fallback: "none" }, spawnImpl,
    });
    expect(decision.action).toBe("reply");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("Jev-only does not mistake a mention in a discussion for a direct address", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "");
    const spawnImpl = vi.fn() as any;
    const decision = await runTriage({ ...baseInput, messageText: "Ryokoが昨日作った資料について話しています" }, {
      backend: "jev", jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY" }, spawnImpl,
    });
    expect(decision.action).toBe("silent");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("Jev-only does not reopen completed work on an uncertain reaction", async () => {
    vi.stubEnv("JEV_RUNNER_TEST_KEY", "");
    const spawnImpl = vi.fn() as any;
    const reaction = { ...baseInput, channelType: "im", isReaction: true, messageText: "👍", previousWasSelf: true, conversationState: { status: "completed" as const } };
    const opts = { backend: "jev" as const, jev: { apiKeyEnv: "JEV_RUNNER_TEST_KEY" }, spawnImpl };
    expect(await runTriage(reaction, opts)).toMatchObject({ action: "silent", reason: "jev_uncertain_reaction" });
    expect(await runTriage({ ...reaction, conversationState: { status: "awaiting_input" } }, opts)).toMatchObject({ action: "silent" });
    expect(await runTriage({ ...reaction, reactionAnswersPendingQuestion: true, conversationState: { status: "awaiting_input" } }, opts)).toMatchObject({ action: "reply" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
