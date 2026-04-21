import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { runTriage } from "../triage.js";

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
}) {
  return () => {
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
});
