import { logger } from "../shared/logger.js";
import { JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js";
import { buildTemplateReplacements, readPortalName } from "../shared/templateReplacements.js";
import type { JinnConfig } from "../shared/types.js";
import { getPackageVersion } from "../shared/version.js";
import { syncBundledSkills } from "./sync.js";
import type { BundledSkillSync, KeepReason } from "./types.js";

/**
 * Sync the skills this package ships into this instance's home. Gateway start and
 * `ryoko migrate` both go through here, so they can never disagree about a skill.
 * Both leave out a bundled skill the operator deleted: neither a restart nor an
 * update brings it back. `restoreDeleted` is set by one caller only,
 * `ryoko migrate --restore-deleted-skills`.
 */
export function syncInstanceBundledSkills(options: { restoreDeleted?: boolean | readonly string[] } = {}): BundledSkillSync {
  return syncBundledSkills({
    templateDir: TEMPLATE_DIR,
    home: JINN_HOME,
    replacements: buildTemplateReplacements(readPortalName()),
    legacyPortalNames: installerDefaultNames(),
    packageVersion: getPackageVersion(),
    restoreDeleted: options.restoreDeleted ?? false,
  });
}

/**
 * The names `ryoko setup` gives the assistant when nobody picks one: "Ryoko", "Jinn"
 * in homes migrated from upstream, or the capitalised instance name (`-i <name>`).
 * Skills are written with the name current at install time and never rewritten, so a
 * home renamed since still holds one of these in its older skills.
 */
export function installerDefaultNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const instance = env.RYOKO_INSTANCE || env.JINN_INSTANCE;
  const named = instance ? [instance.charAt(0).toUpperCase() + instance.slice(1)] : [];
  return [...new Set(["Ryoko", "Jinn", ...named])];
}

/**
 * Run the sync as the gateway starts, unless `skills.autoSync` is false. Never
 * throws: a sync that cannot run is logged and startup carries on with the skills
 * as they are.
 */
export function syncBundledSkillsOnBoot(config: Pick<JinnConfig, "skills">): void {
  if (config.skills?.autoSync === false) return;
  try {
    report(syncInstanceBundledSkills());
  } catch (error) {
    logger.error(
      `Bundled skills were not synced (startup continues): ${error instanceof Error ? error.message : String(error)} `
      + "— skills.autoSync: false in config.yaml turns this start-up sync off.",
    );
  }
}

const listed = (label: string, names: readonly string[]): string[] => (names.length > 0 ? [`${label} ${names.join(", ")}`] : []);

// By name: without one the option brings back every bundled skill the operator deleted.
const RESTORE_BY_NAME = '"ryoko migrate --restore-deleted-skills <name>"';

/** A run that changed nothing logs nothing, and a skill left untouched is mentioned
 *  once per package version (the sync keeps that tally), so restarts stay quiet. */
function report(result: BundledSkillSync): void {
  const changes = [
    ...listed("added", result.added),
    ...listed("updated", result.updated),
    ...listed("retired", result.retired),
    ...(result.adopted.length > 0 ? [`now tracking ${result.adopted.length} unmodified (${result.adopted.join(", ")})`] : []),
  ];
  if (changes.length > 0) {
    logger.info(`Bundled skills synced: ${changes.join("; ")}.${result.backupDir ? ` Previous copies are in ${result.backupDir}.` : ""}`);
  }
  // Only a receipt proves an edit. Without one, a skill that differs may simply be the
  // copy an earlier release installed, so it is not described as the user's change.
  const announced = (reason: KeepReason) => result.notices.filter((skill) => skill.reason === reason).map((skill) => skill.name);
  const edited = announced("modified");
  const unrecorded = announced("unmanaged");
  const removed = announced("deleted");
  // Each case gets the steps that work for it. A recorded skill that goes missing
  // counts as deleted, so it needs the option; an unrecorded one is simply installed.
  if (edited.length > 0) {
    logger.warn(
      `Bundled skills not updated to the newer shipped version because they were edited locally: ${edited.join(", ")}. `
      + `To take the shipped version, move the skill's directory aside and run ${RESTORE_BY_NAME}; see docs/skills.md.`,
    );
  }
  if (unrecorded.length > 0) {
    logger.warn(
      "Bundled skills left untouched because they differ from every shipped version and nothing records how they were installed, "
      + `so an older shipped copy cannot be told from your own edits: ${unrecorded.join(", ")}. `
      + "To take the shipped version, move the skill's directory aside and restart; see docs/skills.md.",
    );
  }
  if (removed.length > 0) {
    logger.info(`Bundled skills not reinstalled because they were removed from this home: ${removed.join(", ")}. Run ${RESTORE_BY_NAME} to put one back.`);
  }
  for (const failure of result.failed) logger.warn(`Bundled skill "${failure.name}" was not synced: ${failure.error}`);
  if (result.skipped === "skills-root-symlink") logger.debug("Bundled skills not synced: skills/ is a symlink the user manages.");
  if (result.skipped === "newer-receipt") logger.debug("Bundled skills not synced: this home was last synced by a newer OpenRyoko.");
}
