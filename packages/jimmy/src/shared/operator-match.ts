/**
 * Operator identity matching.
 *
 * `portal.operatorName` is a display nickname ("亮介") while chat platforms
 * report speakers by profile fields ("泉水亮介", "Ryosuke Sensui", "rsensui").
 * The old exact-match comparison flagged even the operator himself as
 * "NOT the operator" on every turn — a false warning the model learned to
 * ignore, which then let REAL non-operator speakers be mistaken for the
 * operator. This module is the single shared matcher for the system-prompt
 * identity block and the Slack triage, plus an explicit escape hatch
 * (`portal.operatorAliases`) for names no heuristic can bridge.
 */

/** NFKC-fold, trim and lowercase so "Ryosuke" / "ryosuke" / full-width forms compare equal. */
function normalizeAlias(s: string): string {
  return s.normalize("NFKC").trim().toLowerCase();
}

/**
 * Does any of the speaker's known aliases identify the operator?
 *
 * Match rules per (speakerAlias, operatorAlias) pair, after normalization:
 *  - exact match, or
 *  - one contains the other, provided the SHORTER side is at least 2
 *    characters (so a single kanji/letter can never claim operatorship).
 *
 * `operatorAliases` (from `portal.operatorAliases`) are checked alongside
 * `operatorName`; configure them when the heuristic is not enough (e.g. the
 * operator's Slack profile shares a substring with a teammate's name).
 */
export function isOperatorSpeaker(
  speakerAliases: Array<string | undefined | null>,
  operatorName?: string,
  operatorAliases?: string[],
): boolean {
  const operators = [operatorName, ...(operatorAliases ?? [])]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(normalizeAlias);
  if (operators.length === 0) return false;

  const speakers = speakerAliases
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(normalizeAlias);

  for (const sp of speakers) {
    for (const op of operators) {
      if (sp === op) return true;
      const shorter = sp.length <= op.length ? sp : op;
      if (shorter.length >= 2 && (sp.includes(op) || op.includes(sp))) return true;
    }
  }
  return false;
}
