import { z } from 'zod';

/**
 * What each trigger kind accepts. It sits beside `model.ts` rather than inside
 * it so the filter surface can grow without pushing that file past its size
 * budget; the node schema that wraps it stays there.
 */
export const triggerConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('schedule'), cron: z.string(), timezone: z.string() }),
  z.strictObject({
    kind: z.literal('event'),
    eventName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
    tokenRef: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('todo-status'),
    status: z.string(),
    /** Who performed the status transition — `operator` for the human surface,
     *  `session:<uuid>` for an agent, `reconciler`/`policy:trust` for derived
     *  moves. This is the only filter that is an authority boundary: a label
     *  any employee can attach is not one. */
    actor: z.string().min(1).max(120).optional(),
    /** Opt out of `workflows.armingDelegates`, so an `actor: operator` filter on
     *  this binding means the operator and nobody the operator has delegated
     *  arming to. `false` is the only storable value: leaving it unset is what
     *  accepting delegates looks like. */
    delegates: z.literal(false).optional(),
    label: z.string().min(1).max(80).optional(),
    department: z.string().min(1).max(80).optional(),
    /** Matched against the Todo's assignee, which the `assigned` STATUS does not
     *  imply: assigning is its own action (`assignWorkItem`), and a plain status
     *  move to `assigned` leaves the assignee null. Filtering on `assignee` for
     *  such a Todo never fires — pick the status the assignment itself produces. */
    assignee: z.string().min(1).max(80).optional(),
    /** These three read the Todo's CURRENT row when the trigger fires rather than
     *  the provenance snapshot frozen into the status event, so a Todo re-tagged,
     *  reassigned, or re-parented after it moved is judged as it stands now.
     *  `true` is the only storable value: a persisted `false` reads as a filter
     *  that is set and matches everything, which is never what an author meant. */
    unlabeled: z.literal(true).optional(),
    unassigned: z.literal(true).optional(),
    rootOnly: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal('workflow-call') }),
]);
