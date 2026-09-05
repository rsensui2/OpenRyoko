import fs from "node:fs";
import path from "node:path";
import { resolveFallbackEngine } from "./engine-fallback.js";
import type { EngineName } from "./models.js";
import { JINN_HOME } from "./paths.js";
import type { EngineLimitWindow, JinnConfig, ModelRegistry } from "./types.js";

/**
 * Whether an engine can actually serve a turn, beside the installed-availability
 * the model registry reports.
 *
 * Advisory by construction, and every part of that is deliberate: reads and
 * writes swallow their own errors, every record carries the moment it stops
 * being true, and both dispatchers walk their chain again without health when
 * health would have left them nothing. The worst a wrong record can do is order
 * a chain differently — it can never refuse a turn.
 */

export type EngineHealthState = "ok" | "exhausted" | "degraded";

export interface EngineHealth {
  state: EngineHealthState;
  /** ISO. The reopening the engine itself stated, verbatim: what every display
   *  surface shows, and the moment the record is spent. */
  until?: string;
  /** ISO. When a dispatcher may offer the engine a probing turn again, on an
   *  `exhausted` record. Internal — a shorter belief than `until`, never a
   *  shorter claim, so it is deliberately not displayed anywhere. */
  recheckAt?: string;
  /** The binding quota window as telemetry names it (`5h`, `7d`), when it does. */
  window?: string;
  reason?: string;
  observedAt?: string;
}

/** Live readings keyed by engine name. An engine with no entry is healthy. */
export type EngineHealthReading = Record<string, EngineHealth>;

const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");

/** How long a stated reopening is taken on trust before the engine is offered a
 *  probing turn regardless. A weekly window is real and is displayed as stated;
 *  a misparse that reads as one still self-corrects inside this. */
const REPROBE_INTERVAL_MS = 12 * 60 * 60_000;

/** How long a failure that stated no reopening stays on the record. It says the
 *  provider just refused a turn, which is worth a brief preference away and is
 *  not worth believing for an afternoon. */
const DEGRADED_WINDOW_MS = 15 * 60_000;

const HEALTH_STATES: readonly string[] = ["ok", "exhausted", "degraded"];

function readStore(): EngineHealthReading {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: EngineHealthReading = {};
    for (const [engine, record] of Object.entries(parsed as Record<string, EngineHealth | null>)) {
      if (record && typeof record === "object" && HEALTH_STATES.includes(record.state)) store[engine] = record;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: EngineHealthReading): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // best-effort only
  }
}

/**
 * Whether a record has outlived what it stated. Expiry is what the clock says
 * rather than what a sweeper got around to, so a record can never outlive its
 * own window — and an `until` that will not parse counts as spent, because
 * fail-open is the only safe direction for advice.
 */
function isSpent(record: EngineHealth, now: Date): boolean {
  if (record.state === "ok") return true;
  if (record.until === undefined) return false;
  const until = Date.parse(record.until);
  return !Number.isFinite(until) || until <= now.getTime();
}

/** Every engine something has been observed about, with a record whose window
 *  has passed reading back as `ok`. */
export function readEngineHealth(now: Date = new Date()): EngineHealthReading {
  const live: EngineHealthReading = {};
  for (const [engine, record] of Object.entries(readStore())) {
    live[engine] = isSpent(record, now)
      ? { state: "ok", ...(record.observedAt ? { observedAt: record.observedAt } : {}) }
      : record;
  }
  return live;
}

/** The one question a dispatcher asks, and the only reader of `recheckAt`: past
 *  the re-probe the engine is offered a turn again even though the record still
 *  reads — and still displays — as out until its stated reset.
 *
 *  `degraded` is deliberately not an answer to it: an engine that named no
 *  reopening is a preference, never a reason to hold a turn back. A record from
 *  before re-probes existed carries no `recheckAt` and blocks until `until`,
 *  which is what it meant when it was written. */
export function isEngineExhausted(health: EngineHealthReading, engine: string, now: Date = new Date()): boolean {
  const record = health[engine];
  if (record?.state !== "exhausted") return false;
  if (record.recheckAt === undefined) return true;
  const recheckAt = Date.parse(record.recheckAt);
  return Number.isFinite(recheckAt) && recheckAt > now.getTime();
}

/** The record still inside the window it stated, if there is one. What a failed
 *  re-probe is allowed to keep, rather than replace with a vaguer claim. */
function liveRecord(store: EngineHealthReading, engine: string, now: Date): EngineHealth | undefined {
  const record = store[engine];
  return record && !isSpent(record, now) ? record : undefined;
}

