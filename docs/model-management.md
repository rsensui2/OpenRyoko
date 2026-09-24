# Model management

OpenRyoko discovers models from the installed Codex and Claude CLIs. Open **モデル設定** (`/models`) to refresh the catalog, choose a default policy, manage Slack notifications, or inspect employee and cron model pins.

## Default policies

Existing installations retain their configured defaults until a policy is explicitly selected.

- **おすすめに自動追従** (`auto`): resolve the selected profile from the current CLI catalog and apply it to new conversations.
- **通知して選ぶ** (`notify`): retain the current default and offer the new recommendation in Slack or the web UI.
- **特定モデルに固定** (`fixed`): preserve the selected ID. Explicit model selection sets this mode.

Profiles use provider catalog ordering and Claude's resolved aliases, not lexicographic model-ID sorting:

| Profile | Codex family | Claude selection |
| --- | --- | --- |
| Economy | Luna | Haiku |
| Balanced | Sol | Account default |
| Performance | Astra | Fable when listed, otherwise Opus |

These are task profiles, not price guarantees. A newly named family is still selectable from the discovered catalog. If no model matches a profile, the existing default is retained; a different family is never guessed. CLI/account defaults may differ: an Astra recommendation from Codex does not override the user's balanced/Sol preference.

Each successful default change records a rollback. **以前のモデルに戻して固定する** restores the previous model and effort, then disables following for that engine. It rejects a rollback when another operation has since changed the default. Existing conversations retain their model and inherited effort when the default changes. Inherited employee/cron settings affect future conversations; explicit pins remain intact.

## Discovery and compatibility

Discovery runs at gateway startup and every six hours. Manual refresh has a 30-second cooldown and shares an in-flight request. It sends no user prompt and starts no inference turn.

- Codex: app-server `initialize`, `initialized`, and paginated `model/list`, excluding hidden entries. Effort choices come from returned capabilities; unsupported OpenRyoko effort values are filtered.
- Claude: streaming CLI initialization response, including `resolvedModel` and supported effort levels. SDK initialization is version-dependent; an incompatible response fails closed.
- Gemini retains its existing manual configuration; this iteration adds live discovery for Codex and Claude.

The discovery process uses the same configured binary and child-environment policy as regular engine execution. It runs in an empty temporary directory, with bounded output, a 20-second deadline and process-group cleanup. Claude discovery disables settings sources and MCP configuration. CLI failures do not expose stderr or credential data. Model metadata, notification receipts and one rollback per engine are stored in `models/state.json` with restricted permissions.

A catalog entry means **listed by this CLI**, not a completed inference test. Discovery intentionally does not spend inference tokens. Login/CLI updates can still be required. Failure retains the previous default and displays a retry hint; cached entries loaded after restart cannot authorize a change until refreshed. Updates to CLI protocols still require an OpenRyoko code change.

Explicit `models:` registries and their capability restrictions are not widened by discovery. Intentionally selecting a new default adds only that selected model's capabilities to an explicit registry and keeps custom entries. All model selectors retain custom-ID entry for deployments with private providers.

## Slack

Set **設定 → モデルの自動追従 → 管理者Slack ID** (`portal.operatorSlackId`) to the operator's immutable `U…` ID and save. Enable **Interactivity** in the Slack app configuration; newly generated manifests include it. Socket Mode must already be configured.

Send `@Ryoko モデル設定` in a channel, or `モデル設定` in a DM. The settings card is ephemeral. It supports default selection, profile/policy changes, refreshing, rolling back, clearing a pin, and setting the notification channel. In an existing idle conversation it also offers a model change for that conversation's engine. Busy or queued conversations cannot be switched. Cross-engine conversation switching is not offered.

Actions are checked against the current operator ID and connector allowlist, and bound to a channel, issuing user and 30-minute one-use token. Display names, trusted-speaker lists and arbitrary user-supplied model/action payloads do not grant settings authority. Notifications use channel-bound actions that only the operator can activate. Opening settings does not invoke AI.

Configure a notification connector/channel in the web UI, or choose **このチャンネルで通知**. Recommendations are deduplicated and failed deliveries are retried on later checks. Clear the channel to disable notifications. Updates are silent unless a destination has been configured.

## Employee and cron pins

The web table shows the explicit model and effective inherited model for every employee and non-command cron job. Search, choose individual models, or select several pins to return to inheritance. Clearing a cron pin still inherits a model pinned on its employee; the table names that source. Prompt text, schedules, enabled state and other fields are preserved. Remote employee model availability is not inferred from the local CLI; model selection for those employees remains in their individual configuration.

## Scope of this change

Model catalog refresh and model following are automatic. Installing new Ryoko/CLI versions, rebuilding Docker images and deployment rollback continue through the existing update/release workflow. This feature does not install software from Slack or pretend that updating the host CLI updates a container. Workflow-node overrides and direct scripts outside Ryoko are not included in the employee/cron table.

## API

- `GET /api/models`: read-only snapshot; never performs discovery or a settings change.
- `POST /api/models/actions`: bounded, schema-validated actions (`refresh`, `policy`, `default`, `accept`, `rollback`, `pin`, `notification`). Uses the existing gateway authentication and origin protections.

Config writes share the API/onboarding serialization lock, read the latest unredacted config and atomically replace it. Model management never persists a masked GET response. Like other YAML update paths, regenerated YAML does not retain comments.

References: [Codex app server](https://learn.chatgpt.com/docs/app-server#list-models-modellist), [Claude model configuration](https://code.claude.com/docs/en/model-config), [Slack actions](https://docs.slack.dev/tools/bolt-js/concepts/actions/).
