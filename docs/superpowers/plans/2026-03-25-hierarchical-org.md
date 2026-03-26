# Hierarchical Org System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add infinite-depth hierarchical reporting to the org system — data model, resolver, API, context builder, and dashboard.

**Architecture:** A pure-function resolver (`org-hierarchy.ts`) builds a tree from the flat employee registry. The `reportsTo` YAML field drives explicit reporting; smart defaults infer hierarchy from rank/department. API enriches `GET /api/org` with inline employee objects + hierarchy data, eliminating the N+1 pattern. Dashboard renders the tree in both map and sidebar views.

**Tech Stack:** TypeScript (ES2022), Vitest, dagre (already installed), ReactFlow (already installed), Next.js 15

---

## Phase 1: Data Model + Scanner + Resolver (TDD)

### Task 1: Add types to `types.ts`

**Files:**
- Modify: `packages/jimmy/src/shared/types.ts:195-215` (Employee interface)
- Modify: `packages/jimmy/src/shared/types.ts` (append new interfaces)

- [ ] **Step 1: Add `reportsTo` field to Employee interface**

Add one optional field after `alwaysNotify` (line 214):

```typescript
/** Who this employee reports to. String = single parent. Array = primary + dotted-line (future). */
reportsTo?: string | string[];
```

- [ ] **Step 2: Append new hierarchy interfaces after Employee**

After the `Employee` interface closing brace (line 215), add:

```typescript
/** A node in the resolved org tree. Wraps an Employee with computed hierarchy data. */
export interface OrgNode {
  employee: Employee;
  /** Resolved primary parent name (null = reports to root) */
  parentName: string | null;
  /** Names of direct reports */
  directReports: string[];
  /** Depth in tree (root = 0, root's reports = 1, etc.) */
  depth: number;
  /** Path from root to this node (excluding virtual root), e.g. ["pravko-lead", "pravko-writer"] */
  chain: string[];
}

/** Warning about a hierarchy issue. */
export interface OrgWarning {
  employee: string;
  type: "broken_ref" | "cycle" | "self_ref" | "cross_department" | "multiple_executives";
  message: string;
  /** The invalid reportsTo value that caused this warning */
  ref?: string;
}

/** The fully resolved org hierarchy. */
export interface OrgHierarchy {
  /** Root node name — executive employee name, or null if no executive YAML exists */
  root: string | null;
  /** All nodes keyed by employee name */
  nodes: Record<string, OrgNode>;
  /** Ordered list for flat iteration (topological/BFS order, root first) */
  sorted: string[];
  /** Any resolution warnings */
  warnings: OrgWarning[];
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS (new types are additive, no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add packages/jimmy/src/shared/types.ts
git commit -m "feat(org): add reportsTo field and hierarchy types to Employee interface"
```

---

### Task 2: Parse `reportsTo` in scanner

**Files:**
- Modify: `packages/jimmy/src/gateway/org.ts:28-41` (inside scanOrg YAML extraction)

- [ ] **Step 1: Add `reportsTo` extraction to `scanOrg()`**

In `org.ts`, inside the `Employee` object construction (around line 40, after the `alwaysNotify` line), add:

```typescript
reportsTo: data.reportsTo ?? undefined,
```

- [ ] **Step 2: Also parse `mcp` field if not already parsed**

Check if `mcp` is parsed — it's in the Employee interface but may be missing from `scanOrg()`. If missing, add it too. If already there, skip.

- [ ] **Step 3: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/jimmy/src/gateway/org.ts
git commit -m "feat(org): parse reportsTo field from employee YAML in scanOrg"
```

---

### Task 3: Write failing tests for `org-hierarchy.ts`

**Files:**
- Create: `packages/jimmy/src/gateway/__tests__/org-hierarchy.test.ts`

- [ ] **Step 1: Create test file with all test cases**

```typescript
import { describe, it, expect } from "vitest";
import { resolveOrgHierarchy, getPrimaryParent, getAllParents } from "../org-hierarchy.js";
import type { Employee } from "../../shared/types.js";

// Helper to create a minimal Employee for testing
function emp(
  name: string,
  opts: Partial<Employee> = {},
): Employee {
  return {
    name,
    displayName: opts.displayName ?? name,
    department: opts.department ?? "default",
    rank: opts.rank ?? "employee",
    engine: opts.engine ?? "claude",
    model: opts.model ?? "opus",
    persona: opts.persona ?? `persona for ${name}`,
    reportsTo: opts.reportsTo,
    ...opts,
  };
}

function registry(...employees: Employee[]): Map<string, Employee> {
  const map = new Map<string, Employee>();
  for (const e of employees) map.set(e.name, e);
  return map;
}

// ── getPrimaryParent ────────────────────────────────────────────

describe("getPrimaryParent", () => {
  it("returns undefined for undefined input", () => {
    expect(getPrimaryParent(undefined)).toBeUndefined();
  });

  it("returns the string when given a string", () => {
    expect(getPrimaryParent("boss")).toBe("boss");
  });

  it("returns first element when given an array", () => {
    expect(getPrimaryParent(["boss", "mentor"])).toBe("boss");
  });

  it("returns undefined for empty array", () => {
    expect(getPrimaryParent([])).toBeUndefined();
  });
});

// ── getAllParents ────────────────────────────────────────────────

describe("getAllParents", () => {
  it("returns empty array for undefined", () => {
    expect(getAllParents(undefined)).toEqual([]);
  });

  it("wraps string in array", () => {
    expect(getAllParents("boss")).toEqual(["boss"]);
  });

  it("returns array as-is", () => {
    expect(getAllParents(["boss", "mentor"])).toEqual(["boss", "mentor"]);
  });
});

// ── resolveOrgHierarchy ─────────────────────────────────────────

