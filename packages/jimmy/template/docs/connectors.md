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

### Provider Re-login from the Operator's DM (`providerAuth`)

When Claude's or Codex's login expires, every turn fails until someone logs in
again on the host. On a host with no shell to log in from (a read-only
container, a headless server) the operator can do it from Slack instead. It is
off by default.

```yaml
portal:
  operatorSlackId: U0123ABCDE   # required — the only person who can use it

connectors:
  slack:
    providerAuth:
      enabled: true
```

A named Slack instance under `connectors.instances[]` takes the same
`providerAuth` block. Saving the config reloads the connector; the gateway log
then shows `[slack] provider-auth: enabled`. If it shows a warning about
`portal.operatorSlackId` instead, the feature is inert until that is set.

**Using it** — in your own 1:1 DM with the bot:

1. Send `ログイン` (also `再ログイン`, `login`, or `/login`). The bot answers
   with two buttons, *Claude にログイン* and *Codex にログイン*.
2. **Claude**: open the login page from the button, approve, copy the
   authentication code the page shows (it contains a `#`), press *コードを入力*
   and paste it into the dialog. If your browser lands on a
   `http://localhost:…/callback?...` address instead, paste that whole address.
3. **Codex**: open the login page from the button and type in the device code
   the bot shows. Nothing is sent back; the bot notices when you are done.
4. The bot confirms the result with the CLI's own status command and rewrites
   its message — the link and the code are gone from the DM either way. After
   a Codex login it also shows what the CLI reports about the login and asks
   you to confirm the approval was yours (see the note on device codes below).

A login that is not finished within 10 minutes is stopped; press *キャンセル*
to stop it sooner. Only one login per provider runs at a time. Saving the
config (which reloads the connectors) or restarting the gateway also stops a
login in progress — start it again afterwards.

If the bot reports that it cannot read a sign-in link from the CLI, the CLI's
output has changed in a way this version does not understand. Cancel, and log
in on the host instead.

When a turn fails because a login is gone, the bot DMs the operator a button
to log in again — at most once per provider every 30 minutes. This covers
Slack messages, cron jobs, workflows and web chat alike.

**Slack app settings.** Buttons and the code dialog need *Interactivity*
turned on (Socket Mode delivers it; no Request URL is needed), the `chat:write`
and `im:history` bot scopes, and the `message.im` bot event. The manifest
offered in Settings already contains all of these. An app set up by hand needs
Interactivity enabled and a reinstall to the workspace. Slack gives the bot no
way to detect that Interactivity is off — a button that does nothing when
pressed means exactly that.

**What to know before enabling it:**

- It reacts only to `portal.operatorSlackId`, compared exactly, and only in
  that person's 1:1 DM. In channels, group DMs, and for everyone else, the
  bot behaves as if the feature did not exist. If `allowFrom` is set, the
  operator must be on it.
- Whoever controls the operator's Slack account can sign the instance in to a
  provider account of their choosing. Protect that account accordingly.
- Never paste the code into the chat. A bot cannot delete your message, so the
  bot refuses a pasted code, keeps it out of the session and the log, and asks
  you to delete it yourself.
- The link and the device code stay in the DM until the login ends, and are
  never written to the gateway log or the session database. Slack itself may
  retain edited messages under your workspace's retention and export settings.
- **A Codex device code works for whoever sees it.** That is how a device
  login is built: the code is typed into a browser, and the CLI is signed in
  to whichever account that browser is using. Someone who can read the
  operator's DM while a Codex login is open — a shared screen, a workspace
  admin, a second device — can enter the code with *their own* ChatGPT
  account. The instance then runs as that account, and the bot reports a
  perfectly successful login. So: treat the code like a password for those
  minutes, and when the bot reports success, make sure you had finished the
  browser step yourself. If a Codex login completes and you had not, log in
  again at once. Claude is not exposed to this — its code only ever travels
  from you to the CLI, through the dialog.
- The CLI runs with the same binary (`engines.<name>.bin`) and environment as
  the engine, so the credentials land where the engine reads them
  (`~/.claude` or `CLAUDE_CONFIG_DIR`; `~/.codex`). In a container that
  location must be writable and must survive a restart.
- Employees with `sshHost` run on another machine; their login is not touched.
- Codex's device-code login is governed by a setting in ChatGPT's security
  settings, per account or workspace. If the Codex login ends at once, check
  that it is allowed there.
- In the operator's DM, `/login` opens this menu rather than being passed to
  Claude Code.

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
