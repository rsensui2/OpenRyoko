/**
 * work-items shim — OpenRyoko has not ported the upstream Todo (work-items)
 * subsystem. This directory carries only the types and constants the Workflow
 * runtime references, plus inert implementations of the functions the
 * todo-status trigger path calls. With no event feed, that path never fires.
 */
export const TODO_ID_PATTERN = /^([A-Z]{3})-([1-9][0-9]*)$/;
