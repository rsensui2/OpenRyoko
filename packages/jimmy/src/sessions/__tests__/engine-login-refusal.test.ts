import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isUsableFallbackTarget, noteEngineTurnOutcome } from "../engine-health-gate.js";
import {
  _resetEngineLoginKnowledge,
  confirmLoginRefusal,
  hasServedATurn,
  isLoginRefusal,
  loginRefusalConfirmed,
} from "../engine-login.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineResult, JinnConfig } from "../../shared/types.js";

const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-10-12T03:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-opus-5" },
  codex: { bin: "codex-bin", model: "gpt-5.6-sol" } }, connectors: {} } as unknown as JinnConfig;

const failed = (error: string, extra: Partial<EngineResult> = {}): EngineResult => ({ sessionId: "", result: "", error, ...extra });
const served: EngineResult = { sessionId: "s", result: "Done." };

beforeEach(() => {
  fs.rmSync(STATE_PATH, { force: true });
  _resetEngineLoginKnowledge();
});

describe("isLoginRefusal — an engine that is installed but cannot sign in", () => {
  // The wordings are the installed CLIs' own (claude and codex 0.162, read
  // from the binaries), in the two shapes this gateway's engines report them.
  it.each([
    ["claude -p, never signed in", "Not logged in · Please run /login"],
    ["claude -p, login lapsed", "Login expired · Please run /login"],
    ["claude -p, token revoked", "OAuth token revoked · Please run /login"],
    ["claude -p, generic", "Failed to authenticate. · Please run /login"],
    ["claude -p, session needs renewing", "Authentication required · Sign in again to continue"],
    ["claude -p, bad external key", "Invalid API key · Fix external API key"],
    ["claude -p, bad external token", "Invalid auth token · Fix external auth token"],
    ["claude print mode", "Not logged in. Run claude auth login to authenticate."],
    ["codex, never signed in", "Codex exited with code 1: Not logged in"],
    ["codex, no credentials", "Codex exited with code 1: no Codex credentials were found\nRun codex login or provide an API key through a supported auth env var."],
    ["codex, refresh token expired", "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again."],
    ["codex, account id missing", "ChatGPT account ID not available, please re-run `codex login`"],
    ["codex, API said no", "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"],
  ])("recognises %s", (_label, error) => {
    expect(isLoginRefusal(failed(error))).toBe(true);
  });

  it("recognises the interactive Claude PTY's own code, whatever turn count it reports", () => {
    expect(isLoginRefusal(failed("Interactive turn failed: authentication_failed", { numTurns: 1 }))).toBe(true);
  });

  it.each([
    ["a usage limit", failed("Interactive turn failed: rate_limit", { numTurns: 1, rateLimit: { status: "rejected" } })],
    ["throttling that mentions credentials", failed("429 Too Many Requests: unauthorized burst")],
    ["an overloaded provider", failed("overloaded_error: upstream authentication service busy")],
    ["a network fault", failed("fetch failed: ECONNRESET while authenticating")],
    ["a timeout", failed("Engine response timeout")],
    ["an unrelated crash", failed("Codex exited with code 1: stream disconnected before completion")],
    ["another PTY failure code", failed("Interactive turn failed: server_error", { numTurns: 1 })],
    ["a stop the application asked for", failed("Interrupted: stopped", { retryable: false })],
    ["a failure after real work", failed("tool failed: 403 Forbidden from the deploy API", { cost: 0.42, numTurns: 3 })],
    ["a failure after completed turns", failed("credential helper exited", { numTurns: 2 })],
    ["an answer that talks about signing in", { sessionId: "s", result: "Run `codex login` to sign in, then retry." }],
    ["an answer delivered with a warning", { sessionId: "s", result: "Here is the summary.", error: "Not logged in · Please run /login" }],
  ] as [string, EngineResult][])("does not mistake %s for one", (_label, result) => {
    expect(isLoginRefusal(result)).toBe(false);
  });
});

describe("what a login refusal does to an engine's standing", () => {
  const refuse = (engine: string, now: Date) => noteEngineTurnOutcome(engine, failed("Not logged in · Please run /login"), undefined, now);

  it("is not believed on a single refusal: signing in can fail once and work the next moment", () => {
    refuse("codex", NOW);

    expect(loginRefusalConfirmed("codex", NOW)).toBe(false);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", NOW)).toBe(true);
  });

  it("is believed after two in a row, and keeps the engine out of fallback for thirty minutes", () => {
    refuse("codex", NOW);
    refuse("codex", at(1));

    expect(loginRefusalConfirmed("codex", at(1))).toBe(true);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", at(1))).toBe(false);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", at(30))).toBe(false);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", at(31))).toBe(true);
    expect(isUsableFallbackTarget(config, "claude", "claude-opus-5", at(1))).toBe(true);
  });

  it("can be confirmed outright by a caller that has already tried twice itself", () => {
    confirmLoginRefusal("codex", NOW);

    expect(loginRefusalConfirmed("codex", NOW)).toBe(true);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", at(5))).toBe(false);
  });

  it("is forgotten the moment the engine serves a turn", () => {
    refuse("codex", NOW);
    refuse("codex", at(1));

    noteEngineTurnOutcome("codex", served, "gpt-5.6-sol", at(2));

    expect(loginRefusalConfirmed("codex", at(2))).toBe(false);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", at(2))).toBe(true);
  });

  it("does not add up refusals that are an hour apart", () => {
    refuse("codex", NOW);
    refuse("codex", at(60));

    expect(loginRefusalConfirmed("codex", at(60))).toBe(false);
  });
});

describe("hasServedATurn — the proof a session needs before it is started on an engine", () => {
  it("holds once the engine has answered, and is withdrawn by a refusal", () => {
    expect(hasServedATurn("codex")).toBe(false);

    noteEngineTurnOutcome("codex", served, "gpt-5.6-sol", NOW);
    expect(hasServedATurn("codex")).toBe(true);

    noteEngineTurnOutcome("codex", failed("Not logged in · Please run /login"), undefined, at(1));
    expect(hasServedATurn("codex")).toBe(false);
  });

  it("is not given by a failure of any other kind, nor taken away by one", () => {
    noteEngineTurnOutcome("codex", failed("Engine response timeout"), undefined, NOW);
    expect(hasServedATurn("codex")).toBe(false);

    noteEngineTurnOutcome("codex", served, "gpt-5.6-sol", at(1));
    noteEngineTurnOutcome("codex", failed("Usage limit reached"), undefined, at(2));
    expect(hasServedATurn("codex")).toBe(true);
  });
});
