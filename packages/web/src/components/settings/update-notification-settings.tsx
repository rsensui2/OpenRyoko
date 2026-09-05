"use client"

import { useCallback, useEffect, useState } from "react"
import { BellRing, Loader2, Play, Save } from "lucide-react"
import { api } from "@/lib/api"

const UPDATE_JOB_ID = "openryoko-update-notification"

interface UpdateNotificationJob {
  id: string
  name: string
  enabled: boolean
  schedule: string
  kind?: string
  timezone?: string
  delivery?: { connector?: string; channel?: string }
}

interface Draft {
  enabled: boolean
  schedule: string
  timezone: string
  connector: string
  channel: string
}

export function UpdateNotificationSettings({
  connectorOptions,
  defaultConnector,
  defaultChannel,
}: {
  connectorOptions: string[]
  defaultConnector?: string
  defaultChannel?: string
}) {
  const [job, setJob] = useState<UpdateNotificationJob | null>(null)
  const [draft, setDraft] = useState<Draft>({
    enabled: false,
    schedule: "0 9 * * *",
    timezone: "",
    connector: defaultConnector ?? "",
    channel: defaultChannel ?? "",
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.getCronJobs().then((jobs) => {
      const found = jobs.find((candidate) =>
        candidate.id === UPDATE_JOB_ID || candidate.kind === "update-notification"
      ) as unknown as UpdateNotificationJob | undefined
      if (found) {
        setJob(found)
        setDraft({
          enabled: found.enabled,
          schedule: found.schedule || "0 9 * * *",
          timezone: found.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          connector: found.delivery?.connector || defaultConnector || "",
          channel: found.delivery?.channel || defaultChannel || "",
        })
      } else {
        setDraft((current) => ({
          ...current,
          timezone: current.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
          connector: current.connector || defaultConnector || "",
          channel: current.channel || defaultChannel || "",
        }))
      }
    }).catch((error) => {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : "通知設定を取得できませんでした" })
    }).finally(() => setLoading(false))
  }, [defaultChannel, defaultConnector])

  useEffect(() => { load() }, [load])

  const options = Array.from(new Set([
    ...connectorOptions,
    ...(draft.connector ? [draft.connector] : []),
  ]))

  async function save() {
    setFeedback(null)
    if (draft.schedule.trim().split(/\s+/).length !== 5) {
      setFeedback({ type: "error", message: "Cron式は「分 時 日 月 曜日」の5項目で入力してください" })
      return
    }
    if (draft.enabled && (!draft.connector.trim() || !draft.channel.trim())) {
      setFeedback({ type: "error", message: "通知を有効にするにはコネクタと送信先が必要です" })
      return
    }

    setSaving(true)
    const payload = {
      id: job?.id || UPDATE_JOB_ID,
      name: "OpenRyoko Update Notification",
      kind: "update-notification",
      enabled: draft.enabled,
      schedule: draft.schedule.trim(),
      timezone: draft.timezone.trim() || undefined,
      prompt: "",
      delivery: draft.connector.trim() && draft.channel.trim()
        ? { connector: draft.connector.trim(), channel: draft.channel.trim() }
        : undefined,
    }
    try {
      const saved = job
        ? await api.updateCronJob(job.id, payload)
        : await api.createCronJob(payload)
      setJob(saved as unknown as UpdateNotificationJob)
      setFeedback({
        type: "success",
        message: draft.enabled
          ? "更新通知を保存しました。新しいリリースが見つかった時だけAIがチャットへ知らせます。"
          : "更新通知を無効で保存しました。",
      })
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : "保存に失敗しました" })
    } finally {
      setSaving(false)
    }
  }

  async function trigger() {
    if (!job) return
    setTriggering(true)
    setFeedback(null)
    try {
      await api.triggerCronJob(job.id)
      setFeedback({
        type: "success",
        message: "更新確認を開始しました。新しい未通知バージョンがある場合だけチャットへ届きます。",
      })
    } catch (error) {
      setFeedback({ type: "error", message: error instanceof Error ? error.message : "更新確認を開始できませんでした" })
    } finally {
      setTriggering(false)
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 py-3 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"><Loader2 size={14} className="animate-spin" />更新通知設定を読み込み中…</div>
  }

  return (
    <div className="mt-[var(--space-4)] border-t border-[var(--separator)] pt-[var(--space-4)]">
      <div className="mb-[var(--space-3)] flex items-start gap-[var(--space-3)]">
        <BellRing size={18} className="mt-0.5 shrink-0 text-[var(--system-blue)]" aria-hidden="true" />
        <div>
          <div className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            AIによるアップデート通知
          </div>
          <p className="mt-1 text-[length:var(--text-caption2)] leading-relaxed text-[var(--text-tertiary)]">
            定期確認はAIを使わず、新しいバージョンを見つけた時だけAIが通知文を作成します。同じバージョンは一度だけ送信されます。
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 py-2">
        <label htmlFor="update-notification-enabled" className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">チャット通知</label>
        <button
          id="update-notification-enabled"
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
          className="relative h-6 w-11 shrink-0 rounded-full border-none transition-colors"
          style={{ background: draft.enabled ? "var(--system-green)" : "var(--fill-primary)" }}
        >
          <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left]" style={{ left: draft.enabled ? 22 : 2 }} />
        </button>
      </div>

      <div className="grid gap-[var(--space-3)] pt-2 sm:grid-cols-2">
        <label className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Cron式
          <input
            value={draft.schedule}
            onChange={(event) => setDraft((current) => ({ ...current, schedule: event.target.value }))}
            placeholder="0 9 * * *"
            className="apple-input mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-[10px] py-[6px] font-mono text-[length:var(--text-footnote)] text-[var(--text-primary)]"
          />
        </label>
        <label className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          タイムゾーン
          <input
            value={draft.timezone}
            onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))}
            placeholder="Asia/Tokyo"
            className="apple-input mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
          />
        </label>
        <label className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          コネクタ
          <select
            value={draft.connector}
            onChange={(event) => setDraft((current) => ({ ...current, connector: event.target.value }))}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
          >
            <option value="">選択してください</option>
            {options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          送信先
          <input
            value={draft.channel}
            onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value }))}
            placeholder="#general またはチャンネルID"
            className="apple-input mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
          />
        </label>
      </div>

      {feedback && (
        <p className={`mt-3 text-[length:var(--text-caption1)] ${feedback.type === "success" ? "text-[var(--system-green)]" : "text-[var(--system-red)]"}`} role={feedback.type === "error" ? "alert" : "status"}>
          {feedback.message}
        </p>
      )}

      <div className="mt-[var(--space-3)] flex flex-wrap justify-end gap-[var(--space-2)]">
        {job && (
          <button
            type="button"
            onClick={trigger}
            disabled={triggering || saving}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--fill-tertiary)] px-3 py-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] disabled:opacity-60"
          >
            {triggering ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            今すぐ確認
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving || triggering}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border-none bg-[var(--accent)] px-3 py-1.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:opacity-60"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          通知設定を保存
        </button>
      </div>
    </div>
  )
}
