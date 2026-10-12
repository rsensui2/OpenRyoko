# Migration: 0.7.5 (File Attachments, Mobile Sidebar, Connector Improvements)

## Summary

Releases v0.3.1 through v0.7.5 include significant gateway and dashboard improvements but **no template file changes** beyond what was covered in migrations 0.3.0 and 0.7.3. This migration exists to bump the version stamp and document the feature additions.

## Template files changed

None. All changes in this range are gateway code, web dashboard, and runtime improvements.

## Version bump

Update `jinn.version` in `config.yaml` from the previous migration version to `"0.7.5"`.

## Notable features added (no migration action needed)

### v0.3.1 — macOS Sleep Prevention
- Gateway runs `caffeinate` to prevent macOS from sleeping while active

### v0.4.0 — Gateway-to-Gateway File Transfer
- `POST /api/files/transfer` endpoint for remote file sharing between Jinn instances (since removed, together with the `remotes` config key: do not use or configure it)
- Claude crash recovery with retry and session resume on restart

### v0.5.0–v0.5.2 — Stability & Notifications
- Kanban board wired to gateway API
- System prompt token usage reduced ~70%
- Browser push notifications and notification history
- Agent interrupt on new message (v0.5.2)
- 12+ bug fixes

### v0.6.0 — New Connectors & Queue Management
- Discord connector with channel routing
- WhatsApp connector via Baileys with QR pairing
- Persistent queue management with pause/resume
- Portal UI redesign (chat sidebar, settings, session management)

### v0.7.0 — Project Phoenix Dashboard
- Complete dashboard overhaul with new layout and navigation

### v0.7.2 — Session Delete Fix
- Fixed crash when deleting sessions from the web UI

### v0.7.3 — Stale Session Recovery
- Fixed infinite retry loop from stale engine session IDs
- Added `?last=N` message filtering to sessions API
- (Template changes covered in 0.7.3 migration)

### v0.7.4 — Onboarding Persistence
- Onboarding wizard state persisted server-side (survives new browsers)

### v0.7.5 — File Attachments & Polish
- Drag & drop file attachments in chat
- Collapsible sidebar toggle
- Markdown-to-mrkdwn conversion for Slack and WhatsApp connectors
- Mobile sidebar improvements

## Optional config additions

These config keys are supported but **not required** — the gateway uses sensible defaults:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connectors.discord.token` | string | _(unset)_ | Discord bot token (enable Discord connector) |
| `connectors.discord.channels` | object | _(unset)_ | Channel ID → name mapping for Discord routing |
| `connectors.whatsapp.enabled` | boolean | `false` | Enable WhatsApp connector |
| `portal.onboarded` | boolean | `false` | Whether onboarding wizard has been completed |

These are opt-in features. Only add them if you want to use Discord or WhatsApp connectors.

## Merge instructions

1. **Config**: Update `jinn.version` to `"0.7.5"`. No other config changes required.
2. **No template file changes** — nothing to copy or merge.
3. **Database**: Schema changes are handled automatically on gateway start.

## Files

No files directory — this migration is version-stamp only.
