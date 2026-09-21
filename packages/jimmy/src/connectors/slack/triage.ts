/**
 * Air-reading triage runner for Slack.
 *
 * Uses the existing lightweight CLI classifier or opt-in native Jev choices
 * to decide whether an incoming message should be ignored, acknowledged with
 * an emoji, or dispatched to a full engine session. Dispatch grants no new
 * permission to execute tools or external actions.
 *
 * This sits BEFORE the main session manager and prevents the expensive
 * engine from running on messages that don't actually want a reply.
 */

import { spawn } from "node:child_process";
import { logger } from "../../shared/logger.js";
import {
  defaultBinForEngine,
  defaultModelForEngine,
  invokeOneShot,
  type OneShotEngine,
} from "../../shared/oneShotCli.js";
import {
  buildTriagePrompt,
  parseTriageDecision,
  type TriageDecision,
  type TriagePromptInput,
} from "./triage-prompt.js";
import {
  evaluateJevTriage,
  protectJevTriageDecision,
  resolveJevUncertaintyDecision,
  type JevTriageOptions,
  type JevTriageResult,
} from "./triage-jev.js";

export interface TriageRunnerOptions {
  /** Default cli preserves existing behavior. Shadow never chooses the live action. */
  backend?: "cli" | "jev-shadow" | "jev";
  jev?: JevTriageOptions;
  /** CLI engine to use for triage. Defaults to "codex"; "claude" is supported. */
  engine?: OneShotEngine;
  /** Binary to invoke — defaults to the selected engine's CLI. */
  bin?: string;
  /** Model to use for the triage call (e.g. "claude-haiku-4-5" or "gpt-5-nano") */
  model?: string;
  /** Soft timeout before we fall back to the fail-open action */
  timeoutMs?: number;
  /** Override the spawner (for tests) */
  spawnImpl?: typeof spawn;
  /**
   * Action to fall back to when triage itself fails (timeout / spawn error /
   * unparseable output). Defaults to "reply" because in the most dangerous
   * scenario — our bot_user_id didn't load and so @-mentions silently slip
   * through to triage — missing a real question is worse than a stray reply.
   *
   * Callers that *know* the message is ambient (not a DM, not an @-mention,
   * not addressed to us) should pass "silent" instead: in that path a
   * fail-open reply is guaranteed to barge into someone else's conversation.
   */
  failOpenAction?: "reply" | "silent";
}

// Triage spawns a CLI which has a 3–5s startup overhead before it
// even hits the API; combined with Haiku latency variance, an 8s budget was
// causing routine timeouts in production. 30s gives headroom for slow days
// while still being short enough that the user notices triage isn't free.
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Run a triage decision. Jev-only mode never starts a CLI, even on uncertainty
 * or transport failure. CLI fallback is explicit opt-in; shadow always uses
 * the legacy action. Direct conversations cannot be silently dropped by Jev.
 */
export async function runTriage(
  input: TriagePromptInput,
  options: TriageRunnerOptions = {},
): Promise<TriageDecision> {
  if (options.backend === "jev-shadow") {
    // Start both immediately. Awaiting only the CLI keeps the shadow transport,
    // including stalled response bodies, off the user-visible response path.
    const observed = evaluateJevTriage(input, options.jev);
    const legacy = runCliTriage(input, options);
    void Promise.all([observed, legacy]).then(([result, actual]) => {
      logJevResult("shadow", result, actual);
    }).catch(() => {
      logger.warn("[triage:jev:shadow] observation_error");
    });
    return legacy;
  }
  if (options.backend === "jev") {
    const result = await evaluateJevTriage(input, options.jev);
    if (result.status === "accepted") {
      logJevResult("active", result);
      return result.decision;
    }
    if (options.jev?.fallback !== "cli") {
      const decision = resolveJevUncertaintyDecision(input, result, options.failOpenAction);
      logJevResult("active", result, undefined, decision);
      return decision;
    }
    logJevResult("active", result);
    // Retain the caller's ambient-vs-addressed failOpenAction if the CLI also
    // fails; direct conversations and task go-aheads still cannot be ghosted.
    return protectJevTriageDecision(input, await runCliTriage(input, options));
  }
  return runCliTriage(input, options);
}

function logJevResult(mode: "shadow" | "active", result: JevTriageResult, actual?: TriageDecision, uncertaintyDecision?: TriageDecision): void {
  logger.info(`[triage:jev:${mode}] ${JSON.stringify({
    status: result.status,
    ...result.metadata,
    ...(result.status === "accepted" ? { action: result.decision.action } : { reason: result.reason }),
    ...(uncertaintyDecision ? { uncertaintyAction: uncertaintyDecision.action, uncertaintyReason: uncertaintyDecision.reason, cliFallback: false } : {}),
    ...(actual ? {
      actualAction: actual.action,
      disagreed: result.status === "accepted"
        ? result.decision.action !== actual.action || (actual.action === "react" && result.decision.emoji !== actual.emoji)
        : undefined,
    } : {}),
  })}`);
}

async function runCliTriage(
  input: TriagePromptInput,
  options: TriageRunnerOptions,
): Promise<TriageDecision> {
  const prompt = buildTriagePrompt(input);
  const engine = options.engine ?? "codex";
  const bin = options.bin || defaultBinForEngine(engine);
  const model = options.model || defaultModelForEngine(engine);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnImpl || spawn;
  const failOpenAction = options.failOpenAction ?? "reply";

  try {
    const output = await invokeOneShot(prompt, {
      engine,
      bin,
      model,
      timeoutMs,
      spawnFn,
      label: "triage",
      classificationOnly: true,
    });
    const decision = parseTriageDecision(output);
    if (!decision) {
      logger.warn(`[triage] unparseable output, defaulting to ${failOpenAction.toUpperCase()} (fail-open)`);
      return { action: failOpenAction, reason: "parse_failed" };
    }
    return decision;
  } catch {
    logger.warn(`[triage] execution failed, defaulting to ${failOpenAction.toUpperCase()} (fail-open)`);
    return { action: failOpenAction, reason: "triage_error" };
  }
}
