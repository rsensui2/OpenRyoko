/**
 * What the session layer knows about whether an engine can serve a turn, and
 * the only place it writes that knowledge down.
 *
 * `shared/engine-health.ts` is the store. This is the session layer's reading
 * of it, which is deliberately narrower than "something went wrong":
 *
 *  - Only a limit the engine itself declared, with a reset still ahead of us,
 *    is a known outage. A limit that named nothing — or a failure that merely
 *    reads like one — is recorded for display and never holds a turn back, so
 *    a transient 429 cannot steer every new session elsewhere.
 *  - A record is about the local account. A turn that ran over SSH on an
 *    employee's own machine says nothing about it, so callers do not report
 *    those here.
 *  - A turn that was actually served is evidence the record is stale, and
 *    forgets it.
 */

import { limitWindowBindsModel } from "../shared/claude-limit-reset.js";
import {
  clearEngineHealth,
  isEngineExhausted,
  readEngineHealth,
  recordEngineUnavailable,
  type EngineHealth,
  type EngineHealthState,
} from "../shared/engine-health.js";
import { detectRateLimit } from "../shared/rateLimit.js";
import type { EngineResult, JinnConfig } from "../shared/types.js";
import { isLoginRefusal, loginRefusalConfirmed, noteLoginRefusal, noteLoginWorked } from "./engine-login.js";

/** The reason recorded when the engine itself declared its allowance spent.
 *  The re-check timer recognises what it may ask the provider about by it. */
export function usageLimitReason(engine: string): string {
  return `${engine} usage limit`;
}

/** The reason recorded when the failure only reads like throttling. */
function throttledReason(engine: string): string {
  return `${engine} rate limited`;
}

/** Whether the engine produced an answer — the only outcome that proves its
 *  allowance is not spent. A native command that owes no answer proves nothing. */
function servedATurn(result: EngineResult): boolean {
  if (result.error || result.responseExpected === false) return false;
  return !!result.result?.trim() || !!result.turns?.some((turn) => turn.trim());
}

/**
 * Write down what one engine attempt showed: a usage limit, with the reset it
 * stated if that is still ahead; a refusal to sign in; or a served turn, which
 * proves the engine can sign in and forgets a record that was held against the
 * model that just answered. Anything else is not evidence either way. Never
 * throws — health is advisory.
 */
export function noteEngineTurnOutcome(
  engine: string,
  result: EngineResult,
  model?: string | null,
  now: Date = new Date(),
): void {
  try {
    const limit = detectRateLimit(result);
    if (limit.limited) {
      // A reset is believed only when the engine rejected the turn itself.
      // `claude -p` attaches the current window to every result, so an error
      // that merely matches the limit patterns would otherwise borrow a reset
      // that describes nothing.
      const declared = result.rateLimit?.status === "rejected";
      const stated = declared && limit.resetsAt !== undefined && limit.resetsAt * 1000 > now.getTime() ? limit.resetsAt : undefined;
      recordEngineUnavailable(engine, declared ? usageLimitReason(engine) : throttledReason(engine), stated, now,
        stated === undefined ? undefined : result.rateLimit?.window);
      return;
    }
    if (isLoginRefusal(result)) {
      noteLoginRefusal(engine, now);
      return;
    }
    if (!servedATurn(result)) return;
    noteLoginWorked(engine);
    const record = readEngineHealth(now)[engine];
    if (record && record.state !== "ok" && limitWindowBindsModel(record.window, model)) clearEngineHealth(engine);
  } catch {
    // best-effort only
  }
}

/**
 * The record that says `engine` cannot serve a turn on `model` right now, if
 * there is one: a stated outage, not yet due a re-probe, on a window that binds
 * this model.
 */
export function exhaustedRecordFor(
  engine: string,
  model?: string | null,
  now: Date = new Date(),
): EngineHealth | undefined {
  const health = readEngineHealth(now);
  if (!isEngineExhausted(health, engine, now)) return undefined;
  const record = health[engine];
  return limitWindowBindsModel(record.window, model) ? record : undefined;
}

let installProbe: ((bin: string) => boolean) | undefined;

/**
 * How to tell whether an engine binary is installed. Wired once by the gateway;
 * until then nothing is known to be missing and installation never rules a
 * candidate out — which is also what keeps a unit test's made-up bin usable.
 */
export function setEngineInstallProbe(probe: ((bin: string) => boolean) | undefined): void {
  installProbe = probe;
}

function knownNotInstalled(config: JinnConfig, engine: string): boolean {
  const bin = (config.engines as unknown as Record<string, { bin?: string } | undefined>)[engine]?.bin;
  if (!installProbe || !bin) return false;
  try {
    return !installProbe(bin);
  } catch {
    return false;
  }
}

/**
 * Whether a session may be handed to `engine`: not known to be out of
 * allowance for `model`, not known to be missing from this machine, and not
 * known to be unable to sign in. What is merely unknown is usable — every
 * check rules out on knowledge only.
 */
export function isUsableFallbackTarget(
  config: JinnConfig,
  engine: string,
  model?: string | null,
  now: Date = new Date(),
): boolean {
  return !exhaustedRecordFor(engine, model, now) && !knownNotInstalled(config, engine) && !loginRefusalConfirmed(engine, now);
}

/** How an override that exists only because of a health record is marked. */
export const HEALTH_OVERRIDE_SOURCE = "engine-health";

/**
 * Whether the record a session was moved on has been let go. Such a session
 * was never refused a turn itself — the record is the whole reason it is away
 * from its engine, so it does not outlive the record. A record that is merely
 * past its re-probe point still reads as out; the override's own expiry, set to
 * that same moment, covers it.
 */
export function healthOverrideReleased(override: Record<string, unknown>, now: Date = new Date()): boolean {
  if (override.source !== HEALTH_OVERRIDE_SOURCE || typeof override.originalEngine !== "string") return false;
  return readEngineHealth(now)[override.originalEngine]?.state !== "exhausted";
}

/** The limit period — an engine and the reset it stated — that has already been
 *  announced in a conversation. One entry per engine: a new period replaces the
 *  last. In memory only, so a restart inside a period may announce it once more. */
const announcedLimits = new Map<string, string>();

/**
 * Whether this caller is the one to announce that `engine` is out until
 * `until`. True at most once per limit period; the caller that gets `true`
 * owns the announcement.
 */
export function claimUsageLimitAnnouncement(engine: string, until: string): boolean {
  if (announcedLimits.get(engine) === until) return false;
  announcedLimits.set(engine, until);
  return true;
}

/** Test-only: forget which limit periods were announced. */
export function _resetUsageLimitAnnouncements(): void {
  announcedLimits.clear();
}

export interface EngineHealthStatus {
  state: EngineHealthState;
  /** ISO. The reopening the engine stated. */
  until?: string;
  /** ISO. When the gateway next checks for itself. */
  recheckAt?: string;
}

/** The reading `/api/status` shows beside each engine. One read of the store
 *  serves every engine in the response. */
export function engineHealthForStatus(now: Date = new Date()): (engine: string) => EngineHealthStatus {
  const health = readEngineHealth(now);
  return (engine) => {
    const record = health[engine];
    if (!record || record.state === "ok") return { state: "ok" };
    return {
      state: record.state,
      ...(record.until === undefined ? {} : { until: record.until }),
      ...(record.recheckAt === undefined ? {} : { recheckAt: record.recheckAt }),
    };
  };
}
