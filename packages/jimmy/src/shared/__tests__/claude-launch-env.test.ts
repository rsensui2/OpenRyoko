import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every place the gateway or the CLI launches Claude LOCALLY must put the
 * CLAUDE_LOCAL_ENV guards (DISABLE_LOGOUT_COMMAND) on the child's environment.
 * This enumerates the launch sites so a new one that forgets them is noticed.
 *
 *   1. interactive PTY        engines/claude-interactive.ts  buildClaudePtyEnv  — here
 *   2. one-shot classifier    shared/oneShotCli.ts           invokeOneShot      — here
 *   3. migration run          cli/migrate.ts                 migrateChildEnv    — here
 *   4. headless `claude -p`   engines/claude.ts              ClaudeEngine.run   — claude-auto-memory-wiring.test.ts
 *   5. session fork           sessions/fork.ts               forkClaudeSession  — claude-auto-memory-wiring.test.ts
 *
 * A remote (sshHost) run is deliberately NOT guarded; that exclusion is pinned
 * in claude-auto-memory-wiring.test.ts.
 */

// buildClaudePtyEnv lives in a module that loads node-pty at import time.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../resolveBin.js", () => ({
  resolveBin: (bin: string) => `/usr/local/bin/${bin}`,
  formatSpawnError: (label: string, bin: string, err: Error) => `${label} ${bin}: ${err.message}`,
}));

import { CLAUDE_LOCAL_ENV } from "../childEnv.js";
import { buildClaudePtyEnv } from "../../engines/claude-interactive.js";
import { migrateChildEnv } from "../../cli/migrate.js";
import { invokeOneShot, type OneShotEngine } from "../oneShotCli.js";

/** Every CLAUDE_LOCAL_ENV key/value is present in `env`. */
function carriesGuards(env: Record<string, string | undefined> | undefined): boolean {
  return !!env && Object.entries(CLAUDE_LOCAL_ENV).every(([key, value]) => env[key] === value);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("CLAUDE_LOCAL_ENV", () => {
  it("is exactly the /logout guard — adding to it is a deliberate change", () => {
    expect({ ...CLAUDE_LOCAL_ENV }).toEqual({ DISABLE_LOGOUT_COMMAND: "1" });
  });
});

describe("the local Claude launch sites carry the guards", () => {
  it("1. interactive PTY (buildClaudePtyEnv)", () => {
    expect(carriesGuards(buildClaudePtyEnv(undefined, { PATH: "/bin" }))).toBe(true);
  });

  it("3. migration run (migrateChildEnv), and never a non-Claude engine", () => {
    expect(carriesGuards(migrateChildEnv("claude", "/srv/.ryoko"))).toBe(true);
    expect(carriesGuards(migrateChildEnv("codex", "/srv/.ryoko") as Record<string, string>)).toBe(false);
  });

  it.each<[OneShotEngine, boolean]>([["claude", true], ["codex", false]])(
    "2. one-shot %s classifier (invokeOneShot)", async (engine, expected) => {
      let captured: Record<string, string> | undefined;
      const spawnFn = ((_bin: string, _args: string[], options: { env: Record<string, string> }) => {
        captured = options.env;
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();
        proc.pid = 4242;
        setImmediate(() => {
          proc.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok" })));
          proc.emit("close", 0);
        });
        return proc;
      }) as never;

      await invokeOneShot("classify", { engine, bin: engine, model: "m", timeoutMs: 5000, label: "test", spawnFn });

      expect(carriesGuards(captured)).toBe(expected);
    });
});
