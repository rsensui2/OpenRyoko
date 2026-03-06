// ── Types ────────────────────────────────────────────────────

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
}

export interface CronRun {
  ts: number
  jobId: string
  status: string
  durationMs: number
  model?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

export interface RunCost {
  ts: number
  jobId: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheTokens: number
  minCost: number
}

export interface JobCostSummary {
  jobId: string
  runs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalCost: number
  medianCost: number
}

export interface DailyCost {
  date: string
  cost: number
  runs: number
}

export interface ModelBreakdown {
  model: string
  tokens: number
  pct: number
}

export interface TokenAnomaly {
  ts: number
  jobId: string
  totalTokens: number
  medianTokens: number
  ratio: number
}

export interface WeekOverWeek {
  thisWeek: number
  lastWeek: number
  changePct: number | null
}

export interface CacheSavings {
  cacheTokens: number
  estimatedSavings: number
}

export interface CostSummary {
  totalCost: number
  topSpender: { jobId: string; cost: number } | null
  anomalies: TokenAnomaly[]
  jobCosts: JobCostSummary[]
  dailyCosts: DailyCost[]
  modelBreakdown: ModelBreakdown[]
  runCosts: RunCost[]
  weekOverWeek: WeekOverWeek
  cacheSavings: CacheSavings
}

// ── Pricing table (per 1M tokens) ────────────────────────────

const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6':   { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-5':   { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5':    { inputPer1M: 0.80, outputPer1M: 4 },
  'claude-opus-4-6':     { inputPer1M: 15, outputPer1M: 75 },
  'claude-3-5-sonnet':   { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-haiku':    { inputPer1M: 0.80, outputPer1M: 4 },
  'claude-3-haiku':      { inputPer1M: 0.25, outputPer1M: 1.25 },
}

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 3, outputPer1M: 15 }

export function getModelPricing(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model]
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key]
  }
  return DEFAULT_PRICING
}

// ── Transform runs to costed runs ────────────────────────────

