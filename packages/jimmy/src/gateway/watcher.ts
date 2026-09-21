import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { CONFIG_PATH, CRON_JOBS, ORG_DIR, SKILLS_DIR, CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface WatcherCallbacks {
  onConfigReload: () => void;
  onCronReload: () => void;
  onOrgChange: () => void;
  onSkillsChange: () => void;
}

interface WatcherGroup {
  watchers: FSWatcher[];
  timers: Set<ReturnType<typeof setTimeout>>;
  reconciliation?: ReturnType<typeof setInterval>;
  stopped: boolean;
}

let activeGroup: WatcherGroup | undefined;

function invoke(group: WatcherGroup, label: string, callback: () => void): void {
  if (group.stopped) return;
  const report = (error: unknown) => logger.error(`File watcher callback failed (${label}): ${error instanceof Error ? error.message : String(error)}`);
  try {
    // Callbacks are normally synchronous; also contain a returned promise so
    // an asynchronous reload cannot become an unhandled rejection.
    void Promise.resolve(callback()).catch(report);
  } catch (error) {
    report(error);
  }
}

function debounce(group: WatcherGroup, label: string, fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (group.stopped) return;
    if (timer) {
      clearTimeout(timer);
      group.timers.delete(timer);
    }
    timer = setTimeout(() => {
      group.timers.delete(timer!);
      timer = null;
      invoke(group, label, fn);
    }, ms);
    group.timers.add(timer);
  };
}

/**
 * Sync symlinks in .claude/skills/ and .agents/skills/ to match skills/.
 * Each skill directory gets a relative symlink: ../../skills/<name>
 */
export function syncSkillSymlinks(): void {
  const targetDirs = [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR];

  // Get current skill directories
  let skillNames: string[] = [];
  if (fs.existsSync(SKILLS_DIR)) {
    skillNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  for (const targetDir of targetDirs) {
    fs.mkdirSync(targetDir, { recursive: true });

    // Remove stale symlinks
    const existing = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of existing) {
      if (!skillNames.includes(entry.name)) {
        const linkPath = path.join(targetDir, entry.name);
        try {
          fs.unlinkSync(linkPath);
          logger.debug(`Removed stale skill symlink: ${linkPath}`);
        } catch {
          // ignore
        }
      }
    }

    // Create missing symlinks (with copy fallback for Windows without Developer Mode)
    for (const name of skillNames) {
      const linkPath = path.join(targetDir, name);
      const relTarget = path.join("..", "..", "skills", name);
      const absTarget = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(linkPath)) {
        try {
          fs.symlinkSync(relTarget, linkPath);
          logger.debug(`Created skill symlink: ${linkPath} -> ${relTarget}`);
        } catch {
          try {
            fs.cpSync(absTarget, linkPath, { recursive: true });
            logger.debug(`Copied skill (symlink unavailable): ${linkPath}`);
          } catch {
            // ignore — skill won't be discoverable from this path
          }
        }
      }
    }
  }
}

export function startWatchers(callbacks: WatcherCallbacks): void {
  const DEBOUNCE_MS = 500;
  // Detach the old group synchronously; its eventual close must never clear a
  // newly started group's timers or let an already queued callback run.
  if (activeGroup) void stopWatchers();
  const group: WatcherGroup = { watchers: [], timers: new Set(), stopped: false };
  activeGroup = group;
  const track = (watcher: FSWatcher, label: string) => {
    group.watchers.push(watcher);
    watcher.on("error", (error) => {
      if (!group.stopped) logger.error(`File watcher error (${label}): ${error instanceof Error ? error.message : String(error)}`);
    });
    return watcher;
  };

  const configWatcher = track(watch(CONFIG_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  }), "config.yaml");
  configWatcher.on(
    "change",
    debounce(group, "config.yaml", () => {
      logger.info("config.yaml changed, reloading...");
      return callbacks.onConfigReload();
    }, DEBOUNCE_MS),
  );

  // Watching the directory keeps recreation observable after the original
  // file/inode has been removed. Ignore events for its other contents.
  const cronWatcher = track(watch(path.dirname(CRON_JOBS), {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 300 },
  }), "cron/jobs.json");
  const reloadCron = debounce(group, "cron/jobs.json", () => {
    logger.info("cron/jobs.json changed, reloading...");
    return callbacks.onCronReload();
  }, DEBOUNCE_MS);
  for (const event of ["add", "change", "unlink"] as const) {
    cronWatcher.on(event, (file) => {
      if (path.resolve(file) === path.resolve(CRON_JOBS)) reloadCron();
    });
  }

  // Filesystem events can stop arriving without an error (for example on a
  // mounted filesystem). Reconcile independently; the consumer compares the
  // definitions and only replaces registrations when they actually changed.
  group.reconciliation = setInterval(() => invoke(group, "cron reconciliation", () => callbacks.onCronReload()), 30_000);
  group.reconciliation.unref();

  const orgWatcher = track(watch(ORG_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  }), "org/");
  orgWatcher.on(
    "all",
    debounce(group, "org/", () => {
      logger.info("org/ directory changed, reloading...");
      return callbacks.onOrgChange();
    }, DEBOUNCE_MS),
  );

  // Watch skills/ directory for added/removed skill folders → sync symlinks
  const skillsWatcher = track(watch(SKILLS_DIR, {
    ignoreInitial: true,
    depth: 0,
  }), "skills/");
  skillsWatcher.on(
    "all",
    debounce(group, "skills/", () => {
      logger.info("skills/ directory changed, syncing symlinks...");
      syncSkillSymlinks();
      return callbacks.onSkillsChange();
    }, DEBOUNCE_MS),
  );

  logger.info("File watchers started");
}

export async function stopWatchers(): Promise<void> {
  const group = activeGroup;
  if (!group) return;
  activeGroup = undefined;
  group.stopped = true;
  if (group.reconciliation) clearInterval(group.reconciliation);
  for (const timer of group.timers) clearTimeout(timer);
  group.timers.clear();
  await Promise.all(group.watchers.map(async (watcher) => {
    try { await watcher.close(); }
    catch (error) { logger.error(`Failed to close file watcher: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  logger.info("File watchers stopped");
}
