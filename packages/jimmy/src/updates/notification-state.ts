import fs from "node:fs";
import path from "node:path";
import { UPDATE_STATE } from "../shared/paths.js";

interface UpdateNotificationState {
  notifiedVersions: Record<string, string>;
}

function loadState(): UpdateNotificationState {
  try {
    const parsed = JSON.parse(fs.readFileSync(UPDATE_STATE, "utf-8")) as Partial<UpdateNotificationState>;
    if (parsed.notifiedVersions && typeof parsed.notifiedVersions === "object" && !Array.isArray(parsed.notifiedVersions)) {
      const notifiedVersions = Object.fromEntries(
        Object.entries(parsed.notifiedVersions).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      return { notifiedVersions };
    }
  } catch {
    // A missing or malformed state file means no release has been notified yet.
  }
  return { notifiedVersions: {} };
}

export function getLastNotifiedVersion(jobId: string): string | undefined {
  return loadState().notifiedVersions[jobId];
}

export function markVersionNotified(jobId: string, version: string): void {
  const state = loadState();
  state.notifiedVersions[jobId] = version;
  const dir = path.dirname(UPDATE_STATE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${UPDATE_STATE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, UPDATE_STATE);
}
