/**
 * Upstream-compat shim. Upstream jinn keeps one central sqlite handle in
 * shared/db.ts (sessions included); this fork's sessions registry owns its own
 * database. Upstream-authored tests import `initDb` from here to read the rows
 * the code under test wrote — delegate so they see the same database.
 *
 * `__closeDbForTest` is a no-op: the registry keeps its handle for the process
 * lifetime, and removing a temp test home works with the handle open on the
 * POSIX platforms this fork targets.
 */
export { initDb } from "../sessions/registry.js";

export function __closeDbForTest(): void {
  /* no-op — see module note */
}
