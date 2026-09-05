import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLegacyWorkflowDefinitions } from "../import-v1.js";
import { openWorkflowDatabase } from "../repository-migrations.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "jinn-workflow-v1-import-"));
  roots.push(root);
  const legacyDirectory = path.join(root, "workflow-evidence", "workflows");
  const legacyRunsDirectory = path.join(root, "workflow-evidence", "reports", "runs");
  const reportPath = path.join(root, "workflows", "legacy-v1-import-report.json");
  mkdirSync(legacyDirectory, { recursive: true });
  mkdirSync(legacyRunsDirectory, { recursive: true });
  const db = openWorkflowDatabase(path.join(root, "workflows.db"));
  return { root, legacyDirectory, legacyRunsDirectory, reportPath, db };
}

function writeLegacy(directory: string, value: unknown): void {
  const id = (value as { id: string }).id;
  writeFileSync(path.join(directory, `${id}.definition.json`), `${JSON.stringify(value)}\n`);
}

const morningDigest = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  version: 1,
  status: "active",
  updatedAt: "2026-07-11T08:12:13.559Z",
  nodes: [{
    id: "trigger",
    type: "trigger",
    label: "Trigger",
    position: { x: 80, y: 120 },
    trigger: { kind: "manual" },
  }],
  edges: [],
};

