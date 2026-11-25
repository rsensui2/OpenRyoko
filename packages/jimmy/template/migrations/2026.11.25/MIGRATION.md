---
auto: false
---

# 2026.11.25: memory guidance, message search in text written without spaces, and conversations with outsiders

Do not change trusted speakers, operator IDs, response policies, engine settings, Codex or Claude Code settings, Slack app scopes, cron jobs, instructions, or memory for this migration. The only permitted configuration edit is the final `jinn.version` update to `2026.11.25`. This migration ships one reference document and no configuration patch.

There are no bundled skill changes in this release. The steps below are the same whatever the migration prompt says about the skill sync, including when it says nothing.

## 1. Reference document

`files/docs/memory.md` is the new `docs/memory.md`. It has no setup-time placeholders, so it is placed as it is.

- If `docs/memory.md` in the instance home is missing, place `files/docs/memory.md` there.
- If it exists and differs, back it up as the migrate skill describes, then replace it with `files/docs/memory.md`. Reference documents are replaced whole. If the old copy holds a passage that is plainly the owner's own note, do not merge it into the new file: quote it in your report so the owner can decide where it belongs.

Do not edit `MEMORY.md`, `knowledge/`, `AGENTS.md`, `CLAUDE.md`, `SOUL.md` or `IDENTITY.md`.

## 2. Tell the owner: behavior that changes without new settings

First read `config.yaml` and work out what the instance has configured. A usable ID is a non-empty string: Slack user IDs start with `U` or `W`; Discord user IDs are digits only and have to be written in quotes. A number written without quotes is configured but unusable (the gateway ignores it and logs a warning). An operator key with an empty value or `null` counts as not set; the settings page leaves one behind when its field is cleared.

- **No ID-based trust.** `portal.trustedSpeakers` has no entry, and neither `portal.operatorSlackId` nor `portal.operatorDiscordId` is set. The first three items below do not apply to this instance. Say so, and still report the other items.
- **Otherwise the first three items apply, platform by platform.** For Slack and for Discord, whichever the instance has a connector for (`connectors.slack`, `connectors.discord`, or an entry under `connectors.instances`), say which of these holds:
  - a usable ID of that platform is configured: the people listed are trusted there, and everyone else is treated as an outsider;
  - none is: everyone who speaks on that platform, the owner included, is treated as an outsider. If a value is there but unusable, tell the owner to put it in quotes; if no ID of that platform was ever entered, tell the owner to add one. Do not edit the configuration yourself. In a one-to-one direct message the correction takes effect on the next message; in a channel, a session that was already handled that way stays so until `/new`.

The items:

- **Slack and Discord conversations with someone outside the trusted speakers are told to leave long-term memory alone.** A conversation counts as one when the speaker's platform ID is neither in `portal.trustedSpeakers` nor an operator ID (a message with no ID counts too); when the assistant has already handled a message from such a speaker in the same session (messages it did not answer do not count), which lasts until `/new`; or when the message comes from a channel Slack reports as shared beyond the workspace. In a one-to-one direct message only the current speaker's ID is looked at. In such a conversation:
  - the main assistant, and another Ryoko if one answers, is told not to create or change `MEMORY.md`, `knowledge/`, `SOUL.md`, `IDENTITY.md` (for another Ryoko: its own memory and `persona`) or its instructions because of what is said there. Until now these conversations received the same memory guidance as the owner's;
  - the gateway's prompt no longer puts that session into first-run onboarding or points it at `BOOTSTRAP.md`. An instruction in the instance's own `AGENTS.md` still stands;
  - the engine's own cross-session memory is kept out of the run, for Codex and for Claude Code run on this machine: Codex is started with `memories.use_memories=false` and `memories.generate_memories=false` (after any `cliFlags` of an employee, so they win), and Claude Code with auto memory off even when `engines.claude.autoMemory` is `true` or notes that were never migrated have kept it on. Gemini, Antigravity and Claude Code run over SSH are unchanged. With interactive Claude Code, the terminal of a thread is restarted once when the thread first counts as one with outsiders.

  A session that runs as an employee has no memory guidance to begin with and gets only the engine part. The same treatment holds when such a session is woken by a finished job or child session. What is not covered: the decision looks at whose messages were handled and at the channel, not at everyone who can read the reply, so a trusted speaker's thread in an ordinary channel is unchanged, and the first post of a thread is passed as context whoever wrote it; a child session started from such a conversation is not classified; Telegram and WhatsApp conversations are not classified. A session in which such a message was handled carries `externalSpeakerSeen` in `transportMeta` on `GET /api/sessions` (never one for a one-to-one direct message, where no mark is kept).
