import type { IncomingHttpHeaders } from "node:http";
import { ConfigFileUnreadableError, readConfigSnapshot } from "../shared/config-file.js";
import type { JinnConfig } from "../shared/types.js";

/**
 * Which config.yaml a client was looking at when it read the config, so a save
 * that would overwrite somebody else's edit can be refused instead of landing.
 *
 * The Settings page PUTs the whole document it read at load time, and the
 * gateway merges that document over whatever is on disk now. A key somebody
 * changed in between (by hand, an agent, another tab, another endpoint) loses
 * to the page's stale copy, silently. The revision closes that window: it is
 * derived from the file's bytes, because the file is what the merge reads and
 * therefore what a conflict is actually about. It is opaque to the client and
 * keyed per gateway process — never a digest of the file, which holds tokens.
 */
export const CONFIG_REVISION_HEADER = "X-Config-Revision";

/** Stands in for a revision while config.yaml cannot be read. Not 64 hex
 *  digits, so it can never match once the file is readable again. */
const UNREADABLE_REVISION = "unreadable";

/**
 * What GET /api/config serves: the document as it is on disk, with the
 * revision of those same bytes. The two must describe the same thing. The
 * in-memory config trails the file until the watcher reloads it (~1s after any
 * write), and old values stamped with the new revision would sail through the
 * check on the next save — which is exactly when a page reloads: right after
 * being told that the file changed.
 *
 * Only when there is no usable file does the running config stand in: with the
 * empty revision before config.yaml exists (the first PUT may create it), and
 * with one that never matches while the file is unreadable.
 */
export function configForApi(running: JinnConfig): { config: JinnConfig; revision: string } {
  try {
    const snapshot = readConfigSnapshot();
    if (snapshot.raw === null) return { config: running, revision: "" };
    return { config: snapshot.document as unknown as JinnConfig, revision: snapshot.revision };
  } catch (err) {
    if (!(err instanceof ConfigFileUnreadableError)) throw err;
    return { config: running, revision: UNREADABLE_REVISION };
  }
}

/**
 * Whether a PUT is writing over a config it has not seen.
 *
 * A request without the header is not stale — it opted out, and that is
 * deliberate: a partial update (`ryoko api PUT /api/config`, scripts, agents)
 * never read the document it is merging into, so it has no revision to send
 * and nothing stale to write over the other keys.
 */
export function isStaleConfigRevision(headers: IncomingHttpHeaders, current: string): boolean {
  const sent = headers[CONFIG_REVISION_HEADER.toLowerCase()];
  if (typeof sent !== "string" || sent === "") return false;
  return sent !== current;
}

/** What the caller is told when its save would have overwritten an edit it never saw. */
export const CONFIG_CONFLICT_BODY = {
  error: "config.yaml changed on disk after this config was loaded; saving now would overwrite that change. "
    + "Reload the config, reapply your edit, then save again.",
  code: "CONFIG_CONFLICT",
} as const;