describe("resolveOrgHierarchy", () => {
  it("handles empty registry", () => {
    const h = resolveOrgHierarchy(new Map());
    expect(h.root).toBeNull();
    expect(h.sorted).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(Object.keys(h.nodes)).toHaveLength(0);
  });

  it("single employee, no reportsTo → reports to root", () => {
    const h = resolveOrgHierarchy(registry(emp("alice")));
    expect(h.root).toBeNull();
    expect(h.nodes["alice"].parentName).toBeNull();
    expect(h.nodes["alice"].depth).toBe(0);
    expect(h.sorted).toEqual(["alice"]);
  });

  it("executive becomes root", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("alice", { department: "eng", reportsTo: "coo" }),
      ),
    );
    expect(h.root).toBe("coo");
    expect(h.nodes["coo"].parentName).toBeNull();
    expect(h.nodes["coo"].depth).toBe(0);
    expect(h.nodes["alice"].parentName).toBe("coo");
    expect(h.nodes["alice"].depth).toBe(1);
  });

  it("linear chain (A → B → C) → correct depths and directReports", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("mgr", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev", { rank: "employee", department: "eng", reportsTo: "mgr" }),
      ),
    );
    expect(h.nodes["coo"].depth).toBe(0);
    expect(h.nodes["mgr"].depth).toBe(1);
    expect(h.nodes["dev"].depth).toBe(2);
    expect(h.nodes["coo"].directReports).toContain("mgr");
    expect(h.nodes["mgr"].directReports).toContain("dev");
    expect(h.nodes["dev"].directReports).toEqual([]);
  });

  it("chain is computed correctly", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("mgr", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev", { rank: "employee", department: "eng", reportsTo: "mgr" }),
      ),
    );
    expect(h.nodes["coo"].chain).toEqual(["coo"]);
    expect(h.nodes["mgr"].chain).toEqual(["coo", "mgr"]);
    expect(h.nodes["dev"].chain).toEqual(["coo", "mgr", "dev"]);
  });

  it("cycle (A → B → C → A) → cycle broken, warning emitted", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("a", { department: "d", reportsTo: "c" }),
        emp("b", { department: "d", reportsTo: "a" }),
        emp("c", { department: "d", reportsTo: "b" }),
      ),
    );
    const cycleWarnings = h.warnings.filter((w) => w.type === "cycle");
    expect(cycleWarnings.length).toBeGreaterThanOrEqual(1);
    // All nodes should be reachable (no infinite loops)
    expect(h.sorted.length).toBe(3);
  });

  it("broken ref → warning emitted, smart default applied", () => {
    const h = resolveOrgHierarchy(
      registry(emp("alice", { department: "eng", reportsTo: "nonexistent" })),
    );
    const brokenWarnings = h.warnings.filter((w) => w.type === "broken_ref");
    expect(brokenWarnings).toHaveLength(1);
    expect(brokenWarnings[0].employee).toBe("alice");
    expect(brokenWarnings[0].ref).toBe("nonexistent");
    // Should fall back to root (no one else in dept)
    expect(h.nodes["alice"].parentName).toBeNull();
  });

  it("self ref → warning emitted, smart default applied", () => {
    const h = resolveOrgHierarchy(
      registry(emp("alice", { department: "eng", reportsTo: "alice" })),
    );
    const selfWarnings = h.warnings.filter((w) => w.type === "self_ref");
    expect(selfWarnings).toHaveLength(1);
    expect(h.nodes["alice"].parentName).toBeNull();
  });

  it("cross-department reporting → warning emitted, relationship preserved", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr", { rank: "manager", department: "eng" }),
        emp("writer", { rank: "employee", department: "marketing", reportsTo: "mgr" }),
      ),
    );
    const crossWarnings = h.warnings.filter((w) => w.type === "cross_department");
    expect(crossWarnings).toHaveLength(1);
    // Relationship is preserved
    expect(h.nodes["writer"].parentName).toBe("mgr");
  });

  it("multiple executives → first (alphabetical) used as root, warning emitted", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("alpha", { rank: "executive", department: "exec" }),
        emp("beta", { rank: "executive", department: "exec" }),
      ),
    );
    expect(h.root).toBe("alpha");
    const multiWarnings = h.warnings.filter((w) => w.type === "multiple_executives");
    expect(multiWarnings).toHaveLength(1);
    expect(multiWarnings[0].employee).toBe("beta");
  });

  it("no executive → root is null, top-level employees have parentName null", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("alice", { rank: "manager", department: "eng" }),
        emp("bob", { rank: "employee", department: "eng", reportsTo: "alice" }),
      ),
    );
    expect(h.root).toBeNull();
    expect(h.nodes["alice"].parentName).toBeNull();
    expect(h.nodes["bob"].parentName).toBe("alice");
  });

  it("smart defaults: manager is preferred parent over senior in same dept", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr", { rank: "manager", department: "eng" }),
        emp("sr", { rank: "senior", department: "eng" }),
        emp("dev", { rank: "employee", department: "eng" }),
      ),
    );
    // sr should report to mgr (higher rank)
    expect(h.nodes["sr"].parentName).toBe("mgr");
    // dev should also report to mgr (highest rank in dept)
    expect(h.nodes["dev"].parentName).toBe("mgr");
  });

  it("smart defaults: employee alone in dept reports to root", () => {
    const h = resolveOrgHierarchy(
      registry(emp("lonely", { rank: "employee", department: "solo" })),
    );
    expect(h.nodes["lonely"].parentName).toBeNull();
  });

  it("smart defaults: two managers in same dept both report to root (same-rank rule)", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr-a", { rank: "manager", department: "eng" }),
        emp("mgr-b", { rank: "manager", department: "eng" }),
      ),
    );
    expect(h.nodes["mgr-a"].parentName).toBeNull();
    expect(h.nodes["mgr-b"].parentName).toBeNull();
  });

  it("smart defaults: two seniors in dept with no manager both report to root", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("sr-a", { rank: "senior", department: "eng" }),
        emp("sr-b", { rank: "senior", department: "eng" }),
      ),
    );
    expect(h.nodes["sr-a"].parentName).toBeNull();
    expect(h.nodes["sr-b"].parentName).toBeNull();
  });

  it("mixed: some explicit reportsTo, some smart defaults → correct tree", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("eng-lead", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev-a", { rank: "employee", department: "eng" }), // smart default → eng-lead
        emp("dev-b", { rank: "employee", department: "eng", reportsTo: "eng-lead" }), // explicit
        emp("mkt-lead", { rank: "manager", department: "mkt" }), // smart default → coo (root)
        emp("writer", { rank: "employee", department: "mkt" }), // smart default → mkt-lead
      ),
    );
    expect(h.nodes["eng-lead"].parentName).toBe("coo");
    expect(h.nodes["dev-a"].parentName).toBe("eng-lead");
    expect(h.nodes["dev-b"].parentName).toBe("eng-lead");
    expect(h.nodes["mkt-lead"].parentName).toBeNull(); // root-level (no explicit, no higher rank in dept)
    expect(h.nodes["writer"].parentName).toBe("mkt-lead");
  });

  it("sorted order is BFS (root first, then depth 1, etc.)", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("mgr", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev", { rank: "employee", department: "eng", reportsTo: "mgr" }),
      ),
    );
    expect(h.sorted.indexOf("coo")).toBeLessThan(h.sorted.indexOf("mgr"));
    expect(h.sorted.indexOf("mgr")).toBeLessThan(h.sorted.indexOf("dev"));
  });

  it("directReports are sorted by department then name", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("charlie", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("alice", { rank: "manager", department: "design", reportsTo: "coo" }),
        emp("bob", { rank: "manager", department: "design", reportsTo: "coo" }),
      ),
    );
    const reports = h.nodes["coo"].directReports;
    // design comes before eng, alice before bob within design
    expect(reports).toEqual(["alice", "bob", "charlie"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/jimmy && pnpm --filter jimmy test -- --run src/gateway/__tests__/org-hierarchy.test.ts`
Expected: FAIL — module `../org-hierarchy.js` does not exist

- [ ] **Step 3: Commit failing tests**

```bash
git add packages/jimmy/src/gateway/__tests__/org-hierarchy.test.ts
git commit -m "test(org): add failing tests for org hierarchy resolver"
```

---

### Task 4: Implement `org-hierarchy.ts`

**Files:**
- Create: `packages/jimmy/src/gateway/org-hierarchy.ts`

- [ ] **Step 1: Create the module with all exports**

```typescript
import type { Employee, OrgNode, OrgWarning, OrgHierarchy } from "../shared/types.js";

const RANK_PRIORITY: Record<string, number> = {
  executive: 0,
  manager: 1,
  senior: 2,
  employee: 3,
};

/**
 * Extract the primary reportsTo value.
 * string → string, string[] → first element, undefined → undefined.
 */
export function getPrimaryParent(
  reportsTo: string | string[] | undefined,
): string | undefined {
  if (reportsTo === undefined) return undefined;
  if (typeof reportsTo === "string") return reportsTo;
  return reportsTo.length > 0 ? reportsTo[0] : undefined;
}

/**
 * Get all reporting relationships (primary + dotted-line).
 */
export function getAllParents(
  reportsTo: string | string[] | undefined,
): string[] {
  if (reportsTo === undefined) return [];
  if (typeof reportsTo === "string") return [reportsTo];
  return [...reportsTo];
}

/**
 * Resolve a flat employee registry into a hierarchical org tree.
 * Pure function — no side effects, no I/O.
 */
export function resolveOrgHierarchy(
  registry: Map<string, Employee>,
): OrgHierarchy {
  const warnings: OrgWarning[] = [];
  const parentMap = new Map<string, string | null>(); // employee name → resolved parent name

  if (registry.size === 0) {
    return { root: null, nodes: {}, sorted: [], warnings: [] };
  }

  // ── Step 1: Find root ──────────────────────────────────────────
  const executives = [...registry.values()]
    .filter((e) => e.rank === "executive")
    .sort((a, b) => a.name.localeCompare(b.name));

  let rootName: string | null = null;
  if (executives.length > 0) {
    rootName = executives[0].name;
    for (let i = 1; i < executives.length; i++) {
      warnings.push({
        employee: executives[i].name,
        type: "multiple_executives",
        message: `Multiple executives found. "${executives[i].name}" is not the primary root; "${rootName}" was chosen.`,
      });
    }
  }

  // ── Step 2: Resolve explicit reportsTo ─────────────────────────
  for (const [name, emp] of registry) {
    const primary = getPrimaryParent(emp.reportsTo);

    if (primary === undefined) {
      // No explicit reportsTo — will be resolved in Step 3
      continue;
    }

    if (primary === name) {
      warnings.push({
        employee: name,
        type: "self_ref",
        message: `"${name}" lists itself as reportsTo.`,
        ref: primary,
      });
      // Will be resolved in Step 3
      continue;
    }

    if (!registry.has(primary)) {
      warnings.push({
        employee: name,
        type: "broken_ref",
        message: `"${name}" reports to "${primary}" which does not exist.`,
        ref: primary,
      });
      // Will be resolved in Step 3
      continue;
    }

    parentMap.set(name, primary);
  }

  // ── Step 3: Smart defaults for unresolved ──────────────────────
  for (const [name, emp] of registry) {
    if (parentMap.has(name)) continue;

    // Root is always at the top
    if (name === rootName) {
      parentMap.set(name, null);
      continue;
    }

    // Find highest-ranked employee in same department with strictly higher rank
    const deptMembers = [...registry.values()].filter(
      (m) => m.department === emp.department && m.name !== name,
    );

    const empRank = RANK_PRIORITY[emp.rank] ?? 3;
    const candidates = deptMembers
      .filter((m) => (RANK_PRIORITY[m.rank] ?? 3) < empRank) // strictly higher rank
      .sort((a, b) => {
        const rankDiff = (RANK_PRIORITY[a.rank] ?? 3) - (RANK_PRIORITY[b.rank] ?? 3);
        if (rankDiff !== 0) return rankDiff; // highest rank first
        return a.name.localeCompare(b.name); // alphabetical tiebreak
      });

    if (candidates.length > 0) {
      parentMap.set(name, candidates[0].name);
    } else {
      parentMap.set(name, null); // reports to root
    }
  }

  // ── Step 4: Cycle detection ────────────────────────────────────
  for (const [name] of registry) {
    const visited = new Set<string>();
    let current: string | null = name;

    while (current !== null) {
      if (visited.has(current)) {
        // Cycle detected — break the cycle by detaching this node
        warnings.push({
          employee: name,
          type: "cycle",
          message: `Cycle detected involving "${name}". Detached from parent "${parentMap.get(name)}".`,
          ref: parentMap.get(name) ?? undefined,
        });
        parentMap.set(name, null); // detach to root
        break;
      }
      visited.add(current);
      current = parentMap.get(current) ?? null;
    }
  }

  // ── Step 5: Cross-department check ─────────────────────────────
  for (const [name, emp] of registry) {
    const parent = parentMap.get(name);
    if (parent === null || parent === undefined) continue;

    const parentEmp = registry.get(parent);
    if (parentEmp && parentEmp.department !== emp.department) {
      // Only warn for explicit reportsTo, not smart defaults
      const primary = getPrimaryParent(emp.reportsTo);
      if (primary === parent) {
        warnings.push({
          employee: name,
          type: "cross_department",
          message: `"${name}" (${emp.department}) reports to "${parent}" (${parentEmp.department}) across departments.`,
        });
      }
    }
  }

  // ── Step 6: Compute directReports, depth, chain, sorted ───────
  const nodes: Record<string, OrgNode> = {};
  const childrenMap = new Map<string, string[]>();

  // Initialize nodes
  for (const [name, emp] of registry) {
    nodes[name] = {
      employee: emp,
      parentName: parentMap.get(name) ?? null,
      directReports: [],
      depth: 0,
      chain: [],
    };
  }

  // Build children map
  for (const [name] of registry) {
    const parent = parentMap.get(name);
    if (parent !== null && parent !== undefined && registry.has(parent)) {
      if (!childrenMap.has(parent)) childrenMap.set(parent, []);
      childrenMap.get(parent)!.push(name);
    }
  }

  // Sort children by department then name
  for (const [, children] of childrenMap) {
    children.sort((a, b) => {
      const empA = registry.get(a)!;
      const empB = registry.get(b)!;
      const deptCmp = empA.department.localeCompare(empB.department);
      if (deptCmp !== 0) return deptCmp;
      return a.localeCompare(b);
    });
  }

  // Set directReports
  for (const [parent, children] of childrenMap) {
    if (nodes[parent]) {
      nodes[parent].directReports = children;
    }
  }

  // BFS to compute depth, chain, and sorted order
  const sorted: string[] = [];

  // Find root-level nodes (parentName is null or parent not in registry)
  const rootNodes = Object.keys(nodes)
    .filter((name) => {
      const parent = nodes[name].parentName;
      return parent === null || !registry.has(parent);
    })
    .sort((a, b) => {
      const empA = registry.get(a)!;
      const empB = registry.get(b)!;
      const deptCmp = empA.department.localeCompare(empB.department);
      if (deptCmp !== 0) return deptCmp;
      return a.localeCompare(b);
    });

  const queue: string[] = [...rootNodes];

  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(name);

    const node = nodes[name];
    const parent = node.parentName;

    if (parent !== null && nodes[parent]) {
      node.depth = nodes[parent].depth + 1;
      node.chain = [...nodes[parent].chain, name];
    } else {
      node.depth = 0;
      node.chain = [name];
    }

    for (const child of node.directReports) {
      queue.push(child);
    }
  }

  return { root: rootName, nodes, sorted, warnings };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd ~/Projects/jimmy && pnpm --filter jimmy test -- --run src/gateway/__tests__/org-hierarchy.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run full typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/jimmy/src/gateway/org-hierarchy.ts
git commit -m "feat(org): implement hierarchy resolver with smart defaults, cycle detection, and warnings"
```

---

## Phase 2: API + Context Builder + Dashboard (Atomic Release)

### Task 5: Update `GET /api/org` to return enriched response

**Files:**
- Modify: `packages/jimmy/src/gateway/api.ts:891-924` (GET /api/org handler)

- [ ] **Step 1: Replace filename-scanning with scanOrg + resolver**

Replace lines 891-924 with:

```typescript
if (method === "GET" && pathname === "/api/org") {
  if (!fs.existsSync(ORG_DIR)) return json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
  const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
  const departments = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { scanOrg } = await import("./org.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const registry = scanOrg();
  const hierarchy = resolveOrgHierarchy(registry);

  // Build enriched employee array from hierarchy sorted order
  const employees = hierarchy.sorted.map((name) => {
    const node = hierarchy.nodes[name];
    const emp = node.employee;
    // Omit persona from list response to keep it lightweight
    const { persona, ...rest } = emp;
    return {
      ...rest,
      parentName: node.parentName,
      directReports: node.directReports,
      depth: node.depth,
      chain: node.chain,
    };
  });

  return json(res, {
    departments,
    employees,
    hierarchy: {
      root: hierarchy.root,
      sorted: hierarchy.sorted,
      warnings: hierarchy.warnings,
    },
  });
}
```

- [ ] **Step 2: Add import for `resolveOrgHierarchy` at top of file if needed**

The handler uses dynamic imports already (`await import("./org.js")`), so the `resolveOrgHierarchy` import is inline. No top-level import needed.

- [ ] **Step 3: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/jimmy/src/gateway/api.ts
git commit -m "feat(api): enrich GET /api/org with hierarchy data and inline employee objects"
```

---

### Task 6: Update `GET /api/org/employees/:name` with hierarchy fields

**Files:**
- Modify: `packages/jimmy/src/gateway/api.ts:927-948` (GET /api/org/employees/:name handler)

- [ ] **Step 1: Replace raw YAML return with enriched response**

Replace lines 929-947 with:

```typescript
if (method === "GET" && params) {
  const { scanOrg } = await import("./org.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const registry = scanOrg();
  const emp = registry.get(params.name);
  if (!emp) return notFound(res);

  const hierarchy = resolveOrgHierarchy(registry);
  const node = hierarchy.nodes[params.name];

  return json(res, {
    ...emp,
    parentName: node?.parentName ?? null,
    directReports: node?.directReports ?? [],
    depth: node?.depth ?? 0,
    chain: node?.chain ?? [params.name],
  });
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/jimmy/src/gateway/api.ts
git commit -m "feat(api): add hierarchy fields to GET /api/org/employees/:name"
```

---

### Task 7: Update context builder — `buildOrgContext` with hierarchy

**Files:**
- Modify: `packages/jimmy/src/sessions/context.ts:44-57` (buildContext signature + org section)
- Modify: `packages/jimmy/src/sessions/context.ts:319-360` (buildOrgContext function)
- Modify: `packages/jimmy/src/sessions/context.ts:206-238` (buildEmployeeIdentity function)

- [ ] **Step 1: Add `hierarchy` to buildContext opts**

In `buildContext` function signature (line 44-57), add after `channelName?: string;`:

```typescript
hierarchy?: import("../shared/types.js").OrgHierarchy;
```

- [ ] **Step 2: Pass hierarchy to buildOrgContext call**

Change line 117 from:

```typescript
const orgCtx = buildOrgContext();
```

to:

```typescript
const orgCtx = buildOrgContext(opts.hierarchy);
```

- [ ] **Step 3: Update buildOrgContext to accept and use hierarchy**

Replace the `buildOrgContext()` function (lines 319-360) with:

```typescript
function buildOrgContext(hierarchy?: import("../shared/types.js").OrgHierarchy): string | null {
  try {
    // If hierarchy is provided, render as indented tree
    if (hierarchy && Object.keys(hierarchy.nodes).length > 0) {
      const MAX_DEPTH = 3; // Depth limit to prevent context bloat
      const count = Object.keys(hierarchy.nodes).length;
      const lines: string[] = [`## Organization (${count} employee(s))`];

      // Count descendants below the depth cutoff
      let deepCount = 0;
      for (const name of hierarchy.sorted) {
        const node = hierarchy.nodes[name];
        if (node.depth >= MAX_DEPTH) {
          deepCount++;
          continue; // Skip rendering nodes at/beyond depth limit
        }
        const emp = node.employee;
        const indent = "  ".repeat(node.depth);
        let entry = `${indent}- **${emp.displayName}** (${name}) — ${emp.department}, ${emp.rank}`;
        if (emp.persona) {
          const firstLine = emp.persona.trim().split("\n")[0].trim().slice(0, 120);
          entry += `\n${indent}  _${firstLine}_`;
        }
        lines.push(entry);
      }
      if (deepCount > 0) {
        lines.push(`${"  ".repeat(MAX_DEPTH)}- ... and ${deepCount} more at deeper levels`);
      }

      lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
      return lines.join("\n");
    }

    // Fallback: filesystem-based flat rendering (backwards compat)
    const employeeFiles: { fullPath: string; name: string }[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
          entry.name !== "department.yaml"
        ) {
          employeeFiles.push({ fullPath, name: entry.name.replace(/\.ya?ml$/, "") });
        }
      }
    }

    scanDir(ORG_DIR);
    if (employeeFiles.length === 0) return null;

    const lines: string[] = [`## Organization (${employeeFiles.length} employee(s))`];
    for (const { fullPath, name } of employeeFiles) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const displayMatch = content.match(/displayName:\s*(.+)/);
      const deptMatch = content.match(/department:\s*(.+)/);
      const rankMatch = content.match(/rank:\s*(.+)/);
      const personaMatch = content.match(/persona:\s*[|>]?\s*\n?\s*(.+)/);
      let entry = `- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`;
      if (personaMatch?.[1]) {
        entry += `\n  _${personaMatch[1].trim().slice(0, 120)}_`;
      }
      lines.push(entry);
    }
    lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
    return lines.join("\n");
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update buildEmployeeIdentity to show reporting info**

