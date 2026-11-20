/**
 * Connecting a Slack app as a `connectors.instances` entry — the peer Ryoko
 * variant of the top-level connect in api.ts, with the same guarantees:
 * verify both tokens first, then save → reload, and if the connector still
 * does not come up, put config.yaml back as it was before the attempt.
 * Snapshot → write → reload → rollback is one critical section under the
 * config lock.
 */
import { withConfigLock } from "../shared/config-lock.js";
import { readConfigSnapshot, writeConfigDocument, writeConfigText, type ConfigSnapshot } from "../shared/config-file.js";
import { logger } from "../shared/logger.js";

type ConfigDocument = Record<string, unknown>;
type InstanceEntry = Record<string, unknown> & { id: string };

export interface ReloadOutcome {
  status: "ok" | "partial";
  connectorsReload?: { started: string[]; stopped: string[]; errors: string[] };
  connectorsReloadError?: string;
}

export interface SlackTokenCheck {
  ok: boolean;
  bot: { ok: boolean; team?: string; user?: string; error?: string };
  app: { ok: boolean; error?: string };
}

export interface SlackInstanceDeps {
  verify: (botToken: string, appToken: string) => Promise<SlackTokenCheck>;
  /** Reload connectors after a config write the watcher was told to skip. */
  reloadAfterWrite: () => Promise<ReloadOutcome>;
  suppressNextConnectorReload?: () => void;
  clearSuppressNextConnectorReload?: () => void;
}

export interface SlackInstanceConnectResult {
  ok: boolean;
  instanceId: string;
  stage?: "verify" | "reload";
  error?: string;
  /** Whether an entry with this id was on disk before the attempt. */
  previous?: "config" | "none";
  /** Same meaning as the top-level connect's: the pre-attempt state is fully back. */
  rolledBack?: boolean;
  restored?: { disk: boolean; running: boolean };
  rollbackError?: string;
  rollbackSkipped?: string;
  team?: string;
  user?: string;
  bot?: SlackTokenCheck["bot"];
  app?: SlackTokenCheck["app"];
}

function connectorsOf(document: ConfigDocument): ConfigDocument {
  const connectors = document.connectors;
  return connectors && typeof connectors === "object" && !Array.isArray(connectors) ? (connectors as ConfigDocument) : {};
}

/** Where a newly connected peer answers: DMs always, channels and group DMs
 *  when mentioned (and on in threads it joined). Changeable on its page. */
export const NEW_PEER_RESPOND_TO = { im: "always", mpim: "mention", channel: "mention", engagedThreads: true } as const;

export function instancesOf(document: ConfigDocument): InstanceEntry[] {
  const list = connectorsOf(document).instances;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is InstanceEntry => Boolean(item) && typeof item === "object" && typeof (item as ConfigDocument).id === "string");
}

export function instanceOf(document: ConfigDocument, id: string): InstanceEntry | null {
  return instancesOf(document).find((item) => item.id === id) ?? null;
}

function withInstances(document: ConfigDocument, instances: unknown[]): ConfigDocument {
  const { instances: _old, ...rest } = connectorsOf(document);
  const connectors = instances.length > 0 ? { ...rest, instances } : rest;
  return { ...document, connectors };
}

/** The document with the entry of this id replaced exactly (in place), or appended. */
export function replaceInstance(document: ConfigDocument, entry: InstanceEntry): ConfigDocument {
  const raw = connectorsOf(document).instances;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const index = list.findIndex((item) => Boolean(item) && typeof item === "object" && (item as ConfigDocument).id === entry.id);
  const next = index >= 0 ? list.map((item, i) => (i === index ? entry : item)) : [...list, entry];
  return withInstances(document, next);
}

export function withoutInstance(document: ConfigDocument, id: string): ConfigDocument {
  const raw = connectorsOf(document).instances;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  return withInstances(document, list.filter((item) => !(item && typeof item === "object" && (item as ConfigDocument).id === id)));
}

/** A reload failure that is this instance's own (or the reload itself throwing). */
export function instanceFailure(outcome: ReloadOutcome, id: string): string | null {
  if (outcome.connectorsReloadError) return outcome.connectorsReloadError;
  const errors = outcome.connectorsReload?.errors ?? [];
  return errors.find((line) => line.includes(`"${id}"`) || line.startsWith(`${id}:`)) ?? null;
}

function stillHoldingTokens(id: string, botToken: string, appToken: string): ConfigSnapshot | null {
  let current: ConfigSnapshot;
  try {
    current = readConfigSnapshot();
  } catch {
    return null;
  }
  const entry = instanceOf(current.document, id);
  return entry?.botToken === botToken && entry?.appToken === appToken ? current : null;
}

