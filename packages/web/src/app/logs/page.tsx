"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw, Radio } from "lucide-react"
import { api } from "@/lib/api"
import { PageLayout, ToolbarActions } from "@/components/page-layout"
import { LogBrowser, parseLogLine } from "@/components/activity/log-browser"

/* ── Summary Cards ─────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  color,
  pulse,
}: {
  label: string
  value: number
  color?: string
  pulse?: boolean
}) {
  return (
    <div className="bg-[var(--material-regular)] border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-4)]">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)] mb-[var(--space-1)]">
        {label}
      </div>
      <div className="flex items-center gap-[var(--space-2)]">
        {pulse && value > 0 && (
          <span className="animate-error-pulse w-2 h-2 rounded-full bg-[var(--system-red)] shrink-0" />
        )}
        <span
          className="text-[length:var(--text-title2)] font-[var(--weight-bold)]"
          style={{ color: color ?? "var(--text-primary)" }}
        >
          {value}
        </span>
      </div>
    </div>
  )
}

/* ── Page ──────────────────────────────────────────────────────── */

export default function LogsPage() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [updatedAgo, setUpdatedAgo] = useState("just now")

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .getLogs(500)
      .then((data) => {
        setLines(data.lines ?? [])
        setLastRefresh(new Date())
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load logs")
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  // Updated ago ticker
  useEffect(() => {
    function tick() {
      const diff = Date.now() - lastRefresh.getTime()
      const secs = Math.floor(diff / 1000)
      if (secs < 10) setUpdatedAgo("just now")
      else if (secs < 60) setUpdatedAgo(`${secs}s ago`)
      else setUpdatedAgo(`${Math.floor(secs / 60)}m ago`)
    }
    tick()
    const interval = setInterval(tick, 10000)
    return () => clearInterval(interval)
  }, [lastRefresh])

  // Parse lines for summary counts
  const entries = lines.map(parseLogLine)
  const totalCount = entries.length
  const errorCount = entries.filter((e) => e.level === "error").length
  const infoCount = entries.filter((e) => e.level === "info").length
  const warnCount = entries.filter((e) => e.level === "warn").length

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden animate-fade-in bg-[var(--bg)]">
        {/* Sticky header */}
        <header
          className="sticky top-0 z-10 flex-shrink-0 bg-[var(--material-regular)] border-b border-[var(--separator)]"
          style={{
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
          }}
        >
          <div className="flex items-center justify-between px-[var(--space-6)] py-[var(--space-4)]">
            <div>
              <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] text-[var(--text-primary)] tracking-[-0.5px] leading-[var(--leading-tight)]">
                Activity Console
              </h1>
              {!loading && (
                <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] mt-[var(--space-1)]">
                  {totalCount} event{totalCount !== 1 ? "s" : ""}
                  {errorCount > 0 && (
                    <span className="text-[var(--system-red)]">
                      {" \u00b7 "}
                      {errorCount} error{errorCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </p>
              )}
            </div>
            <ToolbarActions>
              <div className="flex items-center gap-[var(--space-3)]">
                {/* Open Live Stream */}
                <button
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent("open-live-stream"))
                  }
                  className="focus-ring flex items-center py-[6px] px-[14px] rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] gap-1.5 bg-[var(--accent-fill)] text-[var(--accent)] transition-all duration-200 ease-[var(--ease-smooth)]"
                >
                  <Radio size={14} />
                  Open Live Stream
                </button>

                <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  Updated {updatedAgo}
                </span>
                <button
                  onClick={refresh}
                  className="focus-ring w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)]"
                  aria-label="Refresh logs"
                >
                  <RefreshCw
                    size={16}
                    className={refreshing ? "animate-spin" : ""}
                  />
                </button>
              </div>
            </ToolbarActions>
          </div>
        </header>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto flex flex-col px-[var(--space-6)] pt-[var(--space-4)] pb-[var(--space-6)] min-h-0">
          {/* Error banner */}
          {error && (
            <div className="mb-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] bg-[rgba(255,69,58,0.06)] border border-[rgba(255,69,58,0.15)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
              Failed to load logs: {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-[200px] text-[var(--text-tertiary)]">
              Loading...
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="summary-cards-grid grid grid-cols-4 gap-[var(--space-3)] mb-[var(--space-4)]">
                <SummaryCard label="Total Events" value={totalCount} />
                <SummaryCard
                  label="Errors"
                  value={errorCount}
                  color={
                    errorCount > 0
                      ? "var(--system-red)"
                      : "var(--system-green)"
                  }
                  pulse
                />
                <SummaryCard
                  label="Info"
                  value={infoCount}
                  color="var(--system-green)"
                />
                <SummaryCard
                  label="Warnings"
                  value={warnCount}
                  color="var(--system-orange)"
                />
              </div>

              {/* Log browser */}
              <LogBrowser lines={lines} />
            </>
          )}
        </div>

        <style>{`
          @media (max-width: 640px) {
            .summary-cards-grid {
              grid-template-columns: 1fr 1fr !important;
            }
          }
        `}</style>
      </div>
    </PageLayout>
  )
}
