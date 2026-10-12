import { afterEach, describe, expect, it, vi } from "vitest";
import { detectProviderAuthFailure, onProviderAuthFailure, reportEngineAttempt } from "../failure-signal.js";

describe("detectProviderAuthFailure", () => {
  it.each([
    ["claude", "Interactive turn failed: authentication_failed"],
    ["claude", 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}'],
    ["claude", "OAuth token has expired. Please obtain a new token or refresh your existing token."],
    ["claude", "Invalid API key · Please run /login"],
    ["codex", 'unexpected status 401 Unauthorized: {"error":{"message":"Provided authentication token is expired. Please try signing in again.","code":"token_expired"}}'],
    ["codex", "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."],
    ["codex", "Codex exited with code 1: Not logged in. Run `codex login` to sign in."],
  ] as const)("recognizes a %s login failure: %s", (engine, error) => {
    expect(detectProviderAuthFailure({ engine, error })).toBe(engine);
  });

  it.each([
    ["claude", "Interactive turn failed: rate_limit"],
    ["claude", "Interactive turn failed: server_error"],
    ["claude", "⛔ HTTP 401 from an unrelated MCP server"],
    ["claude", "⛔ unrelated MCP: browser is not logged in"],
    ["claude", "The OAuth section of the design doc mentions credential rotation; hit max turns"],
    ["codex", "MCP client for `linear` failed to start: OAuth credentials missing (403 Forbidden)"],
    ["codex", "You've hit your usage limit. Try again at 3:00 PM."],
    ["codex", "Interrupted: Engine response timeout"],
    ["claude", ""],
    ["claude", undefined],
  ] as const)("does not mistake an unrelated %s failure for a login failure: %s", (engine, error) => {
    expect(detectProviderAuthFailure({ engine, error })).toBeNull();
  });

  it("ignores engines it cannot log in, and turns that ran on another host", () => {
    const error = "Interactive turn failed: authentication_failed";
    expect(detectProviderAuthFailure({ engine: "gemini", error })).toBeNull();
    expect(detectProviderAuthFailure({ engine: "claude", error, remote: true })).toBeNull();
  });

  it("does not answer a Claude signature for Codex, or the reverse", () => {
    expect(detectProviderAuthFailure({ engine: "codex", error: "Interactive turn failed: authentication_failed" })).toBeNull();
    expect(detectProviderAuthFailure({ engine: "claude", error: "unexpected status 401 Unauthorized" })).toBeNull();
  });
});

describe("reportEngineAttempt", () => {
  const subscriptions: Array<() => void> = [];
  afterEach(() => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); });
  const subscribe = (listener: (provider: "claude" | "codex") => void) => { subscriptions.push(onProviderAuthFailure(listener)); };

  it("tells subscribers which provider failed", () => {
    const seen = vi.fn();
    subscribe(seen);

    reportEngineAttempt("claude", { sshHost: undefined }, { error: "Interactive turn failed: authentication_failed" });
    reportEngineAttempt("codex", {}, { error: "unexpected status 401 Unauthorized: token_expired" });
    reportEngineAttempt("claude", {}, { error: undefined });
    reportEngineAttempt("claude", {}, { error: "Interactive turn failed: rate_limit" });
    reportEngineAttempt("claude", { sshHost: "build-box" }, { error: "Interactive turn failed: authentication_failed" });

    expect(seen.mock.calls).toEqual([["claude"], ["codex"]]);
  });

  it("stops telling a subscriber that has unsubscribed", () => {
    const seen = vi.fn();
    const unsubscribe = onProviderAuthFailure(seen);
    unsubscribe();

    reportEngineAttempt("claude", {}, { error: "Interactive turn failed: authentication_failed" });
    expect(seen).not.toHaveBeenCalled();
  });

  it("never lets an observer break the turn that reported", () => {
    const later = vi.fn();
    subscribe(() => { throw new Error("observer failed"); });
    subscribe(later);

    expect(() => reportEngineAttempt("claude", {}, { error: "Interactive turn failed: authentication_failed" })).not.toThrow();
    expect(() => reportEngineAttempt("claude", undefined, undefined)).not.toThrow();
    expect(later).toHaveBeenCalledExactlyOnceWith("claude");
  });
});
