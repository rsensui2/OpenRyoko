# OpenRyoko 2026.11.12

This release fixes Slack thread messages incorrectly bypassing air-reading triage after the bot has replied.

The conversation tracker does not see every participant: someone may have spoken before the bot joined, be excluded by `allowFrom`, or be another bot. Thread replies now check Slack history before treating the conversation as one-to-one. A thread with another participant or incomplete history goes through normal triage. A thread confirmed to contain only the current person and the bot still bypasses triage. Opening group mentions also go through triage in active threads.

Direct messages, explicit bot mentions, channel-level conversation tracking, and triage-disabled behavior are unchanged. Non-mentioned thread messages can require additional Slack history reads, bounded by the existing four-page limit and shared within the message.

## Response settings

`respondTo.engagedThreads` still defaults to `true`. For strict mention-only channel replies, use both settings:

```yaml
connectors:
  slack:
    respondTo:
      channel: mention
      engagedThreads: false
```

`allowFrom` remains a separate restriction: an excluded speaker is ignored even when they mention the bot. This upgrade does not change these settings.

## Upgrade

Use Node.js `^22.23.4`, `^24.22.1`, or `^26.12.1`. Install `openryoko@2026.11.12` using your existing deployment method, run `ryoko migrate` in the environment running the gateway, and restart it through its existing service manager. For Docker installations, rebuild and recreate the service with the new package; preserve the instance home and other mounted data.

The migration reports the behavior change and updates only `jinn.version`. It does not change response policies, allowlists, jobs, instructions, or memory.

Fix: [#119](https://github.com/rsensui2/OpenRyoko/pull/119).