Change the `buildEmployeeIdentity` function signature (line 206) to accept an optional `OrgNode`:

```typescript
function buildEmployeeIdentity(
  employee: Employee,
  portalName: string,
  language: string,
  node?: import("../shared/types.js").OrgNode,
): string {
```

In the template string output (lines 218-224), replace the role section:

```typescript
## Your role
- **Name**: ${employee.name}
- **Display name**: ${employee.displayName}
- **Department**: ${employee.department}
- **Rank**: ${employee.rank}
${node ? `- **Reports to**: ${node.parentName ? registry_lookup_display : "COO"}` : ""}
${node ? `- **Direct reports**: ${node.directReports.length > 0 ? node.directReports.join(", ") : "(none)"}` : ""}
- **Engine**: ${employee.engine}
- **Model**: ${employee.model}
```

Actually, to keep it cleaner, build the reports-to and direct-reports lines conditionally. Note: use parent's **displayName**, not internal name, per the spec:

```typescript
const reportsToLine = node
  ? `\n- **Reports to**: ${node.parentName ? (hierarchy?.nodes[node.parentName]?.employee.displayName ?? node.parentName) : "COO"}`
  : "";
const directReportsLine = node
  ? `\n- **Direct reports**: ${node.directReports.length > 0 ? node.directReports.join(", ") : "(none)"}`
  : "";
```

