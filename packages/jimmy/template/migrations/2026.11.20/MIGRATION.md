---
auto: false
---

# 2026.11.20: Slack setup from the web UI, air-reading providers, and several Ryokos

Do not change response policies, triage settings, connector instances, employees, cron jobs, instructions, or memory for this migration. The only permitted configuration edit is the final `jinn.version` update to `2026.11.20`. This migration ships no configuration patch; every new feature is off until the owner uses it.

## 1. Bundled skill

The bundled skill that changed in this release is `openryoko-config` (its `references/jev.md` now describes `jev.provider` and the per-provider key API). `files/skills/` holds it whole. How to handle it depends on the prompt that started this session.

- **The prompt says bundled skills were synced** ("Bundled skills were synced before this session started."): apply `files/skills/openryoko-config` only if the prompt lists it among the skills the sync left untouched, and handle it as the prompt says for that skill. Do not rewrite a skill the prompt says to leave alone (a symlink, unreadable, too large, not a directory), and do not add anything for a skill it says needs nothing.
- **The prompt says `skills/` is a user-managed symlink and no bundled skill was synced**: place `openryoko-config` if it is missing; if it exists, merge the new `references/jev.md` while keeping the owner's additions.
- **The prompt has no sync information**: do not apply this migration, and ask the owner to run `ryoko migrate` in the environment that runs the gateway.

## 2. Tell the owner: behavior that changes without new settings

- **Slack bots configured under `connectors.instances` start a new conversation once.** Session keys for those bots now begin with the instance id (for example `slack-hana:dm:U…`) instead of `slack:`, so a DM or thread on such a bot does not continue its previous session after the upgrade. The bot under `connectors.slack` keeps its existing keys and conversations. Check `config.yaml`: if it has no Slack entry under `connectors.instances`, this item does not apply to this owner. Still check the items below.
- **One assistant no longer continues another assistant's session.** A bot bound to an employee or a peer Ryoko starts a new session instead of continuing another assistant's session under the same key, and a session created from this version on does not continue across two bots. A session that an employee-bound instance created before the upgrade (with a `slack:` key) can still be continued by the main bot; if the owner has employee-bound Slack instances, tell them they can send `/clear` in a main-bot DM that looks affected.
- **`send_message` without a connector posts through the conversation's own bot.** In a conversation that came through an instance whose id is `slack-` followed by lowercase letters, digits, or hyphens, it now posts through that instance's bot instead of the main bot. That bot must be in the target channel, or the post fails.
- **A message to a `connectors.instances` entry bound to a missing employee is dropped.** If an instance names an employee that no longer exists (deleted, renamed, or a YAML that does not parse), the message gets no reply and a warning is logged. It used to be answered by the main assistant.
- **An instance whose id is `slack`, `discord`, `telegram`, or `whatsapp`, or has leading or trailing spaces, is skipped** with a warning. If the owner has one, tell them to rename it, and that renaming starts its conversations over again and that anything naming the old id (for example a cron job's `delivery.connector`, or `cron.alertConnector`) must change with it. Do not rename it yourself.

## 3. Tell the owner: new features (nothing is on until they use it)

- **Slack setup from the web UI** (`/connect/slack`). With a Slack app configuration token, OpenRyoko creates the app, sets its icon, and installs it; the owner then pastes one App-Level Token. When the gateway is served over http, Slack's install redirect goes through a public static relay page that hands the one-time code back to the gateway address in the browser; nothing is stored there. `OPENRYOKO_SLACK_OAUTH_RELAY` points to a different relay page (an https URL with no query or fragment; anything else falls back to the default page), and serving the gateway over https avoids the relay. The configuration token is kept only while a setup is in progress. Setting up again after Slack is connected creates a new app.
- **"Slack での振る舞い" at the top of the settings page**: when to speak (DMs, group DMs, channels, threads), per-channel exceptions (`respondTo.channels`), and how to read the room.
- **Air-reading providers**: a Slack connector's `triage.jev.provider` (for example `connectors.slack.triage.jev.provider`) chooses `typesafe` (the default, unchanged), `openrouter`, or `openai` (OpenAI Decisions API). Slack message text sent for a decision goes to the provider chosen. OpenAI needs an OpenAI Platform API key; a ChatGPT or Codex sign-in is not one.
- **Several Ryokos** ("Ryoko たち" in the sidebar): another assistant beside the main one, with its own name, personality, engine, and Slack app, and a choice of sharing the main memory or keeping its own. Keeping its own memory is an instruction to the AI, not file isolation: the engine can still read any file in the home.

After reporting, update only `jinn.version`.
