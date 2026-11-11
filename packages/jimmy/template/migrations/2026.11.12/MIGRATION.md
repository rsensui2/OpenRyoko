---
auto: false
---

# 2026.11.12: Slack thread participant checks

Do not change existing response policies, allowlists, cron jobs, instructions, or memory for this migration. The only permitted configuration edit is the final `jinn.version` update to `2026.11.12`. This migration ships no replacement files or configuration patch; the code change works without new settings.

## Notify the owner

When Slack triage is enabled, a recent reply in a thread no longer proves that the conversation is one-to-one. Non-mentioned messages now bypass triage only if complete Slack history shows that only the current person and the bot have spoken, and the message does not open by addressing others. A thread with another person or bot, incomplete history, or an unavailable history read goes through normal triage. This also applies to people excluded by `allowFrom` and participants who spoke before the bot joined.

These history reads use the existing four-page limit and are shared within each message. They can add Slack API calls and latency to non-mentioned thread replies. Real DMs, explicit mentions, channel-level conversation tracking, and triage-disabled behavior are unchanged.

`respondTo.engagedThreads` still defaults to `true`; the release does not turn it off. Strict mention-only channel replies require both `respondTo.channel: mention` and `respondTo.engagedThreads: false`. `allowFrom` remains a separate restriction and can exclude a speaker even when they mention the bot. Describe these settings to the owner if relevant, but do not change them as part of this migration.

After reporting the behavior change, update only `jinn.version`. If the migration prompt says bundled skills were synced, follow its skip/merge instructions; if it says `skills/` is a user-managed symlink, leave it alone. If the prompt has no sync information, do not apply this migration and ask the owner to run `ryoko migrate` in the environment that runs the gateway. There are no bundled skill changes in this release.
