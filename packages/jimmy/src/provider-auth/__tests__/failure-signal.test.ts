import { afterEach, describe, expect, it, vi } from "vitest";
import { detectProviderAuthFailure, onProviderAuthFailure, reportEngineAttempt } from "../failure-signal.js";

describe("detectProviderAuthFailure", () => {
  // What the engines report today.
  it.each([
    // The interactive engine: the Stop hook's error enum, verbatim.
    ["claude", "Interactive turn failed: authentication_failed"],
    // `claude -p` (Claude Code 2.1.x): every lost-login failure opens with "Failed to authenticate".
    ["claude", "Failed to authenticate: OAuth session expired and could not be refreshed"],
    ["claude", "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator."],
    ["claude", 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}'],
    ["claude", "Failed to authenticate. API Error: 401 Invalid authentication credentials"],
    ["claude", "Claude exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed"],
    ["codex", 'unexpected status 401 Unauthorized: {"error":{"message":"Provided authentication token is expired. Please try signing in again.","code":"token_expired"}}'],
    ["codex", "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."],
    ["codex", "Codex exited with code 1: Error: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"],
    ["codex", "Codex exited with code 1: Not logged in. Run `codex login` to sign in."],
  ] as const)("recognizes a %s login failure: %s", (engine, error) => {
    expect(detectProviderAuthFailure({ engine, error })).toBe(engine);
  });

  // Wordings of older Claude Code versions. Kept so that an instance whose CLI
  // has not been updated still gets the notice; not what a current CLI prints.
  it.each([
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Invalid API key · Please run /login",
    "Not logged in · Please run /login",
    "Claude exited with code 1: Invalid API key · Please run /login",
  ])("still recognizes an older Claude CLI's wording: %s", (error) => {
    expect(detectProviderAuthFailure({ engine: "claude", error })).toBe("claude");
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

  // A non-fatal `error` item from an MCP server ends up in the Codex engine's
  // error text even when the turn itself succeeded.
  it.each([
    "MCP server `linear` returned HTTP 401 Unauthorized",
    "mcp tool call failed: 401 Unauthorized (github)",
    "request to https://internal.example/api failed with 401 unauthorized",
  ])("does not read an MCP server's own 401 as a lost Codex login: %s", (error) => {
    expect(detectProviderAuthFailure({ engine: "codex", error })).toBeNull();
  });

  // Anyone who can talk to the bot can choose the next turn's model with
  // `/model <name>`, and a failure that quotes that name must not be able to
  // summon a "log in again" notice to the operator.
  it.each([
    ["codex", `unexpected status 400 Bad Request: {"detail":"The 'token_expired' model is not supported when using Codex with a ChatGPT account."}`],
    ["codex", "unexpected status 404 Not Found: The model `unexpected status 401` does not exist"],
    ["codex", "The model 'Your access token could not be refreshed' does not exist or you do not have access to it."],
    ["codex", "unsupported model: sign in again"],
    ["codex", "Codex exited with code 1: error: unknown model `codex login`"],
    ["codex", "invalid model: Not logged in"],
    ["claude", 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: authentication_error"}}'],
    ["claude", "There's an issue with the selected model (authentication_failed). It may not exist or you may not have access to it."],
    ["claude", "Unknown model: Please run /login"],
    ["claude", 'Model "Invalid API key" was not found'],
    ["claude", "Interactive turn failed: invalid_request (model: authentication_failed)"],
    ["claude", 'Model "Failed to authenticate" was not found'],
    ["claude", 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: Failed to authenticate"}}'],
    ["claude", "Unknown model: failed to authenticate. API Error: 401"],
    ["claude", "Claude exited with code 1: error: model 'OAuth token has expired' not found"],
  ] as const)("is not triggered by a %s failure that merely quotes a chosen string: %s", (engine, error) => {
    expect(detectProviderAuthFailure({ engine, error })).toBeNull();
  });

  it("ignores engines it cannot log in, and turns that ran on another host", () => {
    const error = "Interactive turn failed: authentication_failed";
    expect(detectProviderAuthFailure({ engine: "gemini", error })).toBeNull();
    expect(detectProviderAuthFailure({ engine: "claude", error, remote: true })).toBeNull();
  });

  it("does not answer a Claude signature for Codex, or the reverse", () => {
    expect(detectProviderAuthFailure({ engine: "codex", error: "Interactive turn failed: authentication_failed" })).toBeNull();
    expect(detectProviderAuthFailure({ engine: "codex", error: "Failed to authenticate: OAuth session expired and could not be refreshed" })).toBeNull();
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