/** Put config.yaml back: byte for byte when nothing else wrote since, else only this entry. */
function restoreInstance(before: ConfigSnapshot, current: ConfigSnapshot, writtenRevision: string, id: string): void {
  if (before.bytes !== null && current.revision === writtenRevision) {
    writeConfigText(current, before.bytes);
    return;
  }
  const previous = instanceOf(before.document, id);
  writeConfigDocument(current, previous ? replaceInstance(current.document, previous) : withoutInstance(current.document, id));
}

export interface SlackInstanceInput {
  id: string;
  employee: string;
  botToken: string;
  appToken: string;
  /**
   * Checked inside the config lock, right before writing: false means the
   * Ryoko this instance belongs to is gone (a DELETE won the race), and
   * nothing is written — the instance must not come back to life.
   */
  stillWanted?: () => boolean;
}

/**
 * Write (or update) `{ id, type: "slack", employee, botToken, appToken }` in
 * `connectors.instances`, keeping any other field an existing entry has
 * (respondTo, triage, …), reload, and roll back when it does not start.
 */
export async function connectSlackInstance(deps: SlackInstanceDeps, input: SlackInstanceInput): Promise<SlackInstanceConnectResult> {
  const { id, employee, botToken, appToken } = input;
  const verified = await deps.verify(botToken, appToken);
  if (!verified.ok) {
    return { ok: false, instanceId: id, stage: "verify", error: "token verification failed", bot: verified.bot, app: verified.app };
  }

  return withConfigLock(async () => {
    if (input.stillWanted && !input.stillWanted()) {
      logger.warn(`[ryokos] not writing Slack instance ${id}: ${employee} no longer exists`);
      return { ok: false, instanceId: id, error: "ryoko_not_found" };
    }
    const before = readConfigSnapshot();
    const existing = instanceOf(before.document, id);
    const previous = existing ? ("config" as const) : ("none" as const);
    // A new peer starts quiet in channels: it often shares them with the main
    // Ryoko, and two bots answering every message is never what was wanted.
    const entry: InstanceEntry = existing
      ? { ...existing, id, type: "slack", employee, botToken, appToken }
      : { id, type: "slack", employee, botToken, appToken, respondTo: { ...NEW_PEER_RESPOND_TO } };
    const revision = writeSuppressed(deps, () => writeConfigDocument(before, replaceInstance(before.document, entry)));
    const outcome = await deps.reloadAfterWrite();
    const failure = instanceFailure(outcome, id);
    if (!failure) return { ok: true, instanceId: id, team: verified.bot.team, user: verified.bot.user };

    const fail = { ok: false, instanceId: id, stage: "reload" as const, error: failure, previous };
    const current = stillHoldingTokens(id, botToken, appToken);
    if (!current) {
      logger.warn(`[ryokos] Slack instance ${id} failed (${failure}) but its config changed concurrently — leaving it as is`);
      return { ...fail, rolledBack: false, restored: { disk: false, running: false }, rollbackSkipped: "config changed concurrently" };
    }
    logger.warn(`[ryokos] Slack instance ${id} failed after save (${failure}) — ${previous === "config" ? "restoring its previous entry" : "removing it again"}`);
    let rollback: ReloadOutcome;
    try {
      deps.suppressNextConnectorReload?.();
      restoreInstance(before, current, revision, id);
      rollback = await deps.reloadAfterWrite();
    } catch (err) {
      deps.clearSuppressNextConnectorReload?.();
      const rollbackError = err instanceof Error ? err.message : String(err);
      logger.error(`[ryokos] Slack instance ${id} rollback write failed: ${rollbackError}`);
      return { ...fail, rolledBack: false, restored: { disk: false, running: false }, rollbackError };
    }
    const rollbackFailure = instanceFailure(rollback, id);
    if (rollbackFailure) {
      return { ...fail, rolledBack: false, restored: { disk: true, running: false }, rollbackError: rollbackFailure };
    }
    return { ...fail, rolledBack: true, restored: { disk: true, running: previous === "config" } };
  });
}

/** Take a connector instance out of config.yaml and reload; false when there was none. */
export async function removeConnectorInstance(deps: Omit<SlackInstanceDeps, "verify">, id: string): Promise<boolean> {
  return withConfigLock(async () => {
    const snapshot = readConfigSnapshot();
    if (!instanceOf(snapshot.document, id)) return false;
    writeSuppressed(deps, () => writeConfigDocument(snapshot, withoutInstance(snapshot.document, id)));
    await deps.reloadAfterWrite();
    return true;
  });
}

/** Write with the watcher's reload suppressed (we reload ourselves); a write
 *  that throws must not leave the watcher silenced for the next edit. */
function writeSuppressed<T>(deps: Pick<SlackInstanceDeps, "suppressNextConnectorReload" | "clearSuppressNextConnectorReload">, write: () => T): T {
  deps.suppressNextConnectorReload?.();
  try {
    return write();
  } catch (err) {
    deps.clearSuppressNextConnectorReload?.();
    throw err;
  }
}
