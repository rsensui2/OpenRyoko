---
# `ryoko migrate --auto` (`ryoko update`) does not record this migration as applied:
# it has steps that need an AI session or the owner. `ryoko migrate` applies it.
auto: false
---

# Migration: 0.3.0 (MCP Integration, Session Limits, Cron Alerting)

## Summary

This release adds the Model Context Protocol (MCP) integration system, session cost/duration limits, and cron failure alerting. Employees now automatically get browser, search, fetch, and gateway MCP tools injected into their sessions.

## Template files changed

### `config.default.yaml`
- `jinn.version` bumped from `"0.2.0"` to `"0.3.0"`
- Added entire `mcp:` section with four built-in servers (browser, search, fetch, gateway) and custom server support
- Added `sessions.maxDurationMinutes: 30` and `sessions.maxCostUsd: 10.00` — per-session resource limits
- Added `cron:` section with commented-out `alertConnector` and `alertChannel` keys

### New: `docs/mcp.md`
- New documentation file explaining MCP integration, built-in servers, custom servers, per-employee overrides, and environment variable usage

## New config keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mcp.browser.enabled` | boolean | `true` | Enable Playwright browser automation MCP |
| `mcp.browser.provider` | string | `"playwright"` | Browser provider (`"playwright"` or `"puppeteer"`) |
| `mcp.search.enabled` | boolean | `false` | Enable Brave web search MCP |
| `mcp.search.provider` | string | `"brave"` | Search provider |
| `mcp.search.apiKey` | string | _(unset)_ | Brave API key (or use `${BRAVE_API_KEY}` env var) |
| `mcp.fetch.enabled` | boolean | `true` | Enable URL fetch/parse MCP |
| `mcp.gateway.enabled` | boolean | `true` | Enable built-in gateway MCP (messaging, sessions, org, cron tools) |
| `sessions.maxDurationMinutes` | number | `30` | Maximum session duration in minutes (overridable per-employee) |
| `sessions.maxCostUsd` | number | `10.00` | Maximum session cost in USD (overridable per-employee) |
| `cron.alertConnector` | string | _(unset)_ | Connector to send cron failure alerts to (e.g. `"slack"`) |
| `cron.alertChannel` | string | _(unset)_ | Channel for cron failure alerts (e.g. `"#alerts"`) |

## Database migration

New columns added to the sessions table (handled automatically on gateway start):
- `total_cost` — accumulated cost in USD for the session
- `total_turns` — number of engine turns in the session

**No manual action needed.**

## Merge instructions

1. **New file**: Copy `files/docs/mcp.md` to `~/.jinn/docs/mcp.md`. This is a new file — no conflict possible.

2. **Config**: Add the following sections to `config.yaml` if not already present. Do NOT overwrite existing values — only add missing keys:
   - Add the `mcp:` section (with browser, search, fetch, gateway sub-keys) after `connectors:`
   - Add `sessions.maxDurationMinutes: 30` and `sessions.maxCostUsd: 10.00` — if `sessions:` exists but is empty (`{}`), replace it with the new keys
   - Add the `cron:` section with commented alert keys

3. **No skill changes** in this release.
4. **Database**: Handled automatically on gateway start.

## Files

- `files/config.default.yaml` — updated default config for reference
- `files/docs/mcp.md` — new MCP integration documentation
