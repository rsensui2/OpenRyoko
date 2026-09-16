import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { spawn } from "node:child_process";
import { invokeOneShot } from "../oneShotCli.js";

function setup(engine: "codex" | "claude") {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = vi.fn();
  const spawnFn = vi.fn().mockReturnValue(proc);
  const promise = invokeOneShot("--untrusted input", { engine, bin: engine, model: "test-model", timeoutMs: 100,
    classificationOnly: true, label: "test", spawnFn: spawnFn as unknown as typeof spawn });
  return { proc, spawnFn, promise, cwd: spawnFn.mock.calls[0][2].cwd as string, args: spawnFn.mock.calls[0][1] as string[] };
}

afterEach(() => vi.useRealTimers());

describe("isolated classification CLI", () => {
  it.each(["codex", "claude"] as const)("disables operational tools and cleans the isolated %s directory", async (engine) => {
    const { proc, args, promise, cwd } = setup(engine);
    expect(fs.existsSync(cwd)).toBe(true);
    expect(args.slice(-2)).toEqual(["--", "--untrusted input"]);
    expect(args.join(" ")).not.toContain("dangerously");
    if (engine === "codex") {
      expect(args).toEqual(expect.arrayContaining(["read-only", "--ignore-user-config", "--ignore-rules", "shell_tool", "apps", "goals", "hooks"]));
      proc.stdout.emit("data", Buffer.from([
        { type: "item.completed", item: { type: "agent_message", text: "preliminary" } },
        { type: "item.completed", item: { type: "agent_message", text: '{"condition":null}' } },
      ].map((v) => JSON.stringify(v)).join("\n")));
    } else {
      expect(args[args.indexOf("--tools") + 1]).toBe("");
      expect(args).toContain("--safe-mode");
      expect(args).toContain("--strict-mcp-config");
      proc.stdout.emit("data", Buffer.from(JSON.stringify({ result: '{"condition":null}' })));
    }
    proc.emit("close", 0);
    expect(await promise).toBe('{"condition":null}');
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("kills a timed-out classifier and cleans its directory", async () => {
    vi.useFakeTimers();
    const { proc, cwd, promise } = setup("codex");
    const check = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await check;
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("rejects abnormal exits instead of accepting a JSON verdict", async () => {
    const { proc, promise } = setup("codex");
    proc.stdout.emit("data", Buffer.from('{"status":"continue"}'));
    proc.emit("close", 1);
    await expect(promise).rejects.toThrow("exited 1");
  });
});
