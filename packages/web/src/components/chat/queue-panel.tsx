"use client"

import { useEffect, useState, useCallback } from 'react'
import { X, Pause, Play, Trash2 } from 'lucide-react'
import { api, type QueueItem } from '@/lib/api'

interface QueuePanelProps {
  sessionId: string | null
  events: Array<{ event: string; payload: unknown }>
  paused?: boolean
}

export function QueuePanel({ sessionId, events, paused: initialPaused = false }: QueuePanelProps) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [paused, setPaused] = useState(initialPaused)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      const data = await api.getSessionQueue(sessionId)
      setItems(data)
    } catch {
      // non-fatal
    }
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])

  // Refresh on queue:updated WS event
  useEffect(() => {
    if (!events.length) return
    const latest = events[events.length - 1]
    if (latest.event === 'queue:updated') {
      refresh()
      const payload = latest.payload as Record<string, unknown>
      if (typeof payload?.paused === 'boolean') {
        setPaused(payload.paused as boolean)
      }
    }
  }, [events, refresh])

  const pendingItems = items.filter(i => i.status === 'pending')

  if (!sessionId || pendingItems.length === 0) return null

  async function handleCancel(itemId: string) {
    if (!sessionId) return
    try {
      await api.cancelQueueItem(sessionId, itemId)
      await refresh()
    } catch { /* non-fatal */ }
  }

  async function handleClear() {
    if (!sessionId) return
    try {
      await api.clearSessionQueue(sessionId)
      setItems([])
    } catch { /* non-fatal */ }
  }

  async function handlePauseResume() {
    if (!sessionId) return
    try {
      if (paused) {
        await api.resumeSessionQueue(sessionId)
        setPaused(false)
      } else {
        await api.pauseSessionQueue(sessionId)
        setPaused(true)
      }
    } catch { /* non-fatal */ }
  }

  return (
    <div className="border-t border-[var(--separator)] px-[var(--space-4)] py-[var(--space-2)] bg-[var(--fill-quaternary)] shrink-0">
      <div className="flex items-center justify-between mb-[var(--space-1)]">
        <span className="text-[length:var(--text-caption2)] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.5px]">
          {pendingItems.length} queued {paused && '· Paused'}
        </span>
        <div className="flex gap-[var(--space-1)]">
          <button
            onClick={handlePauseResume}
            title={paused ? 'Resume queue' : 'Pause queue'}
            className="bg-transparent border-none cursor-pointer text-[var(--text-secondary)] p-0.5 flex items-center"
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button
            onClick={handleClear}
            title="Clear all queued messages"
            className="bg-transparent border-none cursor-pointer text-[var(--text-secondary)] p-0.5 flex items-center"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {pendingItems.map((item) => (
          <div key={item.id} className="flex items-center gap-[var(--space-2)] px-[var(--space-2)] py-[3px] rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)]">
            <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] min-w-4">
              {item.position}.
            </span>
            <span className="flex-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)] overflow-hidden text-ellipsis whitespace-nowrap">
              {item.prompt.length > 60 ? item.prompt.slice(0, 57) + '...' : item.prompt}
            </span>
            <button
              onClick={() => handleCancel(item.id)}
              title="Cancel this message"
              className="bg-transparent border-none cursor-pointer text-[var(--text-tertiary)] p-px flex items-center shrink-0"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
