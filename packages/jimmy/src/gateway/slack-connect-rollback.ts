import { readConfigSnapshot, writeConfigDocument, writeConfigText, type ConfigSnapshot } from "../shared/config-file.js";

/* Undoing a Slack connect that was saved to config.yaml but did not start.
 *
 * The undo used to merge the previous Slack block back over the new one, and a
 * merge cannot remove a key: where the previous block had no tokens, the
 * failed ones stayed in the file while the caller was told it had been rolled
 * back. So the file as it was before the attempt is kept, and put back. */

/** The Slack block of a config document, or null when it has none. */
export function slackBlockOf(document: Record<string, unknown>): Record<string, unknown> | null {
  const connectors = document.connectors;
  if (!connectors || typeof connectors !== "object") return null;
  return ((connectors as Record<string, unknown>).slack as Record<string, unknown> | undefined) ?? null;
}

/**
 * config.yaml as it is now, provided its Slack block is still the one a
 * connect attempt wrote; null otherwise. An out-of-band editor may have put
 * something else there meanwhile, and that is theirs to keep — the undo must
 * not run over it.
 */
export function snapshotStillHoldingSlackTokens(botToken: string, appToken: string): ConfigSnapshot | null {
  let current: ConfigSnapshot;
  try {
    current = readConfigSnapshot();
  } catch {
    return null; // somebody is mid-edit: not ours to overwrite either
  }
  const slack = slackBlockOf(current.document);
  return slack?.botToken === botToken && slack?.appToken === appToken ? current : null;
}

/**
 * Put config.yaml back to how it was before the attempt. `before` is the file
 * as read just before the attempt wrote, `current` the file as it is now, and
 * `writtenRevision` the revision the attempt's own write produced.
 *
 * When nothing else has touched the file since that write, the previous bytes
 * go back exactly: tokens the old block never had are gone, and every comment
 * is where it was. When something else did change (the config lock only holds
 * up API writers, not a hand edit), only the Slack block is undone — replaced
 * by the previous one or removed — so that change survives.
 */
export function restoreBeforeSlackConnect(before: ConfigSnapshot, current: ConfigSnapshot, writtenRevision: string): void {
  if (before.bytes !== null && current.revision === writtenRevision) {
    writeConfigText(current, before.bytes);
    return;
  }
  const previousSlack = slackBlockOf(before.document);
  const connectors = Object.entries((current.document.connectors ?? {}) as Record<string, unknown>)
    .flatMap(([name, block]) => (name !== "slack" ? [[name, block]] : previousSlack ? [[name, previousSlack]] : []));
  writeConfigDocument(current, { ...current.document, connectors: Object.fromEntries(connectors) });
}