This means `buildEmployeeIdentity` also needs the hierarchy passed in (for parent displayName lookup). Update the signature to:

```typescript
function buildEmployeeIdentity(
  employee: Employee,
  portalName: string,
  language: string,
  node?: import("../shared/types.js").OrgNode,
  hierarchy?: import("../shared/types.js").OrgHierarchy,
): string {
```

And insert the lines in the template between Rank and Engine lines.

- [ ] **Step 5: Update the buildEmployeeIdentity call site in buildContext**

In `buildContext()` (around line 76), the call is:

```typescript
content: buildEmployeeIdentity(opts.employee, portalName, language),
```

Change to:

```typescript
content: buildEmployeeIdentity(
  opts.employee,
  portalName,
  language,
  opts.hierarchy?.nodes[opts.employee.name],
  opts.hierarchy,
),
```

- [ ] **Step 6: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/jimmy/src/sessions/context.ts
git commit -m "feat(context): render org as indented tree, add reporting info to employee identity"
```

---

### Task 8: Pass hierarchy through session manager and API streaming

**Files:**
- Modify: `packages/jimmy/src/sessions/manager.ts:242-252` (buildContext call)
- Modify: `packages/jimmy/src/gateway/api.ts:1900-1919` (web streaming buildContext call)

- [ ] **Step 1: Update manager.ts to resolve hierarchy and pass it**

Before the `buildContext` call in manager.ts (around line 242), add hierarchy resolution:

```typescript
// Resolve org hierarchy for context
let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
try {
  const { scanOrg } = await import("../gateway/org.js");
  const { resolveOrgHierarchy } = await import("../gateway/org-hierarchy.js");
  hierarchy = resolveOrgHierarchy(scanOrg());
} catch {
  // Non-critical — context builder falls back to filesystem scan
}
```

Wait — `manager.ts` already has the `employee` resolved from `scanOrg()` in the message handler, but it imports scanOrg separately. Check the manager's flow more carefully. The manager has `this.registry` cached? Let me re-check.

Actually, looking at the code flow: the manager imports buildContext from context.ts. The registry is re-scanned each time through context.ts's `buildOrgContext()`. For the manager, we just need to pass `hierarchy` through.

Add before the `buildContext` call in manager.ts (line 242):

```typescript
let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
try {
  const { scanOrg } = await import("../gateway/org.js");
  const { resolveOrgHierarchy } = await import("../gateway/org-hierarchy.js");
  hierarchy = resolveOrgHierarchy(scanOrg());
} catch { /* fallback to filesystem scan in context builder */ }
```

Then pass it to buildContext:

```typescript
const systemPrompt = buildContext({
  source: session.source,
  channel: msg.channel,
  thread: msg.thread,
  user: msg.user,
  employee,
  connectors: this.connectorNames,
  config: this.config,
  sessionId: session.id,
  channelName: (msg.transportMeta?.channelName as string) || undefined,
  hierarchy,
});
```

- [ ] **Step 2: Update api.ts web streaming to resolve hierarchy**

In api.ts around line 1904, after the `scanOrg()` call, add:

```typescript
const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
const hierarchy = resolveOrgHierarchy(registry);
```

Then pass it to the `buildContext` call at line 1911:

```typescript
const systemPrompt = buildContext({
  source: "web",
  channel: currentSession.sourceRef,
  user: "web-user",
  employee,
  connectors: Array.from(context.connectors.keys()),
  config,
  sessionId: currentSession.id,
  hierarchy,
});
```

Note: `registry` is already available from the `scanOrg()` call at line 1905.

- [ ] **Step 3: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/jimmy/src/sessions/manager.ts packages/jimmy/src/gateway/api.ts
git commit -m "feat(context): pass resolved hierarchy to context builder from manager and API"
```

