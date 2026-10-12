/**
 * Where a NEW routed session starts when the engine it prefers is already known
 * to be out of allowance.
 *
 * Without this every new session — every cron firing included — rediscovered
 * the same spent allowance the hard way: one failed turn, one "switching"
 * notice, then the real work on the fallback engine. Here the session is moved
 * before its first turn instead, with the same temporary override a mid-turn
 * switch records, so `maybeRevertEngineOverride` takes it back unchanged.
 *
 * It is only ever moved to an engine that has answered a turn in this process.
 * A switch after a failed turn can be taken back within that turn if the
 * fallback engine turns out not to be signed in; a session started there has
 * no earlier failure to fall back on, so it does not go first.
 */

import { compatibleEffort } from "../models/families.js";
import { resolveFallbackEngine, resolveSubstituteModel } from "../shared/engine-fallback.js";
import { effortLevelsForModel, getModelRegistry } from "../shared/models.js";
import { logger } from "../shared/logger.js";
import type { Employee, Engine, JinnConfig, Session } from "../shared/types.js";
import { fallbackConfig } from "./engine-fallback.js";
import { claimUsageLimitAnnouncement, exhaustedRecordFor, HEALTH_OVERRIDE_SOURCE, isUsableFallbackTarget } from "./engine-health-gate.js";
import { hasServedATurn } from "./engine-login.js";
import { updateSession } from "./registry.js";

/** What a routed turn brought with it about where the session should run. */
export interface NewSessionEnginePreference {
  engine?: string;
  model?: string;
  employee?: Employee;
}

export interface HealthyStart {
  session: Session;
  /** What to tell the conversation, when this session is the first to start
   *  away from the limited engine in the current limit period. */
  notice?: string;
}

type EngineSection = { model?: string; effortLevel?: string } | undefined;
const engineSection = (config: JinnConfig, engine: string): EngineSection =>
  (config.engines as unknown as Record<string, EngineSection>)[engine];

/** The same wording every other usage-limit notice uses for a reset. */
function resetText(until: string): string {
  return new Date(until).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Move a session that was just created on the engine it prefers to the first
 * usable member of that engine's chain, when the preferred engine is known to
 * be out of allowance for the model the session would run.
 *
 * Left exactly where it was created when: the caller named the engine or the
 * model outright; the instance waits out limits instead of switching; the
 * employee runs on a remote machine, whose account the record is not about; or
 * nothing in the chain can take the session either. The same holds if anything
 * here fails — a hand-edited chain that is not a list, say: health is advice,
 * and advice that cannot be worked out must not cost the session its turn.
 */
export function startOnHealthyEngine(
  config: JinnConfig,
  getEngine: (name: string) => Engine | undefined,
  session: Session,
  preference: NewSessionEnginePreference,
  now: Date = new Date(),
): HealthyStart {
  try {
    return rerouted(config, getEngine, session, preference, now);
  } catch (error) {
    logger.warn(`Session ${session.id} starts on ${session.engine} as created: could not consult engine health (${error instanceof Error ? error.message : String(error)})`);
    return { session };
  }
}

function rerouted(
  config: JinnConfig,
  getEngine: (name: string) => Engine | undefined,
  session: Session,
  preference: NewSessionEnginePreference,
  now: Date,
): HealthyStart {
  if (preference.engine !== undefined || preference.model !== undefined) return { session };
  if (config.sessions?.rateLimitStrategy === "wait" || session.workflowProvenance || preference.employee?.sshHost) return { session };

  const from = session.engine;
  const record = exhaustedRecordFor(from, session.model ?? engineSection(config, from)?.model, now);
  if (!record?.until) return { session };

  let model: string | undefined;
  const to = resolveFallbackEngine(fallbackConfig(config), from, (name) => {
    // Starting a session somewhere cannot be taken back within the turn the
    // way a switch after a failed turn can, so it only goes to an engine that
    // has answered a turn in this process — never to one that is merely
    // installed, and may turn out not to be signed in.
    if (!getEngine(name) || !config.engines[name] || !hasServedATurn(name)) return false;
    const candidateModel = resolveSubstituteModel(config, getModelRegistry(config), { from, to: name, model: session.model }) ?? config.engines[name]!.model;
    if (!isUsableFallbackTarget(config, name, candidateModel, now)) return false;
    model = candidateModel;
    return true;
  });
  if (!to) return { session };

  const effort = compatibleEffort(
    session.effortLevel ?? preference.employee?.effortLevel ?? engineSection(config, from)?.effortLevel,
    effortLevelsForModel(config, to, model),
  );
  // Believed only as far as the record itself is: its next re-probe, which is
  // the stated reset for any window shorter than twelve hours. `source` marks
  // the override as resting on the record alone, so it ends with the record.
  const until = new Date(Date.parse(record.recheckAt ?? record.until) + 1000).toISOString();
  const meta = session.transportMeta && typeof session.transportMeta === "object" ? session.transportMeta : {};
  const moved = updateSession(session.id, {
    engine: to,
    model: model ?? null,
    effortLevel: effort ?? null,
    transportMeta: { ...meta, engineOverride: {
      originalEngine: from, originalEngineSessionId: null, originalModel: session.model, originalEffortLevel: session.effortLevel,
      until, syncSince: now.toISOString(), source: HEALTH_OVERRIDE_SOURCE,
    } },
  });
  if (!moved) return { session };

  logger.info(`Session ${session.id} starts on ${to}: ${from} is out of allowance until ${record.until}`);
  return {
    session: moved,
    ...(claimUsageLimitAnnouncement(from, record.until)
      ? { notice: `⚠️ ${from} usage limit reached (resets ${resetText(record.until)}). Starting on ${to}.` }
      : {}),
  };
}
