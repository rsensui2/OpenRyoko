"use client"

import { useEffect, useState } from "react"
import { BellRing, ExternalLink, X } from "lucide-react"
import { api, type UpdateStatusResponse } from "@/lib/api"

const DISMISS_KEY_PREFIX = "openryoko-update-dismissed:"

export function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getUpdateStatus().then((next) => {
      if (cancelled) return
      setStatus(next)
      if (next.latestVersion) {
        setDismissed(localStorage.getItem(`${DISMISS_KEY_PREFIX}${next.latestVersion}`) === "1")
      }
    }).catch(() => {
      // Update availability is supplementary; gateway status remains the
      // authoritative dashboard health signal.
    })
    return () => { cancelled = true }
  }, [])

  if (!status?.updateAvailable || !status.latestVersion || !status.releaseUrl || dismissed) {
    return null
  }

  function dismiss() {
    if (!status?.latestVersion) return
    localStorage.setItem(`${DISMISS_KEY_PREFIX}${status.latestVersion}`, "1")
    setDismissed(true)
  }

  return (
    <aside
      role="status"
      aria-live="polite"
      className="mb-[var(--space-5)] rounded-[var(--radius-md)] border px-[var(--space-4)] py-[var(--space-3)]"
      style={{
        background: "color-mix(in srgb, var(--system-blue) 10%, var(--material-regular))",
        borderColor: "color-mix(in srgb, var(--system-blue) 30%, var(--separator))",
      }}
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--system-blue)]"
          style={{ background: "color-mix(in srgb, var(--system-blue) 14%, transparent)" }}
        >
          <BellRing size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-1">
            <h3 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              OpenRyoko {status.latestVersion} が利用できます
            </h3>
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              現在 {status.currentVersion}
            </span>
          </div>
          <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            更新するには <code className="select-all rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5">ryoko update --restart</code> を実行してください。
          </p>
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--system-blue)] hover:underline"
          >
            何ができるようになったかを見る
            <ExternalLink size={13} aria-hidden="true" />
          </a>
          {status.stale && (
            <span className="ml-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
              前回の確認結果
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={`OpenRyoko ${status.latestVersion} の更新通知を閉じる`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)]"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </aside>
  )
}
