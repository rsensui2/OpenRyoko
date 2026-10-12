import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../../shared/paths.js";

const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

// Operators and agents learn the cron settings, and what a run-log status
// means, from these shipped files. Nothing generates them from the code, so
// this pins that what the gateway reads and writes is written down where it is
// looked up.
describe("shipped cron documentation", () => {
  it("lists cron.alertThrottleMinutes with the other alert settings in the default config", () => {
    expect(read("config.default.yaml")).toMatch(/\ncron:\n(?:[ \t]+#.*\n)*[ \t]+# alertThrottleMinutes: 60\b/);
  });

  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("explains the alert throttle and its default in %s", (file) => {
    const text = read(file);
    expect(text).toContain("cron.alertThrottleMinutes");
    expect(text).toMatch(/default 60/);
  });

  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s which prompt runs are logged as an error", (file) => {
    const text = read(file);
    expect(text).toMatch(/session ended in error/);
    expect(text).toMatch(/not delivered/);
    expect(text).toMatch(/engine the gateway does not have/);
  });

  it("shows the run log with the fields the gateway writes, not ones it never did", () => {
    const text = read("docs/cron.md");
    for (const field of ["timestamp", "sessionKey", "sessionId", "status", "durationMs", "error"]) {
      expect(text).toContain(`"${field}":`);
    }
    for (const stale of ['"runId"', '"completedAt"', '"output"']) expect(text).not.toContain(stale);
  });

  // The inspection an update-notification job runs writes its own lines, and
  // those report a delivered result as `notified`, never as `success`.
  it("names every status a run-log line can carry, including the maintenance lines' own", () => {
    const text = read("docs/cron.md");
    for (const status of ["success", "error", "skipped", "notified"]) expect(text).toContain(`\`${status}\``);
    expect(text).toMatch(/`kind: "maintenance"`[^.]*`notified`/);
  });

  // A fire that is skipped because an earlier one of the same job is parked on
  // a usage limit writes a reason and two fields nothing else does.
  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s why a prompt run is skipped while an earlier fire waits for a usage limit", (file) => {
    const text = read(file);
    expect(text).toContain("previous-run-waiting-for-usage-limit");
    expect(text).toContain("`waitingSessionId`");
    expect(text).toContain("`resetsAt`");
  });

  // While a usage limit is not waited for, every fire fails and is logged, but
  // the delivery channel hears of it once: silence there is not recovery.
  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s that the delivery channel is told of a usage limit once per limit period", (file) => {
    const text = read(file);
    expect(text).toMatch(/usage limit[^.]*\./);
    expect(text).toMatch(/delivery channel[^.]*once per limit period/);
  });

  // The alert for it is held for the limit period too, not for the hourly window.
  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s that a usage limit is alerted once per limit period", (file) => {
    expect(read(file)).toMatch(/alert(?:ed|s)?[^.]*once per limit period/);
  });

  // A job naming an unknown engine is failed before any session is started, so
  // that error line has no `sessionId` to follow.
  it("does not promise a sessionId for a run that failed before a session existed", () => {
    const text = read("skills/cron-manager/SKILL.md");
    expect(text).not.toContain("and the session in `sessionId`");
    expect(text).toMatch(/`sessionId`, when present[^.]*\babsent\b[^.]*engine the gateway does not have/);
  });

  it("mentions that the run history can be limited to the newest runs", () => {
    expect(read("docs/cron.md")).toContain("?limit=");
    expect(read("skills/cron-manager/SKILL.md")).toContain("?limit=");
  });
});

// How a change to jobs.json reaches the scheduler was described as "cancel every
// job, then reschedule", and an unreadable file as the loss of every job. The
// scheduler does neither, and an agent that believed it wrote `[]` over a broken
// file to "recover" — the one edit that really does remove every job.
describe("shipped documentation of how cron/jobs.json is reloaded", () => {
  const source = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "..", ...rel.split("/")), "utf-8");

  it("says in docs/cron.md that an unreadable file leaves the registered jobs scheduled, in the words the gateway logs", () => {
    const logged = "Cron reload skipped; keeping previous registrations";

    expect(source("cron/reconcile.ts")).toContain(logged);
    expect(read("docs/cron.md")).toContain(logged);
    expect(read("docs/cron.md")).toMatch(/A job that did not change keeps its registration/);
  });

  it.each(["docs/cron.md", "docs/self-modification.md"])("no longer says in %s that a reload cancels every job first", (file) => {
    expect(read(file)).not.toMatch(/All existing scheduled jobs are cancelled|Cancel all scheduled jobs/);
    expect(read(file)).not.toMatch(/will cancel all cron jobs/);
  });

  it.each(["docs/cron.md", "docs/self-modification.md"])("says in %s that a valid empty list is what unschedules every job", (file) => {
    expect(read(file)).toMatch(/empty list `\[\]`[^\n]*unschedules every job/);
  });

  it("gives the interval of the comparison that catches a missed change as the watcher has it", () => {
    expect(source("gateway/watcher.ts")).toMatch(/"cron reconciliation", \(\) => callbacks\.onCronReload\(\)\), 30_000\)/);
    expect(read("docs/cron.md")).toContain("every 30 seconds compares the file with what is scheduled");
  });

  it("has an engine create a job through the API, not by rewriting the file", () => {
    const text = read("docs/self-modification.md");

    expect(text).toContain("ryoko api POST /api/cron");
    expect(text).not.toContain("Write back to ~/.ryoko/cron/jobs.json");
  });
});

describe("shipped documentation of when cron settings and engines apply", () => {
  it("says the cron section of the config is read at each fire, naming every key of it", () => {
    const text = read("docs/cron.md");

    for (const key of ["alertConnector", "alertChannel", "alertThrottleMinutes", "defaultDelivery"]) expect(text, key).toContain(`\`${key}\``);
    expect(text).toMatch(/are read each time a job fires/);
  });

  it("says that what was alerted is forgotten at a restart", () => {
    expect(read("docs/cron.md")).toMatch(/kept in memory only, so the first failure after a gateway restart alerts again/);
  });

  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s that a job naming its engine or model is not moved off an engine that is out of allowance", (file) => {
    const text = read(file);

    expect(text).toMatch(/names neither/);
    expect(text).toMatch(/is not moved/);
    expect(text).toMatch(/fails a turn on the named engine/);
  });

  it("shows the engine of a job as optional", () => {
    expect(read("docs/cron.md")).toMatch(/^  engine\?: string;/m);
  });

  it("does not promise a warning the gateway does not log for a job that delivers for an employee", () => {
    expect(read("docs/cron.md")).not.toContain("The gateway will log a warning if it detects");
  });
});
