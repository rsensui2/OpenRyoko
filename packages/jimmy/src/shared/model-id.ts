/**
 * What a model id may be spelled with.
 *
 * An id is compared verbatim against what an engine's CLI accepts, so there is no
 * useful universal rule about its shape — antigravity serves `Gemini 3.5 Flash
 * (Medium)`, spaces and parentheses included. What there IS a rule about is the
 * characters no id has and a MANGLED one carries: `agy models` began printing
 * `id<TAB>label`, the parser kept the whole line, and that composite was handed to
 * `--model` and written into config as if it were an id.
 *
 * A control character is the tell. Nothing else here can separate a good id from a
 * bad one without asking the CLI, and by then the turn has already failed.
 */

/** ASCII controls and DEL. Tab is the one that arrived live; the rest travel the same way. */
const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;

/** Whether a string can be a model id at all: nonempty, and no control character. */
export function isSpellableModelId(value: string): boolean {
  return value.trim().length > 0 && !CONTROL_CHARACTER_RE.test(value);
}
