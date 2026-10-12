# Architecture

{{portalName}} runs as a single Node.js process acting as a gateway between external connectors and AI engines.

## Components

```
┌─────────────────────────────────────────────────┐
│              {{portalName}} Gateway                │
│                                                  │
│  ┌───────────┐  ┌────────────┐  ┌────────────┐  │
│  │ HTTP Server│  │ WebSocket  │  │   Cron     │  │
│  │ REST + UI  │  │  Server    │  │ Scheduler  │  │
│  └─────┬─────┘  └─────┬──────┘  └─────┬──────┘  │
│        │               │               │         │
│  ┌─────┴───────────────┴───────────────┴──────┐  │
│  │            Session Manager                  │  │
│  │  Routes messages, manages engine lifecycle  │  │
│  └─────────────────┬──────────────────────────┘  │
│                    │                              │
│  ┌─────────────────┴──────────────────────────┐  │
│  │           Engine Abstraction                │  │
│  │  ┌──────────────┐  ┌───────────────────┐   │  │
│  │  │ Claude Engine │  │   Codex Engine    │   │  │
│  │  │ (spawns CLI)  │  │   (uses SDK)      │   │  │
│  │  └──────────────┘  └───────────────────┘   │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ Connector  │  │   File     │  │  SQLite   │  │
│  │  System    │  │  Watcher   │  │  Registry │  │
│  └────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────┘
```

### HTTP Server
REST API for session management, configuration, and health checks. Also serves the static web UI.

### WebSocket Server
Pushes live events (session updates, engine output, cron results) to connected clients.

### Session Manager
Central router. Receives messages from connectors, resolves the target employee and engine, creates or reuses sessions, and delivers responses back through the originating connector.

### Engine Abstraction
Uniform interface over different AI backends:
- **Claude Engine**: Spawns `claude` CLI as a child process with `--resume` for session continuity
- **Codex Engine**: Uses the Codex SDK directly in-process

### Connector System
Modular adapters that implement a standard interface. Each connector translates between its platform's message format and {{portalName}}'s internal message format. See `connectors.md`.

### Cron Scheduler
Uses `node-cron` to run scheduled AI jobs. Watches `cron/jobs.json` for hot-reload. See `cron.md`.

### File Watcher
Uses `chokidar` to watch `~/.ryoko/` for changes and trigger appropriate reloads:
- `config.yaml` changes → reload gateway configuration
- `cron/jobs.json` changes → reschedule cron jobs
- `org/` changes → rebuild employee registry

### SQLite Session Registry
Stores session metadata (id, engine, employee, connector source, timestamps) in `sessions/registry.db`.

## Data Flow

1. Connector receives an external message (e.g., Slack message)
2. Connector normalizes the message and calls session manager
3. Session manager resolves the target employee and engine
4. Session manager creates or reuses a session for the source reference
5. Engine processes the message (Claude CLI or Codex SDK)
6. Engine streams or returns the result
7. Session manager delivers the result back through the originating connector
8. WebSocket server broadcasts the event to any connected web UI clients

## Session Lifecycle

What the gateway does when a turn does not end the ordinary way.

### Turns cut off by a restart

A turn that was still running when the gateway stopped — an update, a manual restart, a crash — is resumed after the restart: on the next start the gateway sends that session one notification saying the restart cut it off. The session re-checks what was in flight, picks the request back up and answers in the conversation it came from; when its reply was already written and only the delivery was cut off, it sends what is missing. It is on by default:

```yaml
sessions:
  resumeInterruptedOnBoot: true          # false turns it off
  resumeInterruptedMaxAgeMinutes: 120    # an interruption older than this is not resumed
```

- **Not resumed**: cron runs (the job runs again at its next scheduled time), workflow attempts (the workflow replaces them itself), and turns the queue will re-run by itself after the restart — a message sent to a web session, a child's completion, a job wake-up. A turn whose reply had already been delivered, and a conversation that has since been written to and answered again, are left alone too.
- **Limits**: one start wakes at most 10 sessions, the most recently active first and 15 seconds apart; the others are left as they are. A session is not woken again within 30 minutes unless new work reached it in between, and never more than 3 times in 24 hours, so a turn that itself restarts the gateway cannot loop.
- **Turns waiting for a usage limit**: a turn that had met a usage limit and was waiting for it to reset ("I'll continue automatically") is resumed too, but not before the reset it was waiting for — the session is woken a moment after it, not while the limit is known to be on. Until then it shows as `interrupted`, and a new message to it runs at once.
- **Age**: an interruption older than `sessions.resumeInterruptedMaxAgeMinutes` (default 120) when the gateway starts is not resumed. For a turn that was waiting for a usage limit, the age counts from the reset.
- **Turning it off**: set `sessions.resumeInterruptedOnBoot: false`. Interrupted sessions are then left as they are, and continue only when someone writes to them.

Both settings are read when the gateway starts.

### Other outcomes to expect

- **An engine process that ends without having been stopped is a failed turn.** A newer message, a stop, an engine switch and a gateway shutdown all stop an engine on purpose; none of them is a failure. When the engine's process dies mid-turn and nothing asked for it, the turn fails: with `<engine> stopped unexpectedly: <reason>` for Claude in interactive (PTY) mode, with the process's exit code for a headless run. A message that came in through a connector gets the error as its reply, the session ends in `error`, its parent session is told, and a cron run is written to the run log as `error` (see `cron.md`). A turn started by a notification rather than a person's message posts nothing; the session's status carries the error. The session itself is intact: its next turn starts a new process and continues the same engine session.
- **Child completions reach a busy parent as one turn.** While a parent is still working, the completions of its children are collected — up to 32, more than that continue in a further turn — and delivered as a single turn when it is free, so it answers once instead of once per child. Each is still recorded in the parent's transcript as its own notification. A child's failure is never collected: it gets a turn of its own.
- **A parent in `error` is not woken by its children.** A parent stopped by a usage limit or an expired login would fail again for every child that finishes. So the completion is written into its transcript instead, marked as not acted on, and no turn is started, whatever the error was — read it there (`GET /api/sessions/<id>?last=N`) when the parent runs again. The exception is a parent that failed with `<engine> stopped unexpectedly: …`: it can run again at once, and is woken as usual.
