"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import {
  toRunCosts,
  computeCostSummary,
  type CronRun,
  type CostSummary,
  type RunCost,
  type JobCostSummary,
} from "@/lib/costs"

/* ── Formatters ───────────────────────────────────────────────── */

function fmtCost(v: number): string {
  if (v < 0.01 && v > 0) return "<$0.01"
  return `$${v.toFixed(2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/* ── Summary Card ────────────────────────────────────────────── */

function SummaryCard({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-caption1)",
          color: "var(--text-tertiary)",
          fontWeight: 500,
          marginBottom: "var(--space-1)",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

/* ── Daily Cost Bar Chart (Canvas API) ───────────────────────── */

function DailyCostChart({
  dailyCosts,
}: {
  dailyCosts: CostSummary["dailyCosts"]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || dailyCosts.length === 0) return

    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    const W = rect.width
    const H = 220

    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`

    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(dpr, dpr)

    // Read CSS variables
    const styles = getComputedStyle(document.documentElement)
    const textTertiary = styles.getPropertyValue("--text-tertiary").trim() || "#888"
    const separator = styles.getPropertyValue("--separator").trim() || "#333"
    const accent = styles.getPropertyValue("--accent").trim() || "#007AFF"

    const PAD_L = 50
    const PAD_B = 28
    const PAD_T = 12
    const PAD_R = 12
    const chartW = W - PAD_L - PAD_R
    const chartH = H - PAD_B - PAD_T

    const maxCost = Math.max(...dailyCosts.map((d) => d.cost), 0.01)
    const barW = Math.max(
      6,
      Math.min(40, (chartW - dailyCosts.length * 2) / dailyCosts.length)
    )
    const gap = 2

    // Clear
    ctx.clearRect(0, 0, W, H)

    // Grid lines + Y-axis labels
    const ticks = [0, maxCost * 0.25, maxCost * 0.5, maxCost * 0.75, maxCost]
    ctx.font = "9px -apple-system, sans-serif"
    ctx.textAlign = "right"
    for (const t of ticks) {
      const y = PAD_T + chartH - (t / maxCost) * chartH
      ctx.strokeStyle = separator
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(PAD_L, y)
      ctx.lineTo(W - PAD_R, y)
      ctx.stroke()
      ctx.fillStyle = textTertiary
      ctx.fillText(`$${t.toFixed(2)}`, PAD_L - 6, y + 3)
    }

    // Bars
    for (let i = 0; i < dailyCosts.length; i++) {
      const d = dailyCosts[i]
      const barH = (d.cost / maxCost) * chartH
      const x = PAD_L + i * (barW + gap)
      const y = PAD_T + chartH - barH

      ctx.fillStyle = accent
      ctx.globalAlpha = 0.8

      // Rounded rect top
      const r = 2
      const h = Math.max(1, barH)
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + barW - r, y)
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + r)
      ctx.lineTo(x + barW, y + h)
      ctx.lineTo(x, y + h)
      ctx.lineTo(x, y + r)
      ctx.quadraticCurveTo(x, y, x + r, y)
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1

      // X-axis labels (first, last, every 7th)
      if (i === 0 || i === dailyCosts.length - 1 || i % 7 === 0) {
        ctx.fillStyle = textTertiary
        ctx.textAlign = "center"
        ctx.font = "8px -apple-system, sans-serif"
        ctx.fillText(d.date.slice(5), x + barW / 2, H - 6)
      }
    }
  }, [dailyCosts])

  useEffect(() => {
    draw()
    window.addEventListener("resize", draw)
    return () => window.removeEventListener("resize", draw)
  }, [draw])

  if (dailyCosts.length === 0) return null

  return (
    <div
      ref={containerRef}
      style={{
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-caption1)",
          color: "var(--text-tertiary)",
          fontWeight: 500,
          marginBottom: "var(--space-3)",
        }}
      >
        Daily Estimated Cost
      </div>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%" }} />
    </div>
  )
}

/* ── Model Breakdown (horizontal bar) ────────────────────────── */

