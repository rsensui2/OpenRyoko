/** Why a skill the package ships (or used to ship) was left exactly as it is. */
export type KeepReason =
  /** The skill is a symlink, or holds one: the user manages it. */
  | "symlink"
  /** Something that is not a directory occupies the skill's name. */
  | "not-directory"
  /** We placed it, the user edited it, and the shipped version has since changed. */
  | "modified"
  /** We placed it and the user edited it; the shipped version is still the one we placed. */
  | "customized"
  /** No record that we placed it, and it differs from the shipped version. */
  | "unmanaged"
  /** No longer shipped, but the user edited the copy we placed. */
  | "retired-modified"
  /** We placed it and it is gone from the home: the operator removed it. Gateway
   *  start leaves it out; only an explicit `ryoko migrate` puts it back. */
  | "deleted"
  /** It could not be inspected (permissions, I/O). */
  | "unreadable";

export interface KeptSkill {
  name: string;
  reason: KeepReason;
}

export interface FailedSkill {
  name: string;
  error: string;
}

/** What one run of the sync did. Skill names in every list are sorted. */
export interface BundledSkillSync {
  /** Shipped skills the home did not have. */
  added: string[];
  /** Unmodified skills replaced with a newer shipped version. */
  updated: string[];
  /** Skills that already matched the shipped version and are now recorded. */
  adopted: string[];
  /** Unmodified skills the package no longer ships, moved to the backup directory. */
  retired: string[];
  /** Skills deliberately left untouched. */
  kept: KeptSkill[];
  /** The kept skills to tell the user about now — at most once per package version. */
  notices: KeptSkill[];
  /** Skills whose home copy matches the shipped version once this run is done. */
  inSync: string[];
  /** Skills whose change could not be applied; they are as they were before the run. */
  failed: FailedSkill[];
  /** Where replaced and retired copies went, when there were any. */
  backupDir: string | null;
  /** Set when the run changed nothing by policy rather than by failure. */
  skipped?: "skills-root-symlink" | "newer-receipt";
}
