# Model management

OpenRyoko discovers models from the installed Codex and Claude CLIs. Open **モデル設定** (`/models`) to refresh the catalog, choose a default policy, manage Slack notifications, or configure task families, effort, and fallback counterparts.

## Default policies

Existing installations retain their configured defaults until a policy is explicitly selected.

- **選んだ系列に自動追従** (`auto`): resolve the selected family (or legacy profile) from the current CLI catalog and apply it to new conversations.
- **通知して選ぶ** (`notify`): retain the current default and offer the new recommendation in Slack or the web UI.
- **特定モデルに固定** (`fixed`): preserve the selected ID. Explicit model selection sets this mode.

Legacy profiles use provider catalog ordering and Claude's resolved aliases, not lexicographic model-ID sorting:

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

Explicit `models:` registries and their capability restrictions are not widened by discovery. Intentionally selecting a default, task family, or fallback family adds only the selected model's capabilities to an explicit registry and keeps custom entries. All model selectors retain custom-ID entry for deployments with private providers.

## Slack

Set **設定 → モデルの自動追従 → 管理者Slack ID** (`portal.operatorSlackId`) to the operator's immutable `U…` ID and save. Enable **Interactivity** in the Slack app configuration; newly generated manifests include it. Socket Mode must already be configured.

Send `@Ryoko モデル設定` in a channel, or `モデル設定` in a DM. The settings card is ephemeral. It supports default families and depth, profile/policy changes, refreshing, rollback, fallback enablement and directional family counterparts, task family/depth selection, clearing a pin, and the notification channel. The task selector includes up to 100 entries; the web table exposes all entries. In an existing idle conversation it also offers a model change for that conversation's engine. Busy or queued conversations cannot be switched. Manual cross-engine conversation switching is not offered; configured failure recovery can switch providers.

Actions are checked against the current operator ID and connector allowlist, and bound to a channel, issuing user and 30-minute one-use token. Display names, trusted-speaker lists and arbitrary user-supplied model/action payloads do not grant settings authority. Notifications use channel-bound actions that only the operator can activate. Opening settings does not invoke AI.

Configure a notification connector/channel in the web UI, or choose **このチャンネルで通知**. Recommendations are deduplicated and failed deliveries are retried on later checks. Clear the channel to disable notifications. Updates are silent unless a destination has been configured.

## Family following and task loadouts

Choose a family card to enable automatic following of that family. A family is extracted from CLI IDs such as `gpt-6-sol`, `gpt-5.6-terra`, or `claude-opus-5-5[1m]`. Numeric generations are compared within a family (5.10 follows 5.9); CLI ordering breaks ties between variants. Unknown naming formats remain selectable as fixed models. A missing family never changes into another family.

Default policies accept optional `family` and `effort` fields. A family overrides the legacy profile. Depth choices use CLI capabilities and explicit registry restrictions. The requested depth is retained across updates; unsupported depths round down in low/medium/high/xhigh/max order, or use the lowest supported level if none are lower. Models without effort receive no explicit effort.

The task table covers employees, non-command cron jobs and workflow employee nodes. Each can inherit its parent, follow a family, or pin a version. Model and effort controls are separate. For workflow nodes, an explicit engine/model pin (including a materialized family selection) drops the employee effort default; omitted node effort uses the engine default instead. Select a node depth explicitly to keep a task-specific depth. Clearing a cron model still inherits a model pinned on its employee. Workflow engine overrides use that engine's default when no model is bound. Prompt text, schedules, enabled state and delivery fields remain unchanged.

Following rules live in `modelManagement.rules` and record the requested family/depth plus the last applied model/depth. The service materializes resolved IDs in employee/cron definitions and revision-checked workflow definitions. Refresh checks that the target still matches the last applied settings before upgrading it. External model, engine or effort edits pause following instead of being overwritten; select the family again to resume. Deleting a target, failed discovery, or a missing family preserves the current settings. Rules run on startup and every six hours after successful discovery. Task following is automatic; notify-before-change applies to engine defaults only.

Remote employees and workflow nodes with dynamic employee/engine/model/effort bindings require their individual configuration. Command cron jobs and scripts outside Ryoko are excluded. Existing workflow runs keep their definition revision; updated definitions apply to future runs. Employee defaults may be resolved again at the next dispatch.

## Cross-provider recovery

The fallback switch enables Claude → Codex and Codex → Claude chains, with the initial directional family maps below. Each direction is independently editable; removing an entry uses the other provider's default. Turning the switch off clears both providers' chains and sets the session strategy to wait. Workflow nodes with their own fallback override keep that override.

| Codex | Initial Claude counterpart |
| --- | --- |
| Astra | Fable |
| Sol | Opus |
| Terra | Sonnet |
| Luna | Haiku |

These are editable starting choices, not claims of equal quality or cost. Pinned model IDs still participate in fallback. Existing exact `engines.<from>.fallbackModelMap` entries take precedence; otherwise `modelManagement.familyFallbacks` chooses the latest listed counterpart family that the target registry permits. A missing counterpart uses the target default. Explicit registries retain capability restrictions; opting into a family authorizes registering future members of that family.

Both session and workflow recovery use the counterpart map. Replacement depth is adjusted to supported values. Session recovery stops and confirms termination of the original process, carries bounded work context, and visits each provider at most once. User cancellation and completed responses do not trigger fallback. Workflow recovery continues through its existing availability/retry rules and honors node-level fallback exclusions. Model discovery is not an inference test and cannot guarantee that a provider has remaining quota.

## Software updates

Catalog refresh and family following do not install Ryoko or CLI software. CLI updates, Docker rebuilds and deployment rollback continue through the existing release workflow. Gemini remains manually configured.

## API

- `GET /api/models`: read-only snapshot; never performs discovery or a settings change.
- `POST /api/models/actions`: bounded, schema-validated actions (`refresh`, `policy`, `default`, `accept`, `rollback`, `pin`, `follow`, `effort`, `default-effort`, `fallback`, `fallback-family`, `notification`). Uses the existing gateway authentication and origin protections.

Config writes share the API/onboarding serialization lock, read the latest unredacted config and atomically replace it. Model management never persists a masked GET response. Like other YAML update paths, regenerated YAML does not retain comments.

References: [Codex app server](https://learn.chatgpt.com/docs/app-server#list-models-modellist), [Claude model configuration](https://code.claude.com/docs/en/model-config), [Slack actions](https://docs.slack.dev/tools/bolt-js/concepts/actions/).

Example task actions:

```json
{"action":"follow","kind":"cron","id":"news-job","family":"sol"}
{"action":"effort","kind":"cron","id":"news-job","effort":"medium"}
{"action":"fallback-family","engine":"codex","family":"sol","targetFamily":"opus"}
```

Workflow target IDs use `workflow-id/node-id`. Use actual IDs from the snapshot; job names may differ from IDs. Authenticated settings actions do not launch the selected task.
