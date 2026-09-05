# Connectors

Connectors are modular adapters that bridge external messaging platforms with {{portalName}}'s session manager.

## Connector Interface

```typescript
interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(sourceRef: string, text: string): Promise<void>;
  addReaction(sourceRef: string, emoji: string): Promise<void>;
  removeReaction(sourceRef: string, emoji: string): Promise<void>;
  editMessage(sourceRef: string, text: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
}

interface IncomingMessage {
  sourceRef: string;     // Unique identifier for routing
  text: string;          // Message content
  userId: string;        // Platform user ID
  userName: string;      // Display name
  connector: string;     // Connector name
}
```

## Slack Connector

Uses `@slack/bolt` with Socket Mode (no public URL required).

### Configuration

```yaml
connectors:
  slack:
    appToken: xapp-...    # Socket Mode app token
    botToken: xoxb-...    # Bot user OAuth token
```

### Response Gating (`respondTo`)

By default the bot responds to every message it can see. `respondTo` adds a
deterministic gate, evaluated before the LLM triage layer, so gated messages
cost zero tokens and zero latency:

```yaml
connectors:
  slack:
    respondTo:
      im: always            # 1:1 DMs — reply without a mention (default: always)
      mpim: mention         # group DMs — reply only when @-mentioned (default: always)
      channel: mention      # channels — reply only when @-mentioned (default: always)
      engagedThreads: true  # keep replying inside threads the bot already
                            # engaged, without a re-mention (default: true)
```

Modes per scope: `always` | `mention` | `never`.

- `mention` drops messages that don't @-mention the bot. With
  `engagedThreads: true`, once the bot has replied (or reacted) in a thread,
  follow-ups in that thread flow without a re-mention — mention once, then
  converse naturally.
- `never` silences a scope entirely, including mentions.
- Unset scopes default to `always`, so existing configs keep the legacy
  respond-to-everything behavior.
- `respondTo` composes with `triage`: the gate decides *may we respond at
  all* (hard policy), triage decides *should we* (air-reading). Messages
  dropped by the gate never reach triage.

### Thread Mapping

Slack messages are mapped to sessions based on conversation context:

| Slack Context | Source Ref Format | Session Behavior |
|---|---|---|
| Direct message | `slack:dm:<userId>` | One session per DM user |
| Channel root message | `slack:<channelId>` | One session per channel |
| Thread reply | `slack:<channelId>:<threadTs>` | One session per thread |

### Reaction Workflow

Reactions provide visual feedback during processing:

1. Message received → add :eyes: reaction (acknowledged)
2. Engine processing...
3. On success → remove :eyes:, add :white_check_mark:
4. On error → remove :eyes:, add :x:

### Employee Routing

- Default: messages route to the default employee ({{portalName}})
- `@mention`: messages mentioning a specific employee name route to that employee
- Thread continuity: replies in a thread continue with the same employee

## Discord Connector

Uses `discord.js` over the Discord gateway (no public URL required).

### Configuration

```yaml
connectors:
  discord:
    botToken: ...         # Discord bot token
    guildId: ...          # optional: only handle messages from this guild
    channelId: ...        # optional: only handle messages from this channel
```

### Response Gating (`respondTo`)

The Discord port of the Slack gate. By default the bot responds to every
message it can see, with one deliberate exception described below (messages
addressed to somebody else); `respondTo` adds a deterministic gate so gated
messages never reach the engine:

```yaml
connectors:
  discord:
    respondTo:
      dm: always            # 1:1 and group DMs (default: always)
      channel: mention      # guild channels/threads — reply only when
                            # @-mentioned or replied to (default: always)
      engagedThreads: true  # keep replying inside threads the bot already
                            # engaged, without a re-mention (default: true)
```

Modes per scope: `always` | `mention` | `never` — same semantics as the Slack
gate, with Discord-specific mention rules:

- A Discord **reply** to one of the bot's messages counts as a mention,
  whether or not the reply pinged (if the replied-to message was since
  deleted, the reply can no longer be attributed and does not count). In flat
  channels (no thread), reply to the bot or re-mention it to continue a
  conversation. Thread engagement is tracked in memory and resets whenever
  the connector is recreated — a gateway restart, a config save, or a
  connector reload — mention the bot once more afterwards.
- Role mentions and `@everyone`/`@here` do **not** count as mentions.
- Messages that @-mention or reply to *somebody else* (and not the bot) are
  always ignored outside DMs, even in `always` scopes and even with
  `respondTo` unset — they're addressed to that person, not the bot. This is
  an intentional behavior change from earlier releases (Slack parity), and
  the one way an unconfigured connector no longer responds to everything.
- Channels proxied via `channelRouting` are gated by the *receiving*
  instance's `respondTo`, not the sender's — the primary forwards the
  resolved addressing so the remote can decide without a Discord round-trip.
  Upgrade the primary first: a primary too old to forward addressing leaves
  the receiver's mention scopes fail-closed (every routed message dropped,
  with a warning in the receiver's log).
- Cross-instance calls authenticate like any API client. Give each route the
  receiving gateway's bearer token (`channelRouting: { "<channelId>":
  { url: "http://remote:7777", token: "..." } }`), and give a remote
  instance the primary's token via `proxyViaToken`. A plain URL string keeps
  working for gateways that run with auth disabled.
- Unset scopes default to `always`. There is no triage layer on Discord —
  this gate is the only response filter.

### Reply Targeting (`replyStyle`)

Where the bot's responses land in flat guild channels (threads and DMs are
already precise destinations and ignore this setting):

```yaml
connectors:
  discord:
    replyStyle: reply    # channel | reply | thread (default: channel)
```

- `channel` (default): plain channel messages — the legacy behavior.
- `reply`: each response is a Discord reply attached to the message that
  triggered it, so conversations stay legible in busy channels. Pairs well
  with `respondTo.channel: mention` — people replying back to the bot count
  as mentions.
- `thread`: the response opens (or reuses) a thread rooted on the
  triggering message and lands there, Slack-style. Each flat-channel
  message then maps to its own session (a public thread reuses its root
  message's ID), so follow-ups inside the thread continue that
  conversation — and count as engaged for `respondTo.engagedThreads`.
  Channels that can't host message threads (voice/stage text chat) use
  `reply` instead, session mapping included; a channel-level refusal
  (missing Create Public Threads permission) is remembered and the channel
  settles into `reply` behavior from the next turn. Note the migration
  effect: switching an existing deployment to `thread` re-keys flat-channel
  conversations, so ongoing channel sessions start fresh from the first
  message after the switch.
- With `channelRouting`, the *primary* instance's `replyStyle` applies —
  it renders every proxied send.

## Future Connectors

The connector interface is designed for additional platforms:
- **iMessage**: macOS-only via AppleScript bridge
- **Web UI**: Built-in, served by the HTTP server
- **CLI**: Direct terminal input/output
