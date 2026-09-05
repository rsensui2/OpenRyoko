# Organization

{{portalName}} supports an organizational structure with employee personas, departments, ranks, and inter-agent communication through boards.

## Employee Personas

Employee files live at `~/.ryoko/org/<department>/<name>.yaml`.

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

Each department is a directory under `~/.ryoko/org/` containing:

```
~/.ryoko/org/engineering/
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

`org/` starts empty. {{portalName}} itself is the executive (COO) and is not
defined as an org employee — employees are the workers {{portalName}} delegates to.

The onboarding skill proposes a starter scaffold matched to the user's profile
(e.g. an `engineering/` department with a `dev-assistant` employee for a solo
developer), and the management skill handles hiring from there. An employee
file looks like:

```yaml
name: dev-assistant
displayName: Dev Assistant
department: engineering
rank: employee
engine: claude
model: claude-opus-5
persona: |
  You are a careful software engineer. You implement tasks assigned by
  {{portalName}}, report progress on the board, and escalate blockers.
```