---

### Task 9: Update web `lib/api.ts` types

**Files:**
- Modify: `packages/web/src/lib/api.ts:22-37` (Employee and OrgData types)

- [ ] **Step 1: Add hierarchy fields to Employee type**

Replace lines 22-37:

```typescript
export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
  alwaysNotify?: boolean;
  reportsTo?: string | string[];
  parentName?: string | null;
  directReports?: string[];
  depth?: number;
  chain?: string[];
}

export interface OrgWarning {
  employee: string;
  type: string;
  message: string;
  ref?: string;
}

export interface OrgHierarchy {
  root: string | null;
  sorted: string[];
  warnings: OrgWarning[];
}

export interface OrgData {
  departments: string[];
  employees: Employee[];
  hierarchy: OrgHierarchy;
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: There will be type errors in consumers that still treat `employees` as `string[]` — these will be fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(web): update Employee and OrgData types with hierarchy fields"
```

---

### Task 10: Fix N+1 pattern in org page

**Files:**
- Modify: `packages/web/src/app/org/page.tsx:37-73` (loadData callback)

- [ ] **Step 1: Replace N+1 fetch pattern with inline data**

Replace the `loadData` callback (lines 37-73) with:

```typescript
const loadData = useCallback(() => {
  setLoading(true);
  setError(null);
  api
    .getOrg()
    .then((data: OrgData) => {
      const coo: Employee = {
        name: (settings.portalName ?? "Jinn").toLowerCase(),
        displayName: settings.portalName ?? "Jinn",
        department: "",
        rank: "executive",
        engine: "claude",
        model: "opus",
        persona: "COO and AI gateway daemon",
      };
      setEmployees([coo, ...data.employees]);
    })
    .catch((err) => setError(err.message))
    .finally(() => setLoading(false));
}, [settings.portalName]);
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/org/page.tsx
git commit -m "fix(web): use inline employee data from /api/org, eliminate N+1 fetches in org page"
```

---

### Task 11: Fix N+1 pattern in cron page

**Files:**
- Modify: `packages/web/src/app/cron/page.tsx:168-178`

- [ ] **Step 1: Replace N+1 pattern**

Replace the `api.getOrg().then(...)` block (lines 168-178) with:

```typescript
api.getOrg().then((org) => {
  const map = new Map<string, Employee>()
  for (const emp of org.employees) {
    map.set(emp.name, emp)
  }
  setEmployeeMap(map)
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/cron/page.tsx
git commit -m "fix(web): use inline employee data in cron page, eliminate N+1 fetches"
```

---

### Task 12: Fix N+1 pattern in kanban page

**Files:**
- Modify: `packages/web/src/app/kanban/page.tsx:138-155`

- [ ] **Step 1: Replace N+1 pattern**

Replace the `api.getOrg().then(...)` block with the same inline pattern:

```typescript
api.getOrg().then((data: OrgData) => {
  setEmployees(data.employees)
})
```

Check the exact usage of `employees` in this file to match the expected shape. It may use the same `Promise.all(data.employees.map(...))` pattern — just use `data.employees` directly.

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/kanban/page.tsx
git commit -m "fix(web): use inline employee data in kanban page, eliminate N+1 fetches"
```

---

### Task 13: Fix N+1 pattern in chat-sidebar

**Files:**
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx:329-339`

