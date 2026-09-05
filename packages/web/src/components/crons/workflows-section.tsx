"use client"

/**
 * Workflows inside the automation page — rendered above the cron groups so
 * the two kinds live in ONE list view. Covers: guidance when the engine is
 * disabled, the workflow rows (toggle / expand for flow + recent runs / run
 * now), and template-based creation. Visual language follows the cron rows
 * exactly (status dot, borderLeft, --material-regular cards).
 */

import { useCallback, useEffect, useState } from "react"
import {
  api,
  type AutomationTemplateSpec,
  type WorkflowDefinitionDetail,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from "@/lib/api"
import { Skeleton } from "@/components/ui/skeleton"

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "—"
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return "—"
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  const hrs = Math.floor(diff / 3600000)
  if (mins < 1) return "たった今"
  if (mins < 60) return `${mins}分前`
  if (hrs < 24) return `${hrs}時間前`
  return `${Math.floor(diff / 86400000)}日前`
}

const RUN_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  running: { label: "実行中", color: "var(--system-blue)" },
  waiting: { label: "待機中", color: "var(--system-orange)" },
  completed: { label: "完了", color: "var(--system-green)" },
  failed: { label: "失敗", color: "var(--system-red)" },
  cancelled: { label: "中止", color: "var(--text-tertiary)" },
}

/* ------------------------------------------------------------------ */
/*  Recent runs (lazy per workflow)                                    */
/* ------------------------------------------------------------------ */

function PendingApproval({ workflowId, run, onDecided }: {
  workflowId: string
  run: WorkflowRunSummary
  onDecided: () => void
}) {
  const [detail, setDetail] = useState<import("@/lib/api").WorkflowRunDetailForApproval | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getWorkflowRun(workflowId, run.id)
      .then((result) => { if (!cancelled) setDetail(result) })
      .catch(() => { /* the row simply offers no buttons */ })
    return () => { cancelled = true }
  }, [workflowId, run.id])

  const pending = detail?.approvals.find((approval) => approval.status === "pending")
  if (!pending) return null

  // What the human is deciding ON: the nearest upstream output with real
  // fields (a Condition only reports its chosen port) — external, unverified
  // content by construction. Rendered as plain text only.
  let context: Record<string, unknown> | undefined
  {
    let current = pending.nodeId
    for (let hop = 0; hop < 5 && detail; hop += 1) {
      const source = detail.definition?.edges.find((edge) => edge.to.nodeId === current)?.from.nodeId
      if (!source) break
      const fields = detail.nodeRuns.find((nodeRun) => nodeRun.nodeId === source)?.output?.fields
      if (fields && Object.keys(fields).filter((key) => key !== "port").length > 0) { context = fields; break }
      current = source
    }
  }

  const decide = (decision: "approve" | "reject") => {
    setBusy(true)
    setError(null)
    api.decideWorkflowApproval(workflowId, run.id, pending.nodeId, decision, detail!.revision)
      .then(() => onDecided())
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5 ml-1">
      {context && (
        <span className="basis-full text-[length:var(--text-caption2)] text-[var(--text-secondary)] whitespace-pre-wrap">
          <span className="text-[var(--system-orange)] font-semibold">外部由来・未検証の報告: </span>
          {Object.entries(context)
            .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
            .join(" / ")}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); decide("approve") }}
        disabled={busy}
        className="px-2 py-0.5 rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-caption2)] font-semibold"
        style={{ background: "var(--system-green)", color: "#fff", opacity: busy ? 0.6 : 1 }}
      >
        承認
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); decide("reject") }}
        disabled={busy}
        className="px-2 py-0.5 rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-caption2)] font-semibold bg-[var(--fill-secondary)] text-[var(--text-primary)]"
        style={{ opacity: busy ? 0.6 : 1 }}
      >
        却下
      </button>
      {error && <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">{error}</span>}
    </span>
  )
}