- **To have what a colleague says recorded, the colleague's ID has to be in `portal.trustedSpeakers`.** That also loads `MEMORY.md` into one-to-one direct messages with that person. Tell the owner both halves; do not add anyone yourself.
- **When Slack does not return a channel's information, that message is treated as coming from a shared channel.** If the owner's assistant stops recording what trusted people say in channels, the Slack app probably lacks `channels:read` (public channels), `groups:read` (private channels) or `mpim:read` (group direct messages). Do not change scopes yourself.
- **The memory guidance in the main assistant's prompt is reworded.** It now says what is worth recording (corrections, standing preferences, decisions and their reasons, verified procedures, pitfalls), asks for how a fact is known and its date, asks for a wrong note to be corrected in place together with other files that still state the old version, asks for a promise to behave differently to be recorded in the same turn, and says that `MEMORY.md` is loaded only into web sessions and one-to-one direct messages with trusted speakers. No file is changed by this; notes written from now on may look different. Employee sessions have no such guidance, and another Ryoko's is unchanged apart from the item above.
- **The Agents View Canvas hint** is shown only in the owner's own conversations, no longer in scheduled jobs and other people's threads.

## 3. Tell the owner: what is new

- **Message search finds words inside text written without spaces.** `GET /api/search/messages` and the search box of the web UI used to match whole words only, and a run of Japanese, Chinese, Korean or Thai text counts as one long word, so a word in the middle of a sentence was not found. A query that contains kana, a CJK ideograph, a Hangul syllable, or a Thai, Lao, Burmese or Khmer letter is now matched as a substring, newest first. Any other query is matched by whole words first; when that leaves room in the result, messages that contain the terms inside a longer run of text (a Latin word written straight against Japanese, or part of a word) are added, newest first. The substring match looks at the newest 200,000 messages. On its own it uses the first eight terms of the query, each up to 64 characters; nothing is added to whole-word matches from a query longer than that, so every result holds every term. It also answers every query where FTS5 is unavailable, where search used to return nothing. It runs in the gateway's own process: a search for a rare term took about a quarter of a second at the full 200,000 messages in testing, and the gateway does nothing else meanwhile.
- **`scope=conversations` and `source=`** on `GET /api/search/messages`: the first leaves out scheduled-job and workflow sessions and sessions that record a parent session; the second keeps only the named sources (for example `source=slack,web`). Each result carries the session's `source`.
- **The main assistant is told about the search** in web sessions, in scheduled jobs that run as the main assistant, and in one-to-one direct messages from the operator when the operator's ID is also listed in `portal.trustedSpeakers`, so that it can look up what was said earlier before asking again. Sessions that run as an employee or another Ryoko, which includes every workflow step, are not told, and neither are other people's conversations. This is a matter of what the prompt offers; the endpoint answers any caller that holds the instance's token, as before.
- **If the instance uses the Codex engine**, mention that `docs/memory.md` now describes Codex's own memories feature: what it loads into the gateway's sessions and from which threads it is built. `codex features list` shows whether the feature is on. Do not change Codex's configuration.

After reporting, update only `jinn.version`.
