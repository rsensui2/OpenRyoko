/** work-items shim — no run ledger means no history to guard on; always clear.
 *  Unreachable while the event feed stays empty. */

export interface RespawnGuardHold { state: 'held'; guard: string; reason: string }
export type RespawnGuardVerdict = { state: 'clear' } | RespawnGuardHold;
export interface RespawnGuardOptions { quotaWindowDecided?: boolean }

export function checkRespawnGuard(
  _workItemId: string,
  _now: Date = new Date(),
  _opts: RespawnGuardOptions = {},
): RespawnGuardVerdict {
  return { state: 'clear' };
}

export function appendRespawnGuardHold(_workItemId: string, _hold: RespawnGuardHold, _actor: string): void {
  // audit-only upstream; nothing to record without the Todo event log
}
