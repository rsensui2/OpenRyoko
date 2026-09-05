/** work-items shim — refuse every Todo claim so no dispatch can ride a Todo
 *  that OpenRyoko cannot track. Unreachable while the event feed stays empty. */

export interface ClaimWorkItemInput { workItemId: string; owner: string }
export type ClaimWorkItemResult =
  | { state: 'acquired' }
  | { state: 'held'; claim: { owner: string } };

export function claimWorkItem(_input: ClaimWorkItemInput): ClaimWorkItemResult {
  return { state: 'held', claim: { owner: 'work-items-not-ported' } };
}

export function releaseWorkItemClaim(_workItemId: string, _owner: string): boolean {
  return false;
}
