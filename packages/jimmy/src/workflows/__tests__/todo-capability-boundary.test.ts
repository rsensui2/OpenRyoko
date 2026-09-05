import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_DIR = path.resolve(import.meta.dirname, '..');
const SQLITE_OWNERS = new Set([
  'import-v1.ts',
  'repository-migrations.ts',
  'repository-run-transaction.ts',
  'repository-runs.ts',
  'repository-support.ts',
  'repository.ts',
]);

function productionWorkflowSources(): Array<{ file: string; source: string }> {
  return fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      file: entry.name,
      source: fs.readFileSync(path.join(WORKFLOWS_DIR, entry.name), 'utf8'),
    }));
}

describe('Workflow/Todo capability boundary', () => {
  it('keeps raw Todo storage, session DB, and Todo write capabilities outside Workflow runtime', () => {
    const forbidden = [
      { label: 'sessions registry import', pattern: /from\s+['"][^'"]*sessions\/registry(?:\.js)?['"]/ },
      { label: 'raw database type', pattern: /\bDatabase\b|better-sqlite3/ },
      { label: 'raw Todo SQL/table name', pattern: /\bwork_items\b|\bwork_item_events\b/ },
      { label: 'Todo write-module value import', pattern: /^import(?!\s+type\b)[^;]*work-items\/(?:store|transitions|approvals)(?:\.js)?['"]/m },
      { label: 'Todo write primitive', pattern: /\b(?:createWorkItem|updateWorkItem|transitionDerived|requestApproval|decideWorkItemApproval)\b/ },
      { label: 'raw DB acquisition', pattern: /\binitDb\s*\(/ },
    ];
    const violations = productionWorkflowSources().flatMap(({ file, source }) =>
      forbidden
        .filter(({ label, pattern }) =>
          pattern.test(source) && (label !== 'raw database type' || !SQLITE_OWNERS.has(file)),
        )
        .map(({ label }) => `${file}: ${label}`),
    );

    expect(violations).toEqual([]);
  });
});