const planImplementVerify = {
  schemaVersion: 1,
  id: "plan-implement-verify",
  title: "Plan → Implement → Verify",
  version: 1,
  status: "active",
  updatedAt: "2026-07-12T08:48:50.041Z",
  nodes: [
    { id: "trigger", type: "trigger", label: "Manual trigger", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
    { id: "plan", type: "step", label: "PLAN", position: { x: 320, y: -100 },
      actor: { kind: "engine", ref: "codex" }, instructions: "Plan the requested change.",
      options: { model: "gpt-5.6-sol", effort: "xhigh", retry: { maxAttempts: 2 }, timeoutMinutes: 120 } },
    { id: "implement", type: "step", label: "IMPLEMENT", position: { x: 760, y: -100 },
      actor: { kind: "engine", ref: "codex" }, instructions: "Implement the approved plan." },
    { id: "verify", type: "step", label: "VERIFY", position: { x: 1200, y: -100 },
      actor: { kind: "engine", ref: "codex" }, instructions: "Verify the implementation." },
  ],
  edges: [
    { id: "trigger-to-plan", from: "trigger", to: "plan", kind: "sequence" },
    { id: "plan-to-implement", from: "plan", to: "implement", kind: "handoff" },
    { id: "implement-to-verify", from: "implement", to: "verify", kind: "handoff" },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy Workflow definition import", () => {
  it("imports behavior-equivalent v1 shapes once as disabled v2 drafts and writes an auditable report", () => {
    const { legacyDirectory, legacyRunsDirectory, reportPath, db } = fixture();
    writeLegacy(legacyDirectory, morningDigest);
    writeLegacy(legacyDirectory, planImplementVerify);
    const runDirectory = path.join(legacyRunsDirectory, planImplementVerify.id);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(path.join(runDirectory, "run-active.json"), JSON.stringify({
      runId: "run-active",
      workflowId: planImplementVerify.id,
      status: "running",
    }));
    const logs: string[] = [];

    expect(importLegacyWorkflowDefinitions(db, {
      legacyDirectory,
      legacyRunsDirectory,
      reportPath,
      now: () => "2026-07-24T08:00:00.000Z",
      log: (_level, message) => logs.push(message),
    })).toEqual({ imported: 2, failed: 0, skipped: false });

    const rows = db.prepare("SELECT id, enabled, definition_json FROM workflow_definitions ORDER BY id")
      .all() as Array<{ id: string; enabled: number; definition_json: string }>;
    expect(rows.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: "morning-digest", enabled: 0 },
      { id: "plan-implement-verify", enabled: 0 },
    ]);
    const morning = JSON.parse(rows[0]!.definition_json);
    const pipeline = JSON.parse(rows[1]!.definition_json);
    expect(morning.nodes).toEqual([
      { id: "trigger", type: "trigger", name: "Trigger", config: { kind: "manual" } },
    ]);
    expect(pipeline.nodes.map((node: { type: string }) => node.type)).toEqual([
      "trigger", "employee", "employee", "employee",
    ]);
    expect(pipeline.edges).toHaveLength(3);
    expect(pipeline.ui.positions.verify).toEqual({ x: 1200, y: -100 });
    expect(logs.filter((line) => line.includes("imported legacy Workflow"))).toHaveLength(2);
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining("active legacy Workflow run"),
      expect.stringContaining(reportPath),
    ]));
    expect(existsSync(path.join(legacyDirectory, "morning-digest.definition.json"))).toBe(true);
    expect(existsSync(path.join(legacyDirectory, "plan-implement-verify.definition.json"))).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toEqual({
      schemaVersion: 1,
      createdAt: "2026-07-24T08:00:00.000Z",
      legacyDefinitionDirectory: legacyDirectory,
      legacyRunDirectory: legacyRunsDirectory,
      definitions: [
        {
          file: "morning-digest.definition.json",
          id: "morning-digest",
          sourceSha256: createHash("sha256").update(readFileSync(path.join(legacyDirectory, "morning-digest.definition.json"))).digest("hex"),
          outcome: "imported",
        },
        {
          file: "plan-implement-verify.definition.json",
          id: "plan-implement-verify",
          sourceSha256: createHash("sha256").update(readFileSync(path.join(legacyDirectory, "plan-implement-verify.definition.json"))).digest("hex"),
          outcome: "imported",
        },
      ],
      legacyRuns: {
        count: 1,
        active: [{
          file: "plan-implement-verify/run-active.json",
          workflowId: "plan-implement-verify",
          runId: "run-active",
          status: "running",
        }],
      },
    });

    expect(importLegacyWorkflowDefinitions(db, {
      legacyDirectory,
      legacyRunsDirectory,
      reportPath,
    })).toEqual({
      imported: 0, failed: 0, skipped: true,
    });
    expect(db.prepare("SELECT count(*) FROM workflow_definitions").pluck().get()).toBe(2);
    db.close();
  });

  it("preserves every definition whose behavior cannot be represented exactly and reports why", () => {
    const { legacyDirectory, legacyRunsDirectory, reportPath, db } = fixture();
    const definitions = [
      {
        ...morningDigest,
        id: "scheduled-workflow",
        nodes: [{ ...morningDigest.nodes[0], trigger: { kind: "schedule", cron: "0 8 * * *" } }],
      },
      {
        ...planImplementVerify,
        id: "gated-workflow",
        nodes: planImplementVerify.nodes.map((node) => node.id === "plan"
          ? { ...node, gates: [{ kind: "approval", approvalRef: "operator-review" }] }
          : node),
      },
      {
        ...planImplementVerify,
        id: "conditional-workflow",
        edges: [{
          id: "conditional",
          from: "plan",
          to: "implement",
          kind: "handoff",
          when: [{ path: "steps.plan.output.ready", op: "eq", value: true }],
        }],
      },
      {
        ...planImplementVerify,
        id: "loop-workflow",
        edges: [{ id: "loop", from: "verify", to: "plan", kind: "loop" }],
      },
      {
        ...planImplementVerify,
        id: "session-workflow",
        nodes: planImplementVerify.nodes.map((node) => node.id === "plan"
          ? { ...node, options: { ...node.options, session: { mode: "existing", sessionId: "session-1" } } }
          : node),
      },
    ];
    for (const definition of definitions) writeLegacy(legacyDirectory, definition);
    const logs: string[] = [];
    expect(importLegacyWorkflowDefinitions(db, {
      legacyDirectory,
      legacyRunsDirectory,
      reportPath,
      now: () => "2026-07-24T08:01:00.000Z",
      log: (_level, message) => logs.push(message),
    })).toEqual({ imported: 0, failed: 5, skipped: false });
    expect(logs.filter((line) => line.includes("preserved unsupported legacy Workflow"))).toHaveLength(5);
    for (const definition of definitions) {
      expect(existsSync(path.join(legacyDirectory, `${definition.id}.definition.json`))).toBe(true);
    }
    expect(db.prepare("SELECT count(*) FROM workflow_definitions").pluck().get()).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.definitions).toHaveLength(5);
    expect(report.definitions.every((entry: { outcome: string; reason?: string }) => (
      entry.outcome === "preserved" && typeof entry.reason === "string" && entry.reason.length > 0
    ))).toBe(true);
    expect(report.definitions.find((entry: { id: string }) => entry.id === "scheduled-workflow").reason).toMatch(/trigger/i);
    expect(report.definitions.find((entry: { id: string }) => entry.id === "gated-workflow").reason).toMatch(/gate/i);
    expect(report.definitions.find((entry: { id: string }) => entry.id === "conditional-workflow").reason).toMatch(/condition/i);
    expect(report.definitions.find((entry: { id: string }) => entry.id === "loop-workflow").reason).toMatch(/loop/i);
    expect(report.definitions.find((entry: { id: string }) => entry.id === "session-workflow").reason).toMatch(/session/i);
    db.close();
  });
});
