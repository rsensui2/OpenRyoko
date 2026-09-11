import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { JINN_HOME } from "../../shared/paths.js";
import { runCommand, stopCommandJobs, validateCommandJob } from "../command.js";
import { runCronJob } from "../runner.js";
import type { CronJob, JinnConfig, Connector } from "../../shared/types.js";
import type { SessionManager } from "../../sessions/manager.js";

const job = (script: string, extra: Partial<CronJob> = {}): CronJob => ({
  id: randomUUID(), name: "test command", enabled: true, schedule: "* * * * *", kind: "command", prompt: "",
  command: { executable: process.execPath, args: ["-e", script], timeoutSeconds: 5 }, ...extra,
});

describe("command cron", () => {
  it("surfaces a lock from a previous gateway instead of silently skipping forever", async () => {
    const j = job("throw new Error('must not execute')");
    const dir = path.join(JINN_HOME, "cron", "commands", createHash("sha256").update(j.id).digest("hex").slice(0, 24));
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, "running.lock");
    fs.writeFileSync(lock, JSON.stringify({ gatewayPid: process.pid, lockOwner: "previous-instance" }));
    try {
      expect(await runCommand(j)).toMatchObject({ status: "error", reason: "command-lock-needs-review" });
      expect(fs.existsSync(lock)).toBe(true);
    } finally { fs.unlinkSync(lock); }
  });
  it("runs a literal argument vector and captures a private log", async () => {
    const j = job("process.stdout.write(process.argv[1])");
    j.command!.args!.push("$(touch should-not-exist); `echo nope`");
    const result = await runCommand(j);
    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(result.logFile!, "utf8")).toBe("$(touch should-not-exist); `echo nope`");
    expect(fs.statSync(result.logFile!).mode & 0o777).toBe(0o600);
  });
  it("does not route successful commands through an AI or send success notifications", async () => {
    const route = vi.fn(); const sendMessage = vi.fn();
    const config = { cron: { alertConnector: "slack", alertChannel: "alerts" } } as JinnConfig;
    await runCronJob(job("console.log('NO_NEW_LEADS')"), { route } as unknown as SessionManager,
      config, new Map([["slack", { sendMessage } as unknown as Connector]]));
    expect(route).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
  });
  it("reports nonzero exit once, without leaking stdout into the alert", async () => {
    const route = vi.fn(); const sendMessage = vi.fn().mockResolvedValue("sent");
    await runCronJob(job("console.log('private data'); process.exit(7)", {
      failureDelivery: { connector: "slack", channel: "alerts" },
    }), { route } as unknown as SessionManager, {} as JinnConfig,
    new Map([["slack", { sendMessage } as unknown as Connector]]));
    expect(route).not.toHaveBeenCalled(); expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toContain("exited 7");
    expect(sendMessage.mock.calls[0][1]).not.toContain("private data");
  });
  it("rejects overlapping executions and releases the lock after completion", async () => {
    const j = job("setTimeout(() => {}, 150)");
    const first = runCommand(j);
    expect((await runCommand(j)).reason).toBe("command-locked");
    expect((await first).status).toBe("success");
    expect((await runCommand(j)).status).toBe("success");
  });
  it("fails a missing executable and leaves the job retryable", async () => {
    const j = job("", { command: { executable: "/does/not/exist" } });
    expect((await runCommand(j)).status).toBe("error");
    expect((await runCommand(j)).status).toBe("error");
  });
  it("bounds output and times out a process that ignores SIGTERM", async () => {
    const j = job("process.stdout.write('x'.repeat(1500000)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)");
    j.command!.timeoutSeconds = 1;
    const result = await runCommand(j);
    expect(result.status).toBe("error"); expect(result.timedOut).toBe(true);
    expect(fs.statSync(result.logFile!).size).toBeLessThanOrEqual(1024 * 1024);
  }, 8000);
  it("validates executable, arguments, cwd and timeout before spawning", () => {
    for (const command of [
      { executable: "python3" }, { executable: "/bin/echo", args: "hello" },
      { executable: "/bin/echo", cwd: "relative" }, { executable: "/bin/echo", timeoutSeconds: 0 },
    ]) expect(validateCommandJob({ kind: "command", command } as CronJob)).toBeTruthy();
    for (const failureDelivery of [false, 0, "", [], { connector: "slack" }]) {
      expect(validateCommandJob({ ...job(""), failureDelivery } as unknown as CronJob)).toBeTruthy();
    }
    expect(validateCommandJob(job("", { failureDelivery: null }))).toBeUndefined();
  });
  it("settles running commands before gateway shutdown and releases their locks", async () => {
    const j = job("setInterval(()=>{},1000)");
    const running = runCommand(j);
    await stopCommandJobs();
    expect((await running).error).toContain("gateway shutdown");
    j.command!.args = ["-e", "process.exit(0)"];
    expect((await runCommand(j)).status).toBe("success");
  });
  it("stops the process and reports a log write failure without crashing the gateway", async () => {
    const original = fs.writeSync;
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      if (Buffer.isBuffer(args[1])) throw new Error("disk full");
      return Reflect.apply(original, fs, args);
    }) as typeof fs.writeSync);
    try {
      const result = await runCommand(job("console.log('output'); setInterval(()=>{},1000)"));
      expect(result.status).toBe("error");
      expect(result.error).toBe("Could not persist command output");
    } finally { spy.mockRestore(); }
  });
});
