"use client"

/**
 * The bot's picture: a drawn initial on a chosen color, or the person's own
 * image (upload, paste or drop). Reports a ready-to-send 512px PNG data URL.
 */

import { useEffect, useState, type ClipboardEvent, type DragEvent } from "react"
import { Upload } from "lucide-react"
import { imageFileToSlackIcon, initialSlackIcon, SLACK_ICON_COLORS } from "@/lib/slack-icon"

export function SlackIconPicker({ name, onChange }: { name: string; onChange: (png: string | null) => void }) {
  const [color, setColor] = useState<string>(SLACK_ICON_COLORS[0])
  const [uploaded, setUploaded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    try {
      const png = uploaded ?? initialSlackIcon(name || "Ryoko", color)
      setError(null)
      setPreview(png)
      onChange(png)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      onChange(null)
    }
  }, [name, color, uploaded, onChange])

  const take = async (file: Blob | null | undefined) => {
    if (!file) return
    setError(null)
    try {
      setUploaded(await imageFileToSlackIcon(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); void take(event.dataTransfer.files?.[0]) }
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"))
    if (item) { event.preventDefault(); void take(item.getAsFile()) }
  }

  return (
    <div className="flex items-center gap-[var(--space-3)]" onDrop={onDrop} onDragOver={(e) => e.preventDefault()} onPaste={onPaste} tabIndex={0} aria-label="アイコン（画像の貼り付け・ドロップ可）">
      {preview
        ? <img src={preview} alt="" width={56} height={56} className="rounded-[14px] shrink-0" />
        : <div className="w-14 h-14 rounded-[14px] bg-[var(--fill-tertiary)] shrink-0" />}
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {SLACK_ICON_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={`背景色 ${swatch}`}
              onClick={() => { setUploaded(null); setColor(swatch) }}
              className="w-5 h-5 rounded-full border-none cursor-pointer"
              style={{ background: swatch, outline: !uploaded && color === swatch ? "2px solid var(--accent)" : "none", outlineOffset: 2 }}
            />
          ))}
          <label className="inline-flex items-center gap-1 ml-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)] cursor-pointer">
            <Upload size={13} /> 画像を選ぶ
            <input type="file" accept="image/*" className="hidden" onChange={(e) => void take(e.target.files?.[0])} />
          </label>
        </div>
        <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          {uploaded ? "アップロードした画像を使います" : "画像の貼り付け・ドロップもできます"}
        </span>
        {error && <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">{error}</span>}
      </div>
    </div>
  )
}
