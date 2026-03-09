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
Uses `chokidar` to watch `~/.jimmy/` for changes and trigger appropriate reloads:
- `config.yaml` changes → reload gateway configuration
- `cron/jobs.json` changes → reschedule cron jobs
- `org/` changes → rebuild employee registry

### SQLite Session Registry
Stores session metadata (id, engine, employee, connector source, timestamps) in `jimmy.db`.

## Data Flow

1. Connector receives an external message (e.g., Slack message)
2. Connector normalizes the message and calls session manager
3. Session manager resolves the target employee and engine
4. Session manager creates or reuses a session for the source reference
5. Engine processes the message (Claude CLI or Codex SDK)
6. Engine streams or returns the result
7. Session manager delivers the result back through the originating connector
8. WebSocket server broadcasts the event to any connected web UI clients
