import { watch, type FSWatcher } from "chokidar";
import { CONFIG_PATH, CRON_JOBS, ORG_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface WatcherCallbacks {
  onConfigReload: () => void;
  onCronReload: () => void;
  onOrgChange: () => void;
}

let watchers: FSWatcher[] = [];

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export function startWatchers(callbacks: WatcherCallbacks): void {
  const DEBOUNCE_MS = 500;

  const configWatcher = watch(CONFIG_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  configWatcher.on(
    "change",
    debounce(() => {
      logger.info("config.yaml changed, reloading...");
      callbacks.onConfigReload();
    }, DEBOUNCE_MS),
  );

  const cronWatcher = watch(CRON_JOBS, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  cronWatcher.on(
    "change",
    debounce(() => {
      logger.info("cron/jobs.json changed, reloading...");
      callbacks.onCronReload();
    }, DEBOUNCE_MS),
  );

  const orgWatcher = watch(ORG_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  orgWatcher.on(
    "all",
    debounce(() => {
      logger.info("org/ directory changed, reloading...");
      callbacks.onOrgChange();
    }, DEBOUNCE_MS),
  );

  watchers = [configWatcher, cronWatcher, orgWatcher];
  logger.info("File watchers started");
}

export async function stopWatchers(): Promise<void> {
  await Promise.all(watchers.map((w) => w.close()));
  watchers = [];
  logger.info("File watchers stopped");
}
