"use client"
import React from "react"

interface SttDownloadModalProps {
  open: boolean
  progress: number | null
  onDownload: () => void
  onCancel: () => void
}

export function SttDownloadModal({ open, progress, onDownload, onCancel }: SttDownloadModalProps) {
  if (!open) return null

  const isDownloading = progress !== null

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center"
      onClick={isDownloading ? undefined : onCancel}
    >
      <div
        className="bg-[var(--bg)] rounded-[var(--radius-lg)] p-[var(--space-6)] max-w-[400px] w-[90%] shadow-[var(--shadow-overlay)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-12 h-12 rounded-[var(--radius-md)] bg-[var(--fill-secondary)] flex items-center justify-center mb-[var(--space-4)]">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </div>

        <h3 className="text-[length:var(--text-headline)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-2)]">
          Enable voice input?
        </h3>

        <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] mb-[var(--space-5)] leading-[var(--leading-relaxed)]">
          This will download a speech recognition model (~500MB). Transcription runs locally on your server — no data leaves your network.
        </p>

        {isDownloading && (
          <div className="mb-[var(--space-5)]">
            <div className="flex justify-between mb-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              <span>Downloading model…</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 rounded-[3px] bg-[var(--fill-tertiary)] overflow-hidden">
              <div
                className="h-full rounded-[3px] bg-[var(--accent)] transition-[width] duration-300 ease-in-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-[var(--space-3)] justify-end">
          {!isDownloading && (
            <button
              onClick={onCancel}
              className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-primary)] border-none cursor-pointer text-[length:var(--text-body)]"
            >
              Cancel
            </button>
          )}
          <button
            onClick={onDownload}
            disabled={isDownloading}
            className={`px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] border-none text-[length:var(--text-body)] font-[var(--weight-semibold)] ${
              isDownloading
                ? "bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] cursor-default"
                : "bg-[var(--accent)] text-black cursor-pointer"
            }`}
          >
            {isDownloading ? "Downloading…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  )
}
