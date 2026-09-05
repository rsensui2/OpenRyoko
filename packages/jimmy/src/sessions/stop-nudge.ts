/**
 * A turn that ends on narration has decided nothing: nothing submitted, no
 * terminal claim, no block reported. Both surfaces that own tracked work — the
 * workflow attempt and the delegated child — answer it the same way, with a
 * bounded, counted nudge sent at that turn's own end. Each nudge is itself a
 * turn, so the count is what closes the loop; after MAX_STOP_NUDGES the caller
 * falls back to whatever it did before.
 *
 * What counts as narration differs by surface, because the evidence differs. A
 * workflow attempt owns a submit tool and a fenced output block, so a turn that
 * used neither has objectively delivered nothing and the text only has to fail
 * to claim otherwise. A delegated child has no such tool — its reply IS the
 * deliverable — so there the classifier keeps the delegation contract's
 * fail-safe bias and fires only on an explicit continuation assertion. Both
 * surfaces share the suppressors, the wording, and the budget.
 */

/** Two, so a model that narrates twice still gets one more chance to submit
 *  before the surface stops talking and lets its own timeout logic run. */
export const MAX_STOP_NUDGES = 2;

export const STOP_NUDGE_TEXT =
  "A plain-text reply is not a terminal state. Your linked Todo is still open and this turn ended on narration "
  + "rather than on a result. Continue the work now and finish the deliverable, then submit it the way this task "
  + "requires. If you cannot finish it, say plainly that you are blocked and what is blocking you. Do not end "
  + "another turn on a promise of future action.";

const EXPLICIT_UNFINISHED_SIGNAL = /\b(?:i(?: am|['’]m) still working (?:on|through)|i(?: will|['’]ll) continue (?:working\b|(?:with\s+)?(?:this|the|my)\s+(?:task|work|implementation|fix|patch|change|migration|feature|deliverable|test run)|with (?:the )?remaining (?:work|implementation|checks|tests?))|(?:(?:the|this|my)\s+)?(?:task|work|implementation|fix|patch|change|migration|feature|deliverable)\s+(?:is|remains)\s+(?:incomplete|still in progress)|not (?:done|finished|complete))\b/i;
const TERMINAL_SIGNAL = /\b(final report|completed|complete|done|finished|shipped|implemented|resolved|all tests pass(?:ed)?|(?:tests?|checks?) (?:now )?pass(?:ed)?|ready for review|ready to merge|(?:the )?(?:pr|patch) (?:is )?ready|commit (?:sha|hash)|hand(?:-| )?off)\b/i;
const PARENT_WAIT_SIGNAL = /\?|\b(need (?:your|the parent's) input|please confirm|which (?:option|approach)|should i|would you|let me know|blocked (?:on|by)|waiting on|awaiting (?:approval|confirmation|input)|waiting for (?:approval|confirmation|input|you|the parent)|(?:need|missing|without|awaiting) (?:the )?(?:credentials?|access|permissions?|api key|token|secret))\b/i;

/** Whether this final text claims the work reached a terminal state. */
function hasTerminalSignal(text: string): boolean {
  return TERMINAL_SIGNAL.test(text.replace(/\bnot\s+(?:done|finished|complete)\b/gi, " "));
}

/** Whether this final text is a progress note and nothing more. */
export function isNonTerminalNarration(text: string): boolean {
  // Incidental mentions of work, running services, remaining items, or next
  // steps are not evidence that the task remains unfinished. Without a submit
  // tool to fall back on, the nudge requires a first-person continuation
  // assertion, a task-bound incomplete/still-in-progress assertion, or explicit
  // negated completion. Mixed terminal + unfinished clauses are ambiguous, and
  // ambiguity surfaces to the parent rather than authorizing a nudge.
  if (!EXPLICIT_UNFINISHED_SIGNAL.test(text)) return false;
  return !hasTerminalSignal(text) && !PARENT_WAIT_SIGNAL.test(text);
}

/**
 * Whether this turn end earns a stop nudge, given how many it has already had.
 *
 * The caller has already established that the turn submitted nothing, so the
 * text cannot be asked to prove the work is unfinished — ordinary progress talk
 * ("I am reviewing the remaining files now") is the whole case this exists for.
 * It only has to leave the two claims a nudge would contradict unmade: that the
 * work is done, and that the turn is waiting on an answer. An empty final text
 * asserts neither but narrates nothing either, so it stays with the ladder.
 */
export function planStopNudge(input: { finalText: string; stopNudgesSent: number }): boolean {
  const text = input.finalText.trim();
  if (input.stopNudgesSent >= MAX_STOP_NUDGES || text.length === 0) return false;
  return !hasTerminalSignal(text) && !PARENT_WAIT_SIGNAL.test(text);
}