/** When the engine may be probed again: its stated reopening when that is
 *  nearer, otherwise the re-probe interval. */
function recheckFrom(statedMs: number | undefined, now: Date): string {
  const reprobeAt = now.getTime() + REPROBE_INTERVAL_MS;
  return new Date(statedMs === undefined ? reprobeAt : Math.min(statedMs, reprobeAt)).toISOString();
}

/**
 * Note that an engine could not serve a turn, given whatever it said about when
 * it can again.
 *
 * A stated reopening is stored verbatim and is `exhausted` until then. Silence
 * is `degraded`, because a failure that named no end says nothing about when to
 * stop believing it — but silence from an engine already out until a stated
 * reset is a failed re-probe, and that replaces neither the state nor the
 * reopening it already stated. A re-probe only ever moves the next re-probe.
 */
export function recordEngineUnavailable(
  engine: string,
  reason: string,
  resetsAtSeconds?: number,
  now: Date = new Date(),
  window?: string,
): void {
  const stated = resetsAtSeconds !== undefined && Number.isFinite(resetsAtSeconds)
    ? resetsAtSeconds * 1000
    : undefined;
  const store = readStore();
  const observed = { reason, observedAt: now.toISOString(), ...(window === undefined ? {} : { window }) };
  const live = stated === undefined ? liveRecord(store, engine, now) : undefined;

  let record: EngineHealth;
  if (stated !== undefined) {
    record = { state: "exhausted", until: new Date(stated).toISOString(), recheckAt: recheckFrom(stated, now) };
  } else if (live?.state === "exhausted") {
    const statedOnRecord = live.until === undefined ? undefined : Date.parse(live.until);
    record = { ...live, recheckAt: recheckFrom(statedOnRecord, now) };
  } else {
    record = { state: "degraded", until: new Date(now.getTime() + DEGRADED_WINDOW_MS).toISOString() };
  }
  writeStore({ ...store, [engine]: { ...record, ...observed } });
}

/**
 * The same fact a failed turn would have carried, minus the failed turn: a quota
 * window the provider itself reports as fully spent. When several are spent the
 * engine is back only once the last of them reopens.
 */
export function recordExhaustedWindows(
  engine: string,
  windows: readonly EngineLimitWindow[] | undefined,
  now: Date = new Date(),
): void {
  let binding: EngineLimitWindow | undefined;
  let reopensAt = 0;
  for (const window of windows ?? []) {
    if ((window.usedPercent ?? 0) < 100) continue;
    const resetsAt = window.resetsAt ?? 0;
    if (resetsAt * 1000 <= now.getTime() || resetsAt <= reopensAt) continue;
    reopensAt = resetsAt;
    binding = window;
  }
  if (binding) recordEngineUnavailable(engine, "quota window spent", binding.resetsAt, now, binding.name);
}

/**
 * The first engine in `from`'s chain that can take the turn: one the caller
 * accepts AND whose allowance has not run out.
 *
 * A chain the health filter empties is walked again without it. Installed
 * availability stays the only hard gate, so a record that has gone stale can
 * reorder a chain but can never empty one the caller would have accepted.
 */
export function resolveHealthyFallbackEngine(
  config: JinnConfig,
  from: string,
  isUsable: (engine: EngineName) => boolean,
  health: EngineHealthReading,
): EngineName | null {
  return resolveFallbackEngine(config, from, (engine) => isUsable(engine) && !isEngineExhausted(health, engine))
    ?? resolveFallbackEngine(config, from, isUsable);
}

/**
 * The engine a NEW session should start on, given the one it prefers.
 *
 * Only ever asked about a preference the caller did not state outright — an
 * engine named in the request runs, spent allowance or not. Ordering, never
 * refusal: when nothing left in the chain can serve either, the preference is
 * handed straight back and the session starts exactly where it would have.
 */
export function preferHealthySessionEngine(
  config: JinnConfig,
  preferred: EngineName,
  isUsable: (engine: EngineName) => boolean,
  health: EngineHealthReading,
): EngineName {
  if (!isEngineExhausted(health, preferred)) return preferred;
  return resolveFallbackEngine(config, preferred, (engine) => isUsable(engine) && !isEngineExhausted(health, engine))
    ?? preferred;
}

/** The registry as an API consumer reads it: installed availability from the
 *  registry, the live reading beside it. */
export function withEngineHealth(
  registry: ModelRegistry,
): Record<string, ModelRegistry[string] & { health: EngineHealth }> {
  const health = readEngineHealth();
  return Object.fromEntries(Object.entries(registry).map(([name, entry]) => [
    name,
    { ...entry, health: health[name] ?? { state: "ok" as const } },
  ]));
}
