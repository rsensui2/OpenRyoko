import { v4 as uuid } from 'uuid';
import { initDb } from '../sessions/registry.js';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded' | 'paused';

export interface BudgetStatusResult {
  status: BudgetStatus;
  spend: number;
  limit: number;
  percent: number;
}

export function getBudgetStatus(employee: string, budgetConfig: Record<string, number>): BudgetStatusResult {
  const db = initDb();
  const limit = budgetConfig[employee];
  if (!limit) return { status: 'ok', spend: 0, limit: 0, percent: 0 };

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions WHERE employee = ? AND created_at >= ?`
  ).get(employee, monthStart) as { spend: number };

  const spend = row.spend;
  const percent = limit > 0 ? Math.round((spend / limit) * 100) : 0;

  let status: BudgetStatus;
  if (percent >= 100) status = 'paused';
  else if (percent >= 80) status = 'warning';
  else status = 'ok';

  return { status, spend, limit, percent };
}

export function checkBudget(employee: string, budgetConfig: Record<string, number>): BudgetStatus {
  const result = getBudgetStatus(employee, budgetConfig);
  return result.status;
}

export function recordBudgetEvent(employee: string, eventType: string, amount: number, limitAmount: number) {
  const db = initDb();
  db.prepare(
    `INSERT INTO budget_events (id, employee, event_type, amount, limit_amount) VALUES (?, ?, ?, ?, ?)`
  ).run(uuid(), employee, eventType, amount, limitAmount);
}

export function getBudgetEvents(limit = 50) {
  const db = initDb();
  return db.prepare(
    `SELECT * FROM budget_events ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
}

export function overrideBudget(employee: string, budgetConfig: Record<string, number>) {
  const limit = budgetConfig[employee] || 0;
  recordBudgetEvent(employee, 'override', 0, limit);
  return { status: 'ok', message: `Budget override recorded for ${employee}` };
}
