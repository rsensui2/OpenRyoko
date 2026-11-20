"use client"

/**
 * The pieces the guided Slack setup is drawn with: a numbered step card and a
 * screenshot of the Slack screen the person is about to see, enlargeable.
 * Screenshots live in /public/guide/slack (workspace names replaced).
 */

import { useEffect, useState, type ReactNode } from "react"
import { Check, X, ZoomIn } from "lucide-react"

export type StepState = "todo" | "active" | "done"

export function GuideStep({ n, title, state, summary, children }: {
  n: number
  title: string
  state: StepState
  /** One line shown once the step is done (e.g. what was made). */
  summary?: ReactNode
  children?: ReactNode
}) {
  const active = state === "active"
  return (
    <section
      className="rounded-[var(--radius-md)] border p-[var(--space-4)] flex flex-col gap-[var(--space-3)]"
      style={{
        borderColor: active ? "var(--accent)" : "var(--separator)",
        background: active ? "var(--material-regular)" : "var(--fill-quaternary)",
        opacity: state === "todo" ? 0.55 : 1,
      }}
      aria-current={active ? "step" : undefined}
    >
      <div className="flex items-center gap-[var(--space-2)]">
        <span
          className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[length:var(--text-caption1)] font-[var(--weight-bold)] shrink-0"
          style={{
            background: state === "done" ? "var(--system-green)" : active ? "var(--accent)" : "var(--fill-tertiary)",
            color: state === "todo" ? "var(--text-tertiary)" : "var(--accent-contrast)",
          }}
        >
          {state === "done" ? <Check size={14} /> : n}
        </span>
        <h3 className="m-0 text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</h3>
      </div>
      {state === "done" && summary ? <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] pl-8">{summary}</div> : null}
      {active ? <div className="flex flex-col gap-[var(--space-3)]">{children}</div> : null}
    </section>
  )
}

export function GuideShot({ src, alt, caption }: { src: string; alt: string; caption?: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <figure className="m-0 flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative p-0 border border-[var(--separator)] rounded-[var(--radius-sm)] overflow-hidden bg-white cursor-zoom-in"
        aria-label={`${alt}（拡大）`}
      >
        <img src={src} alt={alt} className="block w-full h-auto" loading="lazy" />
        <span className="absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/55 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
          <ZoomIn size={11} /> 拡大
        </span>
      </button>
      {caption ? <figcaption className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{caption}</figcaption> : null}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={alt} className="max-w-[min(1000px,100%)] max-h-full rounded-[var(--radius-md)] bg-white shadow-2xl" />
          <button type="button" aria-label="閉じる" className="absolute top-4 right-4 w-9 h-9 rounded-full border-none bg-white/90 cursor-pointer inline-flex items-center justify-center" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
      )}
    </figure>
  )
}

/** Numbered instructions whose numbers match the red badges in the screenshots. */
export function GuideList({ items }: { items: ReactNode[] }) {
  return (
    <ol className="m-0 p-0 list-none flex flex-col gap-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">
          <span className="w-[18px] h-[18px] mt-[2px] rounded-full bg-[#e53935] text-white text-[11px] font-bold inline-flex items-center justify-center shrink-0">{i + 1}</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}
