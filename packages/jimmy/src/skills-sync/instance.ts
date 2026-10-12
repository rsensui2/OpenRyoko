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
  if (result.notices.length > 0) {
    logger.warn(
      `Bundled skills left untouched because they differ from the shipped version: ${result.notices.map((skill) => skill.name).join(", ")}. `
      + "Local changes are never overwritten. To take the shipped version, move the skill's directory aside and restart; see docs/skills.md.",
    );
  }
  for (const failure of result.failed) logger.warn(`Bundled skill "${failure.name}" was not synced: ${failure.error}`);
  if (result.skipped === "skills-root-symlink") logger.debug("Bundled skills not synced: skills/ is a symlink the user manages.");
  if (result.skipped === "newer-receipt") logger.debug("Bundled skills not synced: this home was last synced by a newer OpenRyoko.");
}
