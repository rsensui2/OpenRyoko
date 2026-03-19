import { v4 as uuid } from 'uuid';
import type { Database } from 'better-sqlite3';
import type { Goal } from '../shared/types.js';

function rowToGoal(row: Record<string, unknown>): Goal {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | null,
    status: row.status as Goal['status'],
    level: row.level as Goal['level'],
    parentId: row.parent_id as string | null,
    department: row.department as string | null,
    owner: row.owner as string | null,
    progress: row.progress as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function listGoals(db: Database): Goal[] {
  const rows = db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToGoal);
}

export function getGoalTree(db: Database): (Goal & { children: Goal[] })[] {
  const all = listGoals(db);
  const map = new Map<string, Goal & { children: Goal[] }>();
  const roots: (Goal & { children: Goal[] })[] = [];
  for (const g of all) {
    map.set(g.id, { ...g, children: [] });
  }
  for (const [, g] of map) {
    if (g.parentId && map.has(g.parentId)) {
      map.get(g.parentId)!.children.push(g);
    } else {
      roots.push(g);
    }
  }
  return roots;
}

export function getGoal(db: Database, id: string): Goal | null {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToGoal(row) : null;
}

export function createGoal(db: Database, data: Partial<Goal>): Goal {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO goals (id, title, description, status, level, parent_id, department, owner, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.title || 'Untitled',
    data.description ?? null,
    data.status ?? 'not_started',
    data.level ?? 'company',
    data.parentId ?? null,
    data.department ?? null,
    data.owner ?? null,
    data.progress ?? 0,
    now,
    now,
  );
  return getGoal(db, id)!;
}

export function updateGoal(db: Database, id: string, updates: Partial<Goal>): Goal | null {
  const existing = getGoal(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE goals SET
      title = ?, description = ?, status = ?, level = ?,
      parent_id = ?, department = ?, owner = ?, progress = ?, updated_at = ?
    WHERE id = ?
  `).run(
    updates.title ?? existing.title,
    updates.description ?? existing.description,
    updates.status ?? existing.status,
    updates.level ?? existing.level,
    updates.parentId ?? existing.parentId,
    updates.department ?? existing.department,
    updates.owner ?? existing.owner,
    updates.progress ?? existing.progress,
    now,
    id,
  );
  return getGoal(db, id);
}

export function deleteGoal(db: Database, id: string): void {
  // Cascade delete children
  const children = db.prepare('SELECT id FROM goals WHERE parent_id = ?').all(id) as { id: string }[];
  for (const child of children) {
    deleteGoal(db, child.id);
  }
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
}