function ModelBreakdownChart({
  breakdown,
}: {
  breakdown: CostSummary["modelBreakdown"]
}) {
  if (breakdown.length === 0) return null

  const colors = [
    "var(--system-blue)",
    "var(--system-green)",
    "var(--accent)",
    "var(--system-orange)",
    "var(--system-purple)",
  ]

  return (
    <div
      style={{
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-caption1)",
          color: "var(--text-tertiary)",
          fontWeight: 500,
          marginBottom: "var(--space-3)",
        }}
      >
        Model Breakdown
      </div>

      {/* Stacked horizontal bar */}
      <div
        style={{
          display: "flex",
          height: 20,
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          marginBottom: "var(--space-3)",
        }}
      >
        {breakdown.map((m, i) => (
          <div
            key={m.model}
            style={{
              width: `${m.pct}%`,
              background: colors[i % colors.length],
              minWidth: m.pct > 0 ? 2 : 0,
            }}
          />
        ))}
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-2)",
          fontSize: "var(--text-caption1)",
        }}
      >
        {breakdown.map((m, i) => (
          <div
            key={m.model}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: colors[i % colors.length],
                flexShrink: 0,
              }}
            />
            <span
              style={{
                color: "var(--text-secondary)",
                fontWeight: 500,
              }}
            >
              {m.model}
            </span>
            <span
              style={{
                color: "var(--text-tertiary)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {m.pct.toFixed(0)}% ({fmtTokens(m.tokens)})
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Per-Job Cost Table (sortable) ───────────────────────────── */

type SortKey = "jobId" | "runs" | "totalCost"
type SortDir = "asc" | "desc"

function JobCostTable({
  jobCosts,
  jobName,
}: {
  jobCosts: JobCostSummary[]
  jobName: (id: string) => string
}) {
  const [sortKey, setSortKey] = useState<SortKey>("totalCost")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  const sorted = [...jobCosts].sort((a, b) => {
    let cmp = 0
    if (sortKey === "jobId") {
      cmp = jobName(a.jobId).localeCompare(jobName(b.jobId))
    } else {
      cmp = (a[sortKey] as number) - (b[sortKey] as number)
    }
    return sortDir === "asc" ? cmp : -cmp
  })

  const arrow = (key: SortKey) => {
    if (sortKey !== key) return ""
    return sortDir === "asc" ? " \u25B2" : " \u25BC"
  }

  const headerStyle: React.CSSProperties = {
    cursor: "pointer",
    userSelect: "none",
    fontSize: "var(--text-caption1)",
    color: "var(--text-tertiary)",
    fontWeight: 500,
  }

  if (jobCosts.length === 0) return null

  return (
    <div
      style={{
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center"
        style={{
          padding: "var(--space-2) var(--space-4)",
          borderBottom: "1px solid var(--separator)",
          gap: "var(--space-3)",
        }}
      >
        <span
          style={{ ...headerStyle, flex: 2, minWidth: 0 }}
          onClick={() => toggleSort("jobId")}
        >
          Job{arrow("jobId")}
        </span>
        <span
          style={{ ...headerStyle, width: 50, textAlign: "right" }}
          onClick={() => toggleSort("runs")}
        >
          Runs{arrow("runs")}
        </span>
        <span style={{ ...headerStyle, width: 80, textAlign: "right" }}>
          Input
        </span>
        <span style={{ ...headerStyle, width: 80, textAlign: "right" }}>
          Output
        </span>
        <span
          className="hidden-mobile"
          style={{ ...headerStyle, width: 80, textAlign: "right" }}
        >
          Cache
        </span>
        <span
          style={{ ...headerStyle, width: 80, textAlign: "right" }}
          onClick={() => toggleSort("totalCost")}
        >
          Est. Cost{arrow("totalCost")}
        </span>
      </div>

      {/* Rows */}
      {sorted.map((job, i) => (
        <div
          key={job.jobId}
          className="flex items-center"
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderBottom:
              i < sorted.length - 1 ? "1px solid var(--separator)" : undefined,
            fontSize: "var(--text-footnote)",
            color: "var(--text-primary)",
            gap: "var(--space-3)",
          }}
        >
          <span
            style={{
              flex: 2,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 500,
            }}
          >
            {jobName(job.jobId)}
          </span>
          <span
            style={{
              width: 50,
              textAlign: "right",
              color: "var(--text-secondary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {job.runs}
          </span>
          <span
            style={{
              width: 80,
              textAlign: "right",
              color: "var(--text-secondary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTokens(job.totalInputTokens)}
          </span>
          <span
            style={{
              width: 80,
              textAlign: "right",
              color: "var(--text-secondary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTokens(job.totalOutputTokens)}
          </span>
          <span
            className="hidden-mobile"
            style={{
              width: 80,
              textAlign: "right",
              color: "var(--text-tertiary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTokens(job.totalCacheTokens)}
          </span>
          <span
            style={{
              width: 80,
              textAlign: "right",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtCost(job.totalCost)}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── Anomaly Alerts ──────────────────────────────────────────── */

function AnomalyAlerts({
  anomalies,
  jobName,
}: {
  anomalies: CostSummary["anomalies"]
  jobName: (id: string) => string
}) {
  if (anomalies.length === 0) return null

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3) var(--space-4)",
        background: "rgba(255, 149, 0, 0.08)",
        border: "1px solid rgba(255, 149, 0, 0.25)",
        borderRadius: "var(--radius-md)",
        marginBottom: "var(--space-4)",
        fontSize: "var(--text-footnote)",
        color: "var(--system-orange)",
      }}
    >
      <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        {anomalies.length} anomal{anomalies.length === 1 ? "y" : "ies"}{" "}
        detected
      </div>
      {anomalies.map((a, i) => (
        <div key={`${a.ts}-${a.jobId}-${i}`} style={{ paddingLeft: 24 }}>
          <span style={{ fontWeight: 500 }}>{jobName(a.jobId)}</span>
          {" -- "}
          {fmtTokens(a.totalTokens)} tokens ({a.ratio.toFixed(1)}x median of{" "}
          {fmtTokens(a.medianTokens)}) on {fmtDate(a.ts)}
        </div>
      ))}
    </div>
  )
}

/* ── CostsPage ───────────────────────────────────────────────── */

interface CronJob {
  id: string
  name: string
  [key: string]: unknown
}

export function CostsPage() {
  const [data, setData] = useState<CostSummary | null>(null)
  const [jobNames, setJobNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)

    api
      .getCronJobs()
      .then(async (cronData) => {
        const jobs = cronData as CronJob[]
        const names: Record<string, string> = {}
        for (const c of jobs) {
          names[c.id] = c.name
        }
        setJobNames(names)

        // Fetch runs for each job in parallel
        const allRunResults = await Promise.allSettled(
          jobs.map((job) =>
            api.getCronRuns(job.id).then((runs) =>
              (runs as unknown as CronRun[]).map((r) => ({
                ...r,
                jobId: r.jobId ?? job.id,
              }))
            )
          )
        )

        const allRuns: CronRun[] = []
        for (const result of allRunResults) {
          if (result.status === "fulfilled") {
            allRuns.push(...result.value)
          }
        }

        const runCosts = toRunCosts(allRuns)
        const summary = computeCostSummary(runCosts)
        setData(summary)
        setLoading(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Unknown error")
        setLoading(false)
      })
  }, [])

  const jobName = (id: string) => jobNames[id] || id

  const dateRange =
    data && data.runCosts.length > 0
      ? {
          oldest: new Date(Math.min(...data.runCosts.map((r) => r.ts))),
          newest: new Date(Math.max(...data.runCosts.map((r) => r.ts))),
        }
      : null

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      {/* Sticky header */}
      <header
        className="sticky top-0 z-10 flex-shrink-0"
        style={{
          background: "var(--material-regular)",
          backdropFilter: "blur(40px) saturate(180%)",
          WebkitBackdropFilter: "blur(40px) saturate(180%)",
          borderBottom: "1px solid var(--separator)",
          padding: "var(--space-4) var(--space-6)",
        }}
      >
        <h1
          style={{
            fontSize: "var(--text-title1)",
            fontWeight: 700,
            color: "var(--text-primary)",
            letterSpacing: "-0.5px",
            lineHeight: 1.2,
          }}
        >
          Costs
        </h1>
        {!loading && data && (
          <p
            style={{
              fontSize: "var(--text-footnote)",
              color: "var(--text-secondary)",
              marginTop: "var(--space-1)",
            }}
          >
            {dateRange
              ? `${dateRange.oldest.toLocaleDateString()} - ${dateRange.newest.toLocaleDateString()}`
              : "No data"}
            {" \u00B7 "}
            {data.runCosts.length} run
            {data.runCosts.length !== 1 ? "s" : ""} with cost data
          </p>
        )}
      </header>

      {/* Scrollable content */}
      <div
        className="flex-1 overflow-y-auto"
        style={{
          padding: "var(--space-4) var(--space-6) var(--space-6)",
          minHeight: 0,
        }}
      >
        {/* Error state */}
        {error && (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-8)",
              color: "var(--system-red)",
              fontSize: "var(--text-footnote)",
            }}
          >
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div>
            <div
              className="costs-summary-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: "var(--space-3)",
                marginBottom: "var(--space-4)",
              }}
            >
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  style={{
                    background: "var(--material-regular)",
                    border: "1px solid var(--separator)",
                    borderRadius: "var(--radius-md)",
                    padding: "var(--space-4)",
                  }}
                >
                  <Skeleton style={{ width: 100, height: 10, marginBottom: 8 }} />
                  <Skeleton style={{ width: 60, height: 20 }} />
                </div>
              ))}
            </div>
            <div
              style={{
                background: "var(--material-regular)",
                border: "1px solid var(--separator)",
                borderRadius: "var(--radius-md)",
                overflow: "hidden",
              }}
            >
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="flex items-center"
                  style={{
                    padding: "var(--space-3) var(--space-4)",
                    borderBottom:
                      i < 4 ? "1px solid var(--separator)" : undefined,
                    gap: "var(--space-3)",
                  }}
                >
                  <Skeleton style={{ width: 140, height: 14 }} />
                  <Skeleton style={{ width: 60, height: 14, flex: 1 }} />
                  <Skeleton style={{ width: 80, height: 14 }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && (!data || data.runCosts.length === 0) && (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-8)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-footnote)",
            }}
          >
            No cost data -- runs without usage metadata will not appear here.
          </div>
        )}

        {/* Data */}
        {!loading && !error && data && data.runCosts.length > 0 && (
          <>
            {/* Anomaly alerts */}
            <AnomalyAlerts anomalies={data.anomalies} jobName={jobName} />

            {/* Summary cards */}
            <div
              className="costs-summary-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: "var(--space-3)",
                marginBottom: "var(--space-4)",
              }}
            >
              {/* Total Cost */}
              <SummaryCard label="Total Estimated Cost">
                <div
                  className="flex items-center"
                  style={{ gap: "var(--space-2)" }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-title2)",
                      color: "var(--text-primary)",
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtCost(data.totalCost)}
                  </span>
                </div>
              </SummaryCard>

              {/* Top Spender */}
              <SummaryCard label="Top Spender">
                {data.topSpender ? (
                  <>
                    <div
                      style={{
                        fontSize: "var(--text-footnote)",
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {jobName(data.topSpender.jobId)}
                    </div>
                    <div
                      style={{
                        fontSize: "var(--text-caption1)",
                        color: "var(--text-tertiary)",
                        fontVariantNumeric: "tabular-nums",
                        marginTop: 2,
                      }}
                    >
                      {fmtCost(data.topSpender.cost)}
                    </div>
                  </>
                ) : (
                  <span style={{ color: "var(--text-tertiary)" }}>--</span>
                )}
              </SummaryCard>

              {/* WoW Change */}
              <SummaryCard label="Week over Week">
                <div
                  className="flex items-center"
                  style={{ gap: "var(--space-2)" }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-title2)",
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color:
                        data.weekOverWeek.changePct !== null
                          ? data.weekOverWeek.changePct <= 0
                            ? "var(--system-green)"
                            : "var(--system-red)"
                          : "var(--text-primary)",
                    }}
                  >
                    {data.weekOverWeek.changePct !== null
                      ? `${data.weekOverWeek.changePct > 0 ? "+" : ""}${data.weekOverWeek.changePct.toFixed(0)}%`
                      : "--"}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginTop: 2,
                  }}
                >
                  {fmtCost(data.weekOverWeek.thisWeek)} vs{" "}
                  {fmtCost(data.weekOverWeek.lastWeek)}
                </div>
              </SummaryCard>

              {/* Cache Savings */}
              <SummaryCard label="Cache Savings">
                <div
                  style={{
                    fontSize: "var(--text-title2)",
                    color: "var(--system-green)",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtCost(data.cacheSavings.estimatedSavings)}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginTop: 2,
                  }}
                >
                  {fmtTokens(data.cacheSavings.cacheTokens)} cache tokens
                </div>
              </SummaryCard>
            </div>

            {/* Charts row */}
            <div
              className="charts-row"
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr",
                gap: "var(--space-4)",
                marginBottom: "var(--space-4)",
              }}
            >
              <DailyCostChart dailyCosts={data.dailyCosts} />
              <ModelBreakdownChart breakdown={data.modelBreakdown} />
            </div>

            {/* Per-job cost table */}
            <JobCostTable jobCosts={data.jobCosts} jobName={jobName} />
          </>
        )}
      </div>

      <style>{`
        @media (max-width: 768px) {
          .costs-summary-grid {
            grid-template-columns: repeat(2, 1fr) !important;
          }
          .charts-row {
            grid-template-columns: 1fr !important;
          }
        }
        @media (max-width: 640px) {
          .costs-summary-grid {
            grid-template-columns: 1fr !important;
          }
          .hidden-mobile { display: none !important; }
        }
      `}</style>
    </div>
  )
}