- [ ] **Step 1: Replace N+1 pattern**

Replace the `api.getOrg().then(...)` block:

```typescript
api.getOrg().then((org) => {
  const map = new Map<string, Employee>()
  for (const emp of org.employees) {
    map.set(emp.name, emp)
  }
  setEmployeeData(map)
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/chat/chat-sidebar.tsx
git commit -m "fix(web): use inline employee data in chat sidebar, eliminate N+1 fetches"
```

---

### Task 14: Fix N+1 pattern in chat-pane

**Files:**
- Modify: `packages/web/src/components/chat/chat-pane.tsx:89-99`

- [ ] **Step 1: Replace N+1 pattern**

Replace the `api.getOrg().then(...)` block. The data shape used by this component is `{ name, displayName, department, rank }`, which is already in `data.employees`:

```typescript
api.getOrg().then((data) => {
  if (!Array.isArray(data.employees)) return
  setPickerEmployees(data.employees.map((emp) => ({
    name: emp.name,
    displayName: emp.displayName,
    department: emp.department,
    rank: emp.rank,
  })))
  employeesFetchedRef.current = true
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/chat/chat-pane.tsx
git commit -m "fix(web): use inline employee data in chat pane, eliminate N+1 fetches"
```

---

### Task 15: Fix N+1 pattern in chat-input

**Files:**
- Modify: `packages/web/src/components/chat/chat-input.tsx:172-184`

- [ ] **Step 1: Replace N+1 pattern**

```typescript
api.getOrg().then((data) => {
  if (!Array.isArray(data.employees)) return
  setEmployees(data.employees.map((emp) => ({
    name: emp.name,
    displayName: emp.displayName,
    department: emp.department,
    rank: emp.rank,
    engine: emp.engine,
  })))
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/chat/chat-input.tsx
git commit -m "fix(web): use inline employee data in chat input, eliminate N+1 fetches"
```

---

### Task 16: Fix global-search employee name extraction

**Files:**
- Modify: `packages/web/src/components/global-search.tsx:98-99`

- [ ] **Step 1: Update employee name extraction**

Change:

```typescript
const employeeNames: string[] = Array.isArray(orgData?.employees) ? orgData.employees : []
```

to:

```typescript
const employeeNames: string[] = Array.isArray(orgData?.employees)
  ? orgData.employees.map((e: Employee) => typeof e === 'string' ? e : e.name)
  : []
```

Actually, since OrgData is now typed with `Employee[]`, just use:

```typescript
const employeeNames: string[] = Array.isArray(orgData?.employees)
  ? orgData.employees.map((e) => e.name)
  : []
```

