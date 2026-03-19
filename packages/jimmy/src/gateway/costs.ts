import { initDb } from '../sessions/registry.js';

export interface CostSummary {
  total: number;
  daily: { date: string; cost: number }[];
  byEmployee: { employee: string; cost: number; sessions: number }[];
  byDepartment: { department: string; cost: number }[];
}

export function getCostSummary(period: 'day' | 'week' | 'month' = 'month'): CostSummary {
  const db = initDb();

  const now = new Date();
  let cutoff: string;
  if (period === 'day') {
    cutoff = now.toISOString().slice(0, 10);
  } else if (period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    cutoff = d.toISOString().slice(0, 10);
  } else {
    cutoff = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  const totalRow = db.prepare(
    'SELECT COALESCE(SUM(total_cost), 0) as total FROM sessions WHERE created_at >= ?'
  ).get(cutoff) as { total: number };

  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const daily = db.prepare(
    `SELECT date(created_at) as date, SUM(total_cost) as cost
     FROM sessions WHERE created_at >= ?
     GROUP BY date(created_at) ORDER BY date`
  ).all(thirtyDaysAgo.toISOString().slice(0, 10)) as { date: string; cost: number }[];

  const byEmployee = db.prepare(
    `SELECT COALESCE(employee, 'direct') as employee, SUM(total_cost) as cost, COUNT(*) as sessions
     FROM sessions WHERE created_at >= ?
     GROUP BY employee ORDER BY cost DESC`
  ).all(cutoff) as { employee: string; cost: number; sessions: number }[];

  return { total: totalRow.total, daily, byEmployee, byDepartment: [] };
}

export function getCostsByEmployee(period: 'month' | 'week' = 'month') {
  const db = initDb();

  const now = new Date();
  const cutoff = period === 'week'
    ? (() => { const d = new Date(now); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })()
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  return db.prepare(
    `SELECT COALESCE(employee, 'direct') as employee, SUM(total_cost) as cost, COUNT(*) as sessions,
            SUM(total_turns) as turns
     FROM sessions WHERE created_at >= ?
     GROUP BY employee ORDER BY cost DESC`
  ).all(cutoff);
}
