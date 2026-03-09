# Organization

{{portalName}} supports an organizational structure with employee personas, departments, ranks, and inter-agent communication through boards.

## Employee Personas

Employee files live at `~/.jimmy/org/<department>/<name>.yaml`.

```yaml
name: alice
displayName: Alice
department: engineering
rank: senior
engine: claude
model: opus
persona: |
  You are Alice, a senior engineer focused on backend systems.
  You write clean, well-tested code and prefer simple solutions.
  You review PRs thoroughly and flag potential performance issues.
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Unique identifier (lowercase, no spaces) |
| `displayName` | string | yes | Human-readable name |
| `department` | string | yes | Department directory name |
| `rank` | string | yes | One of: executive, manager, senior, employee |
| `engine` | string | yes | Engine to use: "claude" or "codex" |
| `model` | string | no | Model override (default from config) |
| `persona` | string | yes | System prompt defining personality and behavior |

## Departments

Each department is a directory under `~/.jimmy/org/` containing:

```
~/.jimmy/org/engineering/
  department.yaml     # Department metadata
  board.json          # Shared task board
  alice.yaml          # Employee persona
  bob.yaml            # Employee persona
```

### department.yaml

```yaml
name: engineering
displayName: Engineering
description: Builds and maintains the product codebase.
```

### board.json

A JSON array of task objects used for inter-agent communication:

```json
[
  {
    "id": "task_001",
    "title": "Refactor auth module",
    "assignee": "alice",
    "status": "in-progress",
    "priority": "high",
    "description": "Move auth logic into a dedicated service class.",
    "createdAt": "2026-01-10T14:00:00.000Z",
    "updatedAt": "2026-01-11T09:30:00.000Z"
  }
]
```

Task fields: `id`, `title`, `assignee`, `status` (open, in-progress, done, blocked), `priority` (low, medium, high, critical), `description`, `createdAt`, `updatedAt`.

## Ranks

| Rank | Privileges |
|---|---|
| **executive** | Full access. Can message any employee, modify org structure, create departments. {{portalName}} holds this rank. |
| **manager** | Can message employees in their department. Can assign tasks on their department's board. |
| **senior** | Can message employees in their department. Can update tasks assigned to them. |
| **employee** | Can update tasks assigned to them. Can post to their department's board. |

## Communication

- **Downward**: Higher-ranked agents write tasks to lower-ranked agents' department boards
- **@mentions**: Messages containing `@name` route to that specific employee
- **Board-based**: Agents check their department's `board.json` for assigned tasks
- **Cross-department**: Executives and managers can write to any department's board

## Default Organization

{{portalName}} ships with a single executive employee:

```yaml
name: {{portalSlug}}
displayName: {{portalName}}
department: executive
rank: executive
engine: claude
model: opus
persona: |
  You are {{portalName}}, the executive AI assistant and gateway administrator.
  You manage the organization, delegate tasks, and handle direct requests.
```