function WorkflowRuns({ workflowId, refreshKey }: { workflowId: string; refreshKey: number }) {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bump, setBump] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.getWorkflowRuns(workflowId)
      .then((result) => { if (!cancelled) setRuns(result.items) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [workflowId, refreshKey, bump])

  if (error) {
    return <div className="text-[length:var(--text-caption1)] text-[var(--system-red)] py-[var(--space-2)]">実行履歴を取得できませんでした: {error}</div>
  }
  if (!runs) return <Skeleton className="h-8 rounded-[var(--radius-sm)]" />
  if (runs.length === 0) {
    return <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] py-[var(--space-2)]">実行履歴はまだありません</div>
  }
  return (
    <div className="flex flex-col gap-1">
      {runs.slice(0, 8).map((run) => {
        const status = RUN_STATUS_LABEL[run.status] ?? { label: run.status, color: "var(--text-secondary)" }
        return (
          <div key={run.id} className="flex items-center gap-[var(--space-3)] text-[length:var(--text-caption1)]">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: status.color }} />
            <span className="text-[var(--text-secondary)] tabular-nums">{timeAgo(run.startedAt)}</span>
            <span style={{ color: status.color }}>{status.label}</span>
            {run.currentOrFailingNode && (
              <span className="text-[var(--text-tertiary)] truncate">@ {run.currentOrFailingNode.label}</span>
            )}
            {run.status === "waiting" && (
              <PendingApproval workflowId={workflowId} run={run} onDecided={() => setBump((n) => n + 1)} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Node flow strip                                                    */
/* ------------------------------------------------------------------ */

const NODE_TYPE_LABEL: Record<string, string> = {
  trigger: "起動", employee: "AI", condition: "分岐", merge: "合流",
  approval: "承認", wait: "待機", end: "終了", "workflow-call": "呼出",
}

function NodeFlow({ detail }: { detail: WorkflowDefinitionDetail }) {
  return (
    <div className="flex items-center flex-wrap gap-1.5 text-[length:var(--text-caption1)]">
      {detail.nodes.map((node, index) => (
        <span key={node.id} className="flex items-center gap-1.5">
          {index > 0 && <span className="text-[var(--text-quaternary)]">→</span>}
          <span className="px-2 py-px rounded-xl bg-[var(--fill-tertiary)] text-[var(--text-secondary)]">
            {node.name}
            <span className="text-[var(--text-quaternary)] ml-1">{NODE_TYPE_LABEL[node.type] ?? node.type}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Template creation form                                             */
/* ------------------------------------------------------------------ */

function TemplateForm({
  template, onCreated, onCancel,
}: { template: AutomationTemplateSpec; onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  const [vars, setVars] = useState<Record<string, string>>({})
  const [enable, setEnable] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) { setError("ID（英数とハイフン）を入力してください"); return }
    setSubmitting(true)
    setError(null)
    try {
      await api.createWorkflowFromTemplate(template.id, { name: name.trim(), vars, enable })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--fill-quaternary)] text-[var(--text-primary)] text-[length:var(--text-footnote)] outline-none focus:border-[var(--accent)]"

  return (
    <div className="flex flex-col gap-[var(--space-3)]">
      <div>
        <label className="block text-[length:var(--text-caption1)] text-[var(--text-secondary)] mb-1" htmlFor="wf-new-id">
          ID <span className="text-[var(--system-red)]">*</span>
          <span className="text-[var(--text-tertiary)] ml-2">英数とハイフン（例: inquiry-watch）</span>
        </label>
        <input id="wf-new-id" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="inquiry-watch" />
      </div>
      {template.variables.map((variable) => (
        <div key={variable.key}>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-secondary)] mb-1" htmlFor={`wf-var-${variable.key}`}>
            {variable.label}
            {variable.required && <span className="text-[var(--system-red)]"> *</span>}
            <span className="text-[var(--text-tertiary)] ml-2">{variable.hint}</span>
          </label>
          {variable.options ? (
            <select
              id={`wf-var-${variable.key}`}
              className={inputClass}
              value={vars[variable.key] ?? variable.default ?? ""}
              onChange={(e) => setVars((prev) => ({ ...prev, [variable.key]: e.target.value }))}
            >
              {variable.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <input
              id={`wf-var-${variable.key}`}
              className={inputClass}
              value={vars[variable.key] ?? ""}
              placeholder={variable.default ?? ""}
              onChange={(e) => setVars((prev) => ({ ...prev, [variable.key]: e.target.value }))}
            />
          )}
        </div>
      ))}
      <label className="flex items-center gap-2 text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer">
        <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
        作成後すぐ有効にする
      </label>
      {error && (
        <div className="text-[length:var(--text-caption1)] text-[var(--system-red)] whitespace-pre-wrap">{error}</div>
      )}
      <div className="flex items-center gap-[var(--space-2)]">
        <button
          onClick={submit}
          disabled={submitting}
          className="px-4 py-2 rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-footnote)] font-semibold"
          style={{ background: "var(--accent)", color: "var(--accent-contrast)", opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? "作成中…" : "作成する"}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-footnote)] bg-[var(--fill-secondary)] text-[var(--text-primary)]"
        >
          キャンセル
        </button>
      </div>
    </div>
  )
}

function CreatePanel({ onCreated, onClose, initialTemplateId }: {
  onCreated: () => void
  onClose: () => void
  initialTemplateId?: string | null
}) {
  const [templates, setTemplates] = useState<AutomationTemplateSpec[] | null>(null)
  const [selected, setSelected] = useState<AutomationTemplateSpec | null>(null)

  useEffect(() => {
    api.getAutomationTemplates()
      .then((result) => {
        setTemplates(result.templates)
        if (initialTemplateId) {
          const preset = result.templates.find((template) => template.id === initialTemplateId)
          if (preset) setSelected(preset)
        }
      })
      .catch(() => setTemplates([]))
  }, [initialTemplateId])

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-4)] mb-[var(--space-3)]">
      <div className="flex items-center justify-between mb-[var(--space-3)]">
        <span className="text-[length:var(--text-subheadline)] font-semibold text-[var(--text-primary)]">
          {selected ? `新規作成 — ${selected.name}` : "新規作成 — 型を選ぶ"}
        </span>
        <button
          onClick={onClose}
          aria-label="作成パネルを閉じる"
          className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer"
        >
          ✕
        </button>
      </div>
      {!templates ? (
        <Skeleton className="h-24 rounded-[var(--radius-sm)]" />
      ) : selected ? (
        <TemplateForm template={selected} onCreated={onCreated} onCancel={() => setSelected(null)} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-[var(--space-3)]">
          {templates.map((template) => (
            <button
              key={template.id}
              onClick={() => setSelected(template)}
              className="text-left rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg-secondary)] p-[var(--space-3)] cursor-pointer transition-[border-color] duration-150 hover:border-[var(--accent)]"
            >
              <div className="text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">{template.name}</div>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] mt-1 leading-relaxed">
                こういう時: {template.when}
              </div>
              <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-2">{template.flow}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export interface WorkflowCounts {
  total: number
  enabled: number
  disabled: number
  engineEnabled: boolean
}

async function fetchAllWorkflows(): Promise<WorkflowSummary[]> {
  const items: WorkflowSummary[] = []
  let cursor: string | undefined
  do {
    const page = await api.getWorkflows(cursor)
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

export function WorkflowsSection({ creating, initialTemplateId, onCloseCreate, filter, onCountsChange }: {
  creating: boolean
  initialTemplateId?: string | null
  onCloseCreate: () => void
  filter: "all" | "enabled" | "disabled"
  onCountsChange?: (counts: WorkflowCounts) => void
}) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null)
  const [engineEnabled, setEngineEnabled] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [details, setDetails] = useState<Map<string, WorkflowDefinitionDetail>>(new Map())
  const [runsRefresh, setRunsRefresh] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(() => {
    // The capability endpoint answers 200 whether or not the engine is on, so
    // "engine disabled" and "the list request failed" stay distinguishable.
    api.getAutomationTemplates()
      .then(async ({ workflowsEnabled }) => {
        if (!workflowsEnabled) {
          setEngineEnabled(false)
          setWorkflows([])
          setLoadError(null)
          onCountsChange?.({ total: 0, enabled: 0, disabled: 0, engineEnabled: false })
          return
        }
        setEngineEnabled(true)
        try {
          const items = await fetchAllWorkflows()
          const live = items.filter((item) => !item.retiredAt)
          setWorkflows(live)
          setLoadError(null)
          onCountsChange?.({
            total: live.length,
            enabled: live.filter((item) => item.enabled).length,
            disabled: live.filter((item) => !item.enabled).length,
            engineEnabled: true,
          })
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [onCountsChange])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!expandedId || details.has(expandedId)) return
    api.getWorkflow(expandedId)
      .then((detail) => setDetails((prev) => new Map(prev).set(expandedId, detail)))
      .catch(() => { /* row simply shows runs without the flow strip */ })
  }, [expandedId, details])

  const toggle = (workflow: WorkflowSummary) => {
    api.setWorkflowEnabled(workflow.id, !workflow.enabled, workflow.revision)
      .then(() => refresh())
      .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
  }

  const runNow = (workflow: WorkflowSummary) => {
    setNotice(null)
    api.startWorkflowRun(workflow.id)
      .then(() => { setNotice(`${workflow.id} の実行を開始しました`); setRunsRefresh((n) => n + 1) })
      .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
  }

  if (loadError) {
    return (
      <div className="bg-[rgba(255,69,58,0.06)] border border-[var(--system-red)] rounded-[var(--radius-md)] p-[var(--space-4)] text-[var(--system-red)] text-[length:var(--text-footnote)] mb-[var(--space-4)]">
        ワークフロー一覧を取得できませんでした: {loadError}
        <button
          onClick={refresh}
          className="ml-[var(--space-3)] underline bg-none border-none text-inherit cursor-pointer text-[length:inherit]"
        >
          再試行
        </button>
      </div>
    )
  }

  if (!engineEnabled) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-4)] mb-[var(--space-4)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        <span className="font-semibold text-[var(--text-primary)]">ワークフロー</span> — AI を呼ぶ前に安い判定を挟める自動化です。
        利用するには <code className="px-1.5 py-px rounded bg-[var(--fill-tertiary)] text-[var(--text-primary)]">config.yaml</code> に
        <code className="px-1.5 py-px rounded bg-[var(--fill-tertiary)] text-[var(--text-primary)] ml-1">workflows: {"{ enabled: true }"}</code>
        を追記してゲートウェイを再起動してください。
      </div>
    )
  }

  return (
    <div className="mb-[var(--space-4)]">
      {creating && <CreatePanel initialTemplateId={initialTemplateId} onCreated={() => { onCloseCreate(); refresh() }} onClose={onCloseCreate} />}
      {notice && (
        <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] mb-[var(--space-2)]">{notice}</div>
      )}
      {workflows === null ? (
        <Skeleton className="h-12 rounded-[var(--radius-sm)] mb-[var(--space-3)]" />
      ) : (() => {
        const visible = workflows.filter((item) =>
          filter === "all" ? true : filter === "enabled" ? item.enabled : !item.enabled)
        return visible.length === 0 ? null : (
        <div>
          <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
            <span className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
              ワークフロー
            </span>
            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
              {visible.length} 件 ・ 判定を挟んで必要な時だけ AI が動きます
            </span>
          </div>
          <div className="rounded-[var(--radius-md)] overflow-hidden bg-[var(--material-regular)] border border-[var(--separator)]">
            {visible.map((workflow, index) => {
              const isExpanded = expandedId === workflow.id
              const detail = details.get(workflow.id)
              return (
                <div key={workflow.id}>
                  {index > 0 && <div className="h-px bg-[var(--separator)] mx-[var(--space-4)]" />}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => setExpandedId(isExpanded ? null : workflow.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        setExpandedId(isExpanded ? null : workflow.id)
                      }
                    }}
                    className="flex items-center cursor-pointer min-h-[48px] px-[var(--space-4)] transition-[background] duration-150 ease-in-out"
                    style={{ borderLeft: `3px solid ${workflow.enabled ? "var(--system-green)" : "transparent"}` }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--fill-secondary)" }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "" }}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: workflow.enabled ? "var(--system-green)" : "var(--text-tertiary)" }}
                    />
                    <div className="min-w-0 flex-1 ml-3 flex flex-col">
                      <span className="truncate text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">
                        {workflow.title}
                      </span>
                      {workflow.description && (
                        <span className="truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                          {workflow.description}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center shrink-0 gap-[var(--space-2)] ml-auto">
                      <span className="text-[length:var(--text-caption1)] px-2 py-px rounded-xl bg-[color-mix(in_srgb,var(--system-purple)_14%,transparent)] text-[var(--system-purple)]">
                        workflow
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggle(workflow) }}
                        aria-label={workflow.enabled ? "無効にする" : "有効にする"}
                        className="relative inline-flex items-center w-9 h-5 rounded-[10px] border-none cursor-pointer shrink-0 transition-[background] duration-200 ease-in-out"
                        style={{ background: workflow.enabled ? "var(--system-green)" : "var(--fill-tertiary)" }}
                      >
                        <span
                          className="absolute w-4 h-4 rounded-full bg-white transition-[left] duration-200 ease-in-out"
                          style={{ left: workflow.enabled ? 18 : 2 }}
                        />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-[var(--space-4)] pb-[var(--space-3)] pt-1 flex flex-col gap-[var(--space-3)] bg-[var(--fill-quaternary)]">
                      {detail && <NodeFlow detail={detail} />}
                      <WorkflowRuns workflowId={workflow.id} refreshKey={runsRefresh} />
                      {workflow.enabled && detail?.nodes.some((node) => node.type === "trigger" && (node.config as { kind?: string }).kind === "manual") && (
                        <div>
                          <button
                            onClick={(e) => { e.stopPropagation(); runNow(workflow) }}
                            className="px-3 py-1.5 rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-caption1)] font-semibold bg-[var(--fill-secondary)] text-[var(--text-primary)]"
                          >
                            ▶ 今すぐ実行
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )})()}
    </div>
  )
}
