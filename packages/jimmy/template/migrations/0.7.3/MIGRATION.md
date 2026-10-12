---
# `ryoko migrate --auto` (`ryoko update`) does not record this migration as applied:
# it has steps that need an AI session or the owner. `ryoko migrate` applies it.
auto: false
---

# Migration: 0.7.3 (Child Session Protocol, Message Filtering)

## Summary

This release adds the Child Session Protocol to both CLAUDE.md and AGENTS.md templates, ensuring all engine types (Claude Code and Codex) know how to properly delegate to employees via async child sessions. It also adds `?last=N` message filtering to the sessions API and fixes the parent notification wording ("replied" instead of "completed").

## Template files changed

### `CLAUDE.md`
- Added "Child Session Protocol (Async Notifications)" subsection under "The Org System" section, after "Agent teams for multi-phase tasks"
- 21 lines describing the spawn → notify → read-latest → follow-up workflow

### `AGENTS.md`
- Added "Child Session Protocol (Async Notifications)" subsection under "The Org System" section, after "Board Task Schema"
- Same 21-line protocol description as CLAUDE.md

## New API features

| Endpoint | Change | Description |
|----------|--------|-------------|
| `GET /api/sessions/:id` | Added `?last=N` query param | Returns only the last N messages instead of the full history |

## Merge instructions

1. **CLAUDE.md**: Check if a "Child Session Protocol" subsection already exists under "The Org System" section. If not, add the following block after the "Agent teams for multi-phase tasks" subsection (or at the end of "The Org System" section if that subsection doesn't exist):

   ```markdown
   ### Child Session Protocol (Async Notifications)

   When you delegate to an employee via a child session:

   1. **Spawn** the child session (`POST /api/sessions` with `parentSessionId`)
   2. **Tell the user** what you delegated and to whom
   3. **End your turn.** Do NOT poll, wait, sleep, or block.
   4. The gateway automatically notifies you when the employee replies.
      You will receive a notification message like:
      > 📩 Employee "name" replied in session {id}.
      > Read the latest messages: GET /api/sessions/{id}?last=N
   5. When notified, **read only the latest messages** via the API (use `?last=N`
      to avoid context pollution). Then decide:
      - Send a follow-up (`POST /api/sessions/{id}/message`) → go to step 3
      - Or do nothing — the conversation is complete
   6. **Never read the full conversation history** on every notification. Only read
      the latest messages relevant to the current round.

   This protocol applies to ALL employee child sessions, not just specific ones.
   The gateway handles the notification plumbing — you just reply and stop.
   ```

2. **AGENTS.md**: Same check — if "Child Session Protocol" subsection is missing, add the identical block after "Board Task Schema" (inside "The Org System" section).

3. **No config changes** in this release.
4. **No skill changes** in this release.

## Important notes

- If the user's CLAUDE.md or AGENTS.md already contain a "Child Session Protocol" section (e.g. manually added), **do not duplicate it**. Compare the content and only update if the existing version is materially different.
- The protocol references `?last=N` which is a new API feature — it won't work on gateway versions older than 0.7.3.

## Files

- `files/CLAUDE.md` — updated CLAUDE.md template (full file for reference)
- `files/AGENTS.md` — updated AGENTS.md template (full file for reference)