Also update the import to include `Employee` if not already imported from `@/lib/api`.

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/global-search.tsx
git commit -m "fix(web): update global search to extract employee names from object array"
```

---

### Task 16b: Update `use-employees.ts` hook return type

**Files:**
- Modify: `packages/web/src/hooks/use-employees.ts`

- [ ] **Step 1: Verify `useOrg()` return type**

`useOrg()` calls `api.getOrg()` which returns `OrgData`. Since we updated `OrgData` in `lib/api.ts` (Task 9) from `{ employees: string[] }` to `{ employees: Employee[] }`, the `useOrg()` hook's return type automatically picks up the new shape via TypeScript inference. No code change needed in the hook itself.

However, verify that all consumers of `useOrg()` handle the new shape. The main consumer is `global-search.tsx` (fixed in Task 16). Run a grep to find any other consumers:

Run: `cd ~/Projects/jimmy && grep -r "useOrg\(\)" packages/web/src/ --include="*.tsx" --include="*.ts"`

Fix any other consumers that treat `employees` as `string[]`.

- [ ] **Step 2: Commit (only if changes were needed)**

```bash
git add packages/web/src/hooks/use-employees.ts
git commit -m "fix(web): verify useOrg hook consumers handle new OrgData shape"
```

---

### Task 17: Update org-tree with hierarchy view

**Files:**
- Modify: `packages/web/src/components/org/org-tree.tsx` (full rewrite)

- [ ] **Step 1: Remove local interfaces, import from api.ts**

Remove lines 4-15 (local `Employee` and `OrgData` interfaces). Add import:

```typescript
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";
```

- [ ] **Step 2: Add HierarchyNode recursive component**

Add a new component above the existing `DepartmentNode`:

```typescript
function HierarchyNode({
  name,
  employees,
  hierarchy,
  depth,
  selectedEmployee,
  onSelectEmployee,
}: {
  name: string;
  employees: Employee[];
  hierarchy: OrgHierarchy;
  depth: number;
  selectedEmployee: string | null;
  onSelectEmployee: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const employee = employees.find((e) => e.name === name);
  const directReports = employee?.directReports ?? [];
  const hasChildren = directReports.length > 0;

  if (!employee) return null;

  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-5 h-5 flex items-center justify-center text-[var(--text-quaternary)] text-xs shrink-0 bg-none border-none cursor-pointer"
          >
            {expanded ? "\u25BC" : "\u25B6"}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          onClick={() => onSelectEmployee(employee.name)}
          className="flex-1 text-left flex items-center gap-2 py-[6px] px-2 rounded-[var(--radius-md)] text-[length:var(--text-subheadline)] border-none cursor-pointer transition-[background,color] duration-150 ease-in-out"
          style={{
            background: selectedEmployee === employee.name ? 'var(--accent-fill)' : 'transparent',
            color: selectedEmployee === employee.name ? 'var(--accent)' : 'var(--text-secondary)',
          }}
          onMouseEnter={(e) => { if (selectedEmployee !== employee.name) e.currentTarget.style.background = 'var(--fill-tertiary)' }}
          onMouseLeave={(e) => { if (selectedEmployee !== employee.name) e.currentTarget.style.background = 'transparent' }}
        >
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {employee.displayName || employee.name}
          </span>
          {hasChildren && (
            <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--fill-tertiary)] py-[2px] px-[6px] rounded-full">
              {directReports.length}
            </span>
          )}
          {employee.rank && <RankBadge rank={employee.rank} />}
          {employee.engine && <EngineIcon engine={employee.engine} />}
        </button>
      </div>
      {expanded && hasChildren && directReports.map((childName) => (
        <HierarchyNode
          key={childName}
          name={childName}
          employees={employees}
          hierarchy={hierarchy}
          depth={depth + 1}
          selectedEmployee={selectedEmployee}
          onSelectEmployee={onSelectEmployee}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Add view toggle to OrgTree**

Update the `OrgTree` component to add a hierarchy/department toggle:

```typescript
export function OrgTree({
  data,
  selectedEmployee,
  selectedDepartment,
  onSelectEmployee,
  onSelectDepartment,
}: {
  data: OrgData;
  selectedEmployee: string | null;
  selectedDepartment: string | null;
  onSelectEmployee: (name: string) => void;
  onSelectDepartment: (name: string) => void;
}) {
  const hasHierarchy = data.employees.some((e) => e.directReports && e.directReports.length > 0);
  const [viewMode, setViewMode] = useState<"hierarchy" | "department">(hasHierarchy ? "hierarchy" : "department");

  // ... keep existing department view logic ...

  if (viewMode === "hierarchy" && data.hierarchy) {
    // Find root-level employees (no parent or parent not in the employee list)
    const rootEmployees = data.employees.filter(
      (e) => e.parentName === null || e.parentName === undefined,
    );

    return (
      <div className="flex flex-col gap-1">
        {hasHierarchy && (
          <div className="flex gap-1 mb-2 px-1">
            <button
              onClick={() => setViewMode("hierarchy")}
              className="text-[10px] py-[2px] px-[8px] rounded-full border-none cursor-pointer"
              style={{
                background: viewMode === "hierarchy" ? "var(--accent-fill)" : "var(--fill-tertiary)",
                color: viewMode === "hierarchy" ? "var(--accent)" : "var(--text-tertiary)",
              }}
            >
              Hierarchy
            </button>
            <button
              onClick={() => setViewMode("department")}
              className="text-[10px] py-[2px] px-[8px] rounded-full border-none cursor-pointer"
              style={{
                background: viewMode === "department" ? "var(--accent-fill)" : "var(--fill-tertiary)",
                color: viewMode === "department" ? "var(--accent)" : "var(--text-tertiary)",
              }}
            >
              Department
            </button>
          </div>
        )}
        {rootEmployees.map((emp) => (
          <HierarchyNode
            key={emp.name}
            name={emp.name}
            employees={data.employees}
            hierarchy={data.hierarchy}
            depth={0}
            selectedEmployee={selectedEmployee}
            onSelectEmployee={onSelectEmployee}
          />
        ))}
      </div>
    );
  }

  // Department view (existing logic)
  // ... keep the rest of the existing code ...
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/org/org-tree.tsx
git commit -m "feat(web): add hierarchy view to org tree with toggle between hierarchy and department"
```

---

### Task 18: Update org-map with full hierarchy layout

**Files:**
- Modify: `packages/web/src/components/org/org-map.tsx`

- [ ] **Step 1: Update OrgMapProps to accept hierarchy**

```typescript
interface OrgMapProps {
  employees: Employee[]
  hierarchy?: OrgHierarchy
  selectedName: string | null
  onNodeClick: (employee: Employee) => void
}
```

Import `OrgHierarchy` from `@/lib/api`.

- [ ] **Step 2: Add `buildHierarchyLayout` function**

Add a new function alongside `buildDepartmentLayout`:

```typescript
function buildHierarchyLayout(
  employees: Employee[],
  hierarchy: OrgHierarchy,
  selectedName: string | null,
): { nodes: Node[]; edges: Edge[] } {
  if (employees.length === 0) return { nodes: [], edges: [] }

  // Compute selected chain for highlighting
  const highlightedNames = new Set<string>();
  if (selectedName) {
    // Walk up chain
    const selectedEmp = employees.find((e) => e.name === selectedName);
    if (selectedEmp?.chain) {
      for (const name of selectedEmp.chain) highlightedNames.add(name);
    }
    // Walk down descendants
    function addDescendants(name: string) {
      highlightedNames.add(name);
      const emp = employees.find((e) => e.name === name);
      if (emp?.directReports) {
        for (const child of emp.directReports) addDescendants(child);
      }
    }
    addDescendants(selectedName);
  }

  // Use dagre for full hierarchy layout
  const nodeIds = hierarchy.sorted;
  const edgePairs: [string, string][] = [];

  for (const name of nodeIds) {
    const emp = employees.find((e) => e.name === name);
    if (emp?.parentName && nodeIds.includes(emp.parentName)) {
      edgePairs.push([emp.parentName, name]);
    }
  }

  const positions = dagreLayout(nodeIds, edgePairs, { nodesep: 60, ranksep: 120 });

  // Build department bounding boxes
  const deptBounds = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const name of nodeIds) {
    const emp = employees.find((e) => e.name === name);
    const pos = positions.get(name);
    if (!emp || !pos) continue;
    const dept = emp.department;
    if (!dept) continue;

    const bounds = deptBounds.get(dept) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    bounds.minX = Math.min(bounds.minX, pos.x);
    bounds.maxX = Math.max(bounds.maxX, pos.x + NODE_W);
    bounds.minY = Math.min(bounds.minY, pos.y);
    bounds.maxY = Math.max(bounds.maxY, pos.y + NODE_H);
    deptBounds.set(dept, bounds);
  }

  const rfNodes: Node[] = [];

  // Department group overlays
  let gi = 0;
  for (const [dept, bounds] of deptBounds) {
    rfNodes.push({
      id: `group-${gi}`,
      type: "departmentGroup",
      data: { label: dept },
      position: {
        x: bounds.minX - GROUP_PAD_X,
        y: bounds.minY - GROUP_PAD_TOP,
      },
      style: {
        width: bounds.maxX - bounds.minX + GROUP_PAD_X * 2,
        height: bounds.maxY - bounds.minY + GROUP_PAD_TOP + GROUP_PAD_BOTTOM,
        background: "var(--fill-quaternary)",
        borderRadius: 12,
        border: "1px solid var(--separator)",
        padding: 0,
      },
      selectable: false,
      draggable: false,
    });
    gi++;
  }

  // Employee nodes
  for (const name of nodeIds) {
    const pos = positions.get(name);
    const emp = employees.find((e) => e.name === name);
    if (!pos || !emp) continue;
    rfNodes.push({
      id: name,
      type: "employeeNode",
      data: emp as unknown as Record<string, unknown>,
      position: { x: pos.x, y: pos.y },
      selected: name === selectedName,
    });
  }

  // Edges
  const rfEdges: Edge[] = [];
  for (const [source, target] of edgePairs) {
    const isHighlighted = highlightedNames.has(source) && highlightedNames.has(target);
    rfEdges.push({
      id: `${source}-${target}`,
      source,
      target,
      type: "smoothstep",
      style: {
        stroke: isHighlighted ? "var(--accent)" : "var(--text-quaternary)",
        strokeWidth: isHighlighted ? 2.5 : 1.5,
        opacity: isHighlighted ? 1 : 0.7,
      },
      animated: isHighlighted,
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}
```

- [ ] **Step 3: Update OrgMap component to use hierarchy layout**

```typescript
export function OrgMap({ employees, hierarchy, selectedName, onNodeClick }: OrgMapProps) {
  const buildLayout = hierarchy
    ? () => buildHierarchyLayout(employees, hierarchy, selectedName)
    : () => buildDepartmentLayout(employees, selectedName);

  const { nodes: initialNodes, edges: initialEdges } = buildLayout();
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout();
    setNodes(n);
    setEdges(e);
  }, [employees, hierarchy, selectedName, setNodes, setEdges]);

  // ... rest stays the same ...
}
```

- [ ] **Step 4: Update org page to pass hierarchy to OrgMap**

In `app/org/page.tsx`, store hierarchy data and pass it:

Add state: `const [hierarchy, setHierarchy] = useState<OrgHierarchy | undefined>();`

In `loadData`, save it: `setHierarchy(data.hierarchy);`

Pass to OrgMap: `<OrgMap employees={employees} hierarchy={hierarchy} selectedName={selected?.name ?? null} onNodeClick={handleSelectEmployee} />`

- [ ] **Step 5: Wire OrgTree into org page as a "Tree" tab**

In `app/org/page.tsx`, the `OrgTree` component is currently dead code (not imported). Add it as a fourth tab option alongside Map/Grid/List.

Add import (dynamic, same pattern as OrgMap):

```typescript
import { OrgTree } from "@/components/org/org-tree";
```

Add a "Tree" tab trigger after "List":

```typescript
<TabsTrigger value="tree">Tree</TabsTrigger>
```

Add the TabsContent for "Tree" after the "list" TabsContent:

```typescript
<TabsContent value="tree" className="flex-1 overflow-auto p-[var(--space-4)]">
  {loading ? (
    <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
      Loading...
    </div>
  ) : (
    <OrgTree
      data={{
        departments: [],
        employees,
        hierarchy: hierarchy ?? { root: null, sorted: [], warnings: [] },
      }}
      selectedEmployee={selected?.name ?? null}
      selectedDepartment={null}
      onSelectEmployee={(name) => {
        const emp = employees.find((e) => e.name === name);
        if (emp) handleSelectEmployee(emp);
      }}
      onSelectDepartment={() => {}}
    />
  )}
</TabsContent>
```

Also import `OrgHierarchy` from `@/lib/api`.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/org/org-map.tsx packages/web/src/app/org/page.tsx
git commit -m "feat(web): full hierarchy dagre layout in org map, wire OrgTree as new tab"
```

---

### Task 19: Add reports badge to employee-node

**Files:**
- Modify: `packages/web/src/components/org/employee-node.tsx`

- [ ] **Step 1: Add reports count badge**

After the engine badge section (line 39), add:

```typescript
{/* Direct reports badge */}
{employee.directReports && employee.directReports.length > 0 && (
  <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-tertiary)] py-px px-[6px] rounded-full ml-auto">
    {employee.directReports.length} report{employee.directReports.length !== 1 ? "s" : ""}
  </span>
)}
```

Update the `EmployeeNodeData` type to include new fields:

```typescript
type EmployeeNodeData = Employee & Record<string, unknown>
```

This already works because `Employee` now includes `directReports`.

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/org/employee-node.tsx
git commit -m "feat(web): add direct reports count badge to employee node"
```

---

### Task 20: Build and verify Phase 2

- [ ] **Step 1: Run full typecheck**

Run: `cd ~/Projects/jimmy && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full build**

Run: `cd ~/Projects/jimmy && pnpm build`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `cd ~/Projects/jimmy && pnpm test`
Expected: ALL PASS (including org-hierarchy tests from Phase 1)

- [ ] **Step 4: Commit build verification**

No commit needed — build verification is a check, not a code change.

---

## Phase 3: Management Skill + Migration Docs

### Task 21: Update management skill with hierarchy operations

**Files:**
- Modify: `~/.jinn/skills/management/SKILL.md`

- [ ] **Step 1: Add reportsTo logic to hiring section**

After the "Required fields" list (around line 49), add:

```markdown
- `reportsTo` — (optional) who this employee reports to (employee name). If not specified by the user:
  1. Find the highest-ranked employee in the target department (manager > senior > employee)
  2. If a manager exists → set `reportsTo: <manager-name>`
  3. If only seniors exist → set `reportsTo: <first-senior-alphabetically>`
  4. If the department is empty → omit `reportsTo` (smart defaults attach to root)
  5. Confirm to the user: "Assigned X to report to Y. Change this?"
```

- [ ] **Step 2: Add firing cascade section**

Add a new subsection under Operations:

```markdown
### Firing — Cascade Reassignment

When firing an employee who has direct reports:

1. Check `GET /api/org` to see the employee's `directReports`
2. Warn: "X has N direct reports. They will be reassigned to X's manager (Y)."
3. On confirmation, update each report's YAML: set `reportsTo` to the fired employee's own `parentName`
4. If the fired employee reported to root (parentName null), remove the `reportsTo` field from each orphaned report
```

- [ ] **Step 3: Add promotion reassignment section**

```markdown
### Promoting — Report Reassignment

When promoting an employee to manager:

1. Check if other department members have no explicit `reportsTo` or report to someone else
2. Offer: "Promoting X to manager. Should department members report to X?"
3. On confirmation, update each employee's YAML with `reportsTo: <new-manager>`
```

- [ ] **Step 4: Add restructuring section**

```markdown
### Restructuring — Department Moves

When moving an employee to a different department:

1. Update the employee's `department` field
2. Offer: "Should X report to <new-dept-manager>?"
3. If the moved employee had direct reports, offer to reassign them
```

- [ ] **Step 5: Commit**

```bash
git add ~/.jinn/skills/management/SKILL.md
git commit -m "feat(skill): add hierarchy-aware hiring, firing, promotion to management skill"
```

---

### Task 22: Write MIGRATION.md

**Files:**
- Create: `~/.jinn/migrations/hierarchical-org/MIGRATION.md` (per spec convention)

- [ ] **Step 1: Create migration document**

Use the content from the spec's Section 8 (already written in the spec). Copy it verbatim but update the version placeholder.

- [ ] **Step 2: Commit**

```bash
git add ~/.jinn/migrations/hierarchical-org/MIGRATION.md
git commit -m "docs: add migration guide for hierarchical org system"
```

---

### Task 23: Optionally add `reportsTo` to existing employee YAMLs

**Files:**
- Modify: `~/.jinn/org/**/*.yaml` (existing employee files)

- [ ] **Step 1: Add reportsTo to employees with clear reporting lines**

For each department with a manager, add `reportsTo: <manager-name>` to the non-manager employees. This is optional — the smart defaults will infer the same relationships — but explicit is better.

Example departments to update:
- pravko: pravko-lead is manager → all others get `reportsTo: pravko-lead`
- homy: homy-lead is manager → all others get `reportsTo: homy-lead`
- sqlnoir: sqlnoir-lead is manager → sqlnoir-writer gets `reportsTo: sqlnoir-lead`
- spycam: spycam-lead is manager → spycam-writer gets `reportsTo: spycam-lead`

Do NOT add reportsTo to:
- Department leads/managers (they report to root via smart defaults)
- Single-person departments (no reporting chain to define)

- [ ] **Step 2: Verify via API**

Run: `curl -s http://0.0.0.0:7777/api/org | jq '.hierarchy.warnings'`
Expected: Empty array or only informational warnings

- [ ] **Step 3: Commit**

```bash
git add ~/.jinn/org/
git commit -m "chore(org): add explicit reportsTo fields to existing employee YAMLs"
```

---

### Task 24: Final verification

- [ ] **Step 1: Run full build**

Run: `cd ~/Projects/jimmy && pnpm build`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `cd ~/Projects/jimmy && pnpm test`
Expected: ALL PASS

- [ ] **Step 3: Verify API response**

Run: `curl -s http://0.0.0.0:7777/api/org | jq '{root: .hierarchy.root, employeeCount: (.employees | length), warnings: .hierarchy.warnings}'`
Expected: Shows root, employee count matches org, no critical warnings

- [ ] **Step 4: Test employee detail endpoint**

Run: `curl -s http://0.0.0.0:7777/api/org/employees/pravko-lead | jq '{name, parentName, directReports, depth, chain}'`
Expected: Shows hierarchy data for pravko-lead
