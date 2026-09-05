import { isDeepStrictEqual } from "node:util";
import { resolveBinding, WorkflowBindingError, type WorkflowBindingContext } from "./bindings.js";
import type { ConditionPredicate, JsonValue } from "./model.js";

/**
 * Evaluating the predicate language. A Condition node routes on it, and a
 * Workflow Call node with `iterate` asks it whether the round that just finished
 * wants another one — so it lives here rather than in `runner.ts`, which now has
 * two callers instead of one.
 */

function resolved(binding: ConditionPredicate["left"], context: WorkflowBindingContext): { exists: boolean; value?: JsonValue } {
  try { return { exists: true, value: resolveBinding(binding, context) }; }
  catch (error) {
    if (error instanceof WorkflowBindingError && error.code === "missing-value") return { exists: false };
    throw error;
  }
}

/** `contains` and `in` are the same test read from opposite ends: does the
 *  haystack hold the needle, for a substring or for an array member. */
function holds(haystack: JsonValue | undefined, needle: JsonValue | undefined): boolean {
  if (typeof haystack === "string") return typeof needle === "string" && haystack.includes(needle);
  return Array.isArray(haystack) && haystack.some((item) => isDeepStrictEqual(item, needle));
}

/** Ordering, which only numbers have. Anything else compares false rather than
 *  falling back to JavaScript's coercion, which would order "10" before "9". */
function ordered(operator: ConditionPredicate["operator"], left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (typeof left !== "number" || typeof right !== "number") return false;
  return operator === "gt" ? left > right
    : operator === "gte" ? left >= right
      : operator === "lt" ? left < right : left <= right;
}

export function predicateMatches(predicate: ConditionPredicate, context: WorkflowBindingContext): boolean {
  const left = resolved(predicate.left, context);
  if (predicate.operator === "exists") return left.exists;
  if (predicate.operator === "not-exists") return !left.exists;
  if (!left.exists || !predicate.right) return false;
  const right = resolved(predicate.right, context);
  if (!right.exists) return false;
  if (predicate.operator === "equals") return isDeepStrictEqual(left.value, right.value);
  if (predicate.operator === "not-equals") return !isDeepStrictEqual(left.value, right.value);
  if (predicate.operator === "contains") return holds(left.value, right.value);
  if (predicate.operator === "in") return holds(right.value, left.value);
  return ordered(predicate.operator, left.value, right.value);
}

/** Every predicate in `all` has to hold, and the first case that does wins. */
export function predicatesHold(all: readonly ConditionPredicate[], context: WorkflowBindingContext): boolean {
  return all.every((predicate) => predicateMatches(predicate, context));
}
