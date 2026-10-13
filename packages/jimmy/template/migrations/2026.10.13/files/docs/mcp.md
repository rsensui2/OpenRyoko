# MCP (Model Context Protocol) Integration

{{portalName}} automatically configures MCP servers for AI engine sessions, giving employees access to browser automation, web search, and gateway tools without manual setup.

## How It Works

1. MCP servers are defined in `config.yaml` under the `mcp:` section
2. When a session starts, {{portalName}} resolves which MCP servers the employee needs
3. A temporary MCP config JSON file is written to `~/.ryoko/tmp/mcp/`
4. The file is passed to Claude Code via `--mcp-config <path>`
5. The file is cleaned up after the session completes

## Built-in MCP Servers

### Browser (Playwright)
Full browser automation — navigate, click, type, screenshot, extract content.

```yaml
mcp:
  browser:
    enabled: true
    provider: playwright  # or "puppeteer"
```

### Web Search (Brave)
Search the web and get structured results.

```yaml
mcp:
  search:
    enabled: true
    provider: brave
    apiKey: ${BRAVE_API_KEY}  # reads from environment variable
```

### Fetch
Extract readable content from URLs (HTML → markdown/text).

```yaml
mcp:
  fetch:
    enabled: true
```

### Gateway
Built-in MCP server that wraps {{portalName}}'s own API. Gives employees tools to:
- Send messages via connectors (Slack, etc.)
- List and query sessions
- Manage cron jobs
- Query the org structure
- Update department boards

```yaml
mcp:
  gateway:
    enabled: true  # enabled by default
```

## Custom MCP Servers

Add any MCP server via the `custom:` section:

```yaml
mcp:
  custom:
    my-database:
      enabled: true
      command: npx
      args: ["-y", "@my/mcp-server-postgres"]
      env:
        DATABASE_URL: ${DATABASE_URL}
    my-api:
      command: node
      args: ["/path/to/my-mcp-server.js"]
```

## Per-Employee Overrides

Employees can opt out of MCP servers or request only specific ones:

```yaml
# In employee YAML (e.g. org/engineering/backend-dev.yaml)
name: backend-dev
mcp: false  # No MCP servers at all

# Or specific servers only:
mcp:
  - search
  - gateway
```

By default, all globally enabled MCP servers are available to all employees.

## Environment Variables

API keys and secrets should use `${VAR_NAME}` syntax to reference environment variables:

```yaml
mcp:
  search:
    apiKey: ${BRAVE_API_KEY}
  custom:
    stripe:
      env:
        STRIPE_KEY: ${STRIPE_SECRET_KEY}
```

This keeps secrets out of config files.
