import { logger } from "../shared/logger.js";
import { JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js";
import { buildTemplateReplacements, readPortalName } from "../shared/templateReplacements.js";
import type { JinnConfig } from "../shared/types.js";
import { getPackageVersion } from "../shared/version.js";
import { syncBundledSkills } from "./sync.js";
import type { BundledSkillSync } from "./types.js";

/** Sync the skills this package ships into this instance's home. Gateway start and
 *  `ryoko migrate` both go through here, so they can never disagree about a skill. */
export function syncInstanceBundledSkills(): BundledSkillSync {
  return syncBundledSkills({
    templateDir: TEMPLATE_DIR,
    home: JINN_HOME,
    replacements: buildTemplateReplacements(readPortalName()),
    packageVersion: getPackageVersion(),
  });
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
    logger.error(`Bundled skills were not synced (startup continues): ${error instanceof Error ? error.message : String(error)}`);
  }
}

const listed = (label: string, names: readonly string[]): string[] => (names.length > 0 ? [`${label} ${names.join(", ")}`] : []);

const TAKE_SHIPPED = "To take the shipped version, move the skill's directory aside and restart; see docs/skills.md.";

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
  const edited = result.notices.filter((skill) => skill.reason === "modified").map((skill) => skill.name);
  const unrecorded = result.notices.filter((skill) => skill.reason !== "modified").map((skill) => skill.name);
  if (edited.length > 0) {
    logger.warn(`Bundled skills not updated to the newer shipped version because they were edited locally: ${edited.join(", ")}. ${TAKE_SHIPPED}`);
  }
  if (unrecorded.length > 0) {
    logger.warn(
      "Bundled skills left untouched because they differ from the shipped version and nothing records how they were installed, "
      + `so an older shipped copy cannot be told from your own edits: ${unrecorded.join(", ")}. ${TAKE_SHIPPED}`,
    );
  }
  for (const failure of result.failed) logger.warn(`Bundled skill "${failure.name}" was not synced: ${failure.error}`);
  if (result.skipped === "skills-root-symlink") logger.debug("Bundled skills not synced: skills/ is a symlink the user manages.");
  if (result.skipped === "newer-receipt") logger.debug("Bundled skills not synced: this home was last synced by a newer OpenRyoko.");
}
