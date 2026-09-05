import type { EngineResult } from "../shared/types.js";
import { accumulateSessionCost } from "./registry.js";

/** Record exactly one engine-run delta. Engines that cannot report cost may
 * still report turns, and a reported cost with no turn count is one turn. */
export function recordTurnAccounting(sessionId: string, result: Pick<EngineResult, "cost" | "numTurns">): void {
  accumulateSessionCost(sessionId, result.cost ?? 0, result.numTurns ?? 1);
}
