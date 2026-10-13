---
# `ryoko migrate --auto` (`ryoko update`) does not record this migration as applied:
# it has steps that need an AI session or the owner. `ryoko migrate` applies it.
auto: false
---

# Migration: 0.9.0 (Hierarchical Org, Service Routing, Multi-Instance Connectors)

## Summary

Major release adding infinite-depth hierarchical org tree via `reportsTo` field, cross-department service routing with LCA-based path resolution, chain-of-command context injection, multi-instance connector support, and Homebrew formula.

## Template files changed

- `CLAUDE.md` — added hierarchy documentation (reportsTo, chain of command), cross-department service routing API docs
- `AGENTS.md` — same hierarchy and service routing updates as CLAUDE.md
- `skills/management/SKILL.md` — updated hiring (auto-detect reportsTo), firing (reassign direct reports), promotion (report reassignment)

## Version bump

Update `jinn.version` in `config.yaml` to `"0.9.0"`.

## New features

### Hierarchical Org Tree
- Employees can declare `reportsTo: <employee-name>` in their YAML
- Gateway resolves full tree automatically with smart defaults (infers hierarchy from rank when `reportsTo` is absent)
- Supports infinite depth, cross-department reporting, cycle detection
- Advisory delegation — hierarchy informs context prompts but never blocks direct access
- Same-rank rule: employees of equal rank never implicitly report to each other

### Cross-Department Service Routing
- Employees can declare `provides` services in their YAML:
  ```yaml
  provides:
    - name: code-review
      description: "Review PRs and provide feedback"
  ```
- `GET /api/org/services` — list all available services across the org
- `POST /api/org/cross-request` — route a service request to the provider, creating a session with a formatted brief
- LCA (Lowest Common Ancestor) algorithm for routing path resolution
- Manager chain tracking for audit/tracing
- Collision handling: higher-ranked employee wins, alphabetical tiebreak

### Chain-of-Command Context
- Employee prompts now include rich chain-of-command section: department, manager (with rank), direct reports (with ranks), escalation path
- Available services from other departments listed with API usage instructions
- Replaces the old simple `reportsTo` / `directReports` lines

### Multi-Instance Connectors (PR #23)
- Connectors (Slack, Discord, etc.) can now run multiple instances with different configurations
- Each instance gets its own channel mapping and credentials

### Homebrew Formula (PR #33)
- `brew install hristo2612/tap/jinn` now works
- Includes Node.js dependency management

## Employee YAML changes

New optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `reportsTo` | `string \| string[]` | Who this employee reports to (primary parent used for hierarchy) |
| `provides` | `ServiceDeclaration[]` | Services this employee provides to the org |

Example:
```yaml
name: jimmy-dev
displayName: Jimmy Dev
rank: senior
department: platform
reportsTo: jimbo
provides:
  - name: code-review
    description: "Review PRs and provide feedback"
```

## Merge instructions

1. **Config**: Update `jinn.version` to `"0.9.0"`.
2. **Template files**: Merge the updated `CLAUDE.md`, `AGENTS.md`, and `skills/management/SKILL.md` from the template. These contain new documentation sections — merge carefully with any user customizations.
3. **Employee YAMLs**: Optionally add `reportsTo` and `provides` fields to employee definitions. The system works without them (smart defaults infer hierarchy from rank).
4. **Database**: No schema changes — handled automatically on gateway start.

## Files

No files directory — template file updates should be merged manually or via AI.