export function toRunCosts(runs: CronRun[]): RunCost[] {
  const result: RunCost[] = []
  for (const run of runs) {
    if (!run.usage) continue
    const pricing = getModelPricing(run.model ?? '')
    const inputTokens = run.usage.input_tokens
    const outputTokens = run.usage.output_tokens
    const totalTokens = run.usage.total_tokens
    const cacheTokens = Math.max(0, totalTokens - inputTokens - outputTokens)
    const minCost = (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000

    result.push({
      ts: run.ts,
      jobId: run.jobId,
      model: run.model ?? 'unknown',
      inputTokens,
      outputTokens,
      totalTokens,
      cacheTokens,
      minCost,
    })
  }
  return result
}

// ── Helpers ──────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ── Job-level aggregation ────────────────────────────────────

function computeJobCosts(runCosts: RunCost[]): JobCostSummary[] {
  const map = new Map<string, RunCost[]>()
  for (const rc of runCosts) {
    const arr = map.get(rc.jobId) ?? []
    arr.push(rc)
    map.set(rc.jobId, arr)
  }

  const result: JobCostSummary[] = []
  for (const [jobId, runs] of map) {
    result.push({
      jobId,
      runs: runs.length,
      totalInputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
      totalCacheTokens: runs.reduce((s, r) => s + r.cacheTokens, 0),
      totalCost: runs.reduce((s, r) => s + r.minCost, 0),
      medianCost: median(runs.map(r => r.minCost)),
    })
  }
  return result.sort((a, b) => b.totalCost - a.totalCost)
}

// ── Daily aggregation ────────────────────────────────────────

function computeDailyCosts(runCosts: RunCost[]): DailyCost[] {
  const map = new Map<string, { cost: number; runs: number }>()
  for (const rc of runCosts) {
    const date = new Date(rc.ts).toISOString().slice(0, 10)
    const entry = map.get(date) ?? { cost: 0, runs: 0 }
    entry.cost += rc.minCost
    entry.runs += 1
    map.set(date, entry)
  }
  return Array.from(map.entries())
    .map(([date, v]) => ({ date, cost: v.cost, runs: v.runs }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ── Model breakdown ──────────────────────────────────────────

function computeModelBreakdown(runCosts: RunCost[]): ModelBreakdown[] {
  const map = new Map<string, number>()
  let total = 0
  for (const rc of runCosts) {
    map.set(rc.model, (map.get(rc.model) ?? 0) + rc.totalTokens)
    total += rc.totalTokens
  }
  if (total === 0) return []
  return Array.from(map.entries())
    .map(([model, tokens]) => ({ model, tokens, pct: (tokens / total) * 100 }))
    .sort((a, b) => b.tokens - a.tokens)
}

// ── Anomaly detection ────────────────────────────────────────

function detectAnomalies(runCosts: RunCost[], jobSummaries: JobCostSummary[]): TokenAnomaly[] {
  const countMap = new Map<string, number>()
  for (const js of jobSummaries) {
    countMap.set(js.jobId, js.runs)
  }

  const tokensByJob = new Map<string, number[]>()
  for (const rc of runCosts) {
    const arr = tokensByJob.get(rc.jobId) ?? []
    arr.push(rc.totalTokens)
    tokensByJob.set(rc.jobId, arr)
  }

  const medianMap = new Map<string, number>()
  for (const [jobId, tokens] of tokensByJob) {
    medianMap.set(jobId, median(tokens))
  }

  const anomalies: TokenAnomaly[] = []
  for (const rc of runCosts) {
    const count = countMap.get(rc.jobId) ?? 0
    if (count < 3) continue
    const med = medianMap.get(rc.jobId) ?? 0
    if (med === 0) continue
    const ratio = rc.totalTokens / med
    if (ratio > 5) {
      anomalies.push({
        ts: rc.ts,
        jobId: rc.jobId,
        totalTokens: rc.totalTokens,
        medianTokens: med,
        ratio,
      })
    }
  }
  return anomalies.sort((a, b) => b.ratio - a.ratio)
}

// ── Week-over-week comparison ────────────────────────────────

function computeWeekOverWeek(runCosts: RunCost[]): WeekOverWeek {
  const now = Date.now()
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000
  const thisWeekStart = now - ONE_WEEK
  const lastWeekStart = now - 2 * ONE_WEEK

  let thisWeek = 0
  let lastWeek = 0
  for (const rc of runCosts) {
    if (rc.ts >= thisWeekStart) thisWeek += rc.minCost
    else if (rc.ts >= lastWeekStart) lastWeek += rc.minCost
  }

  const changePct = lastWeek > 0
    ? ((thisWeek - lastWeek) / lastWeek) * 100
    : null

  return { thisWeek, lastWeek, changePct }
}

// ── Cache savings estimation ─────────────────────────────────

function computeCacheSavings(runCosts: RunCost[]): CacheSavings {
  let cacheTokens = 0
  let estimatedSavings = 0
  for (const rc of runCosts) {
    if (rc.cacheTokens > 0) {
      cacheTokens += rc.cacheTokens
      const pricing = getModelPricing(rc.model)
      estimatedSavings += (rc.cacheTokens * pricing.inputPer1M) / 1_000_000
    }
  }
  return { cacheTokens, estimatedSavings }
}

// ── Master function ──────────────────────────────────────────

export function computeCostSummary(runCosts: RunCost[]): CostSummary {
  const jobCosts = computeJobCosts(runCosts)
  const dailyCosts = computeDailyCosts(runCosts)
  const modelBreakdown = computeModelBreakdown(runCosts)
  const anomalies = detectAnomalies(runCosts, jobCosts)

  const totalCost = jobCosts.reduce((s, j) => s + j.totalCost, 0)
  const topSpender = jobCosts.length > 0
    ? { jobId: jobCosts[0].jobId, cost: jobCosts[0].totalCost }
    : null
  const weekOverWeek = computeWeekOverWeek(runCosts)
  const cacheSavings = computeCacheSavings(runCosts)

  return { totalCost, topSpender, anomalies, jobCosts, dailyCosts, modelBreakdown, runCosts, weekOverWeek, cacheSavings }
}
