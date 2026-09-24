"use client"

import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import {
  CUSTOM_MODEL_VALUE,
  isCatalogModel,
  modelsForEngine,
  type SupportedModelEngine,
} from "@/lib/model-catalog"

interface ModelSelectorProps {
  id: string
  engine: SupportedModelEngine
  model: string | undefined
  onChange: (model: string | undefined) => void
  allowAutomatic?: boolean
}

const controlClassName =
  "w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"

/**
 * Curated model picker with an explicit free-form escape hatch.
 * Unknown values loaded from config automatically reopen in custom mode.
 */
export function ModelSelector({
  id,
  engine,
  model,
  onChange,
  allowAutomatic = false,
}: ModelSelectorProps) {
  const [catalog, setCatalog] = useState<{ engine: string; models: Array<{ value: string; label: string }> } | null>(null)
  const discovered = catalog?.engine === engine ? catalog.models : []
  useEffect(() => {
    let active = true
    api.getModels().then(status => {
      if (active) setCatalog({ engine, models: status.engines.find(e => e.engine === engine)?.models.map(m => ({ value: m.id, label: m.label })) ?? [] })
    }).catch(() => {})
    return () => { active = false }
  }, [engine])
  const options = [...new Map([...modelsForEngine(engine), ...discovered].map(m => [m.value, m])).values()]
  const knownModel = options.some(m => m.value === model)
  const [customMode, setCustomMode] = useState(Boolean(model && !knownModel))
  const [customDraft, setCustomDraft] = useState(model && !knownModel ? model : "")
  const customInputRef = useRef<HTMLInputElement>(null)
  const suppressBlurCommitRef = useRef(false)
  const helpId = `${id}-help`
  const customInputId = `${id}-custom`
  const customPlaceholder =
    engine === "claude"
      ? "例: claude-sonnet-5-20260801"
      : engine === "gemini"
        ? "例: gemini-3.1-pro-preview"
        : "例: gpt-private-preview"

  useEffect(() => {
    const isCustom = Boolean(model && !isCatalogModel(engine, model) && !discovered.some(m => m.value === model))
    setCustomMode(isCustom)
    setCustomDraft(isCustom ? model ?? "" : "")
  }, [engine, model])

  useEffect(() => {
    if (customMode) customInputRef.current?.focus()
  }, [customMode])

  function commitCustomModel() {
    if (suppressBlurCommitRef.current) {
      suppressBlurCommitRef.current = false
      return
    }
    const nextModel = customDraft.trim()
    if (!nextModel) {
      const existingIsCustom = Boolean(model && !knownModel)
      setCustomDraft(existingIsCustom ? model ?? "" : "")
      setCustomMode(existingIsCustom)
      return
    }
    onChange(nextModel)
  }

  const showCustom = customMode && (!knownModel || customDraft !== model)
  const selectValue = showCustom
    ? CUSTOM_MODEL_VALUE
    : model && knownModel
      ? model
      : ""

  return (
    <div className="space-y-[var(--space-2)]">
      <select
        id={id}
        value={selectValue}
        aria-describedby={helpId}
        onChange={(event) => {
          const value = event.target.value
          if (value === CUSTOM_MODEL_VALUE) {
            setCustomDraft(model && !knownModel ? model : "")
            setCustomMode(true)
            return
          }
          setCustomMode(false)
          onChange(value || undefined)
        }}
        className={`${controlClassName} cursor-pointer`}
      >
        {allowAutomatic && <option value="">自動（ベンダー既定）</option>}
        {!allowAutomatic && !model && <option value="">モデルを選択</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={CUSTOM_MODEL_VALUE}>カスタムモデルIDを入力…</option>
      </select>

      {showCustom && (
        <input
          ref={customInputRef}
          id={customInputId}
          type="text"
          value={customDraft}
          onChange={(event) => setCustomDraft(event.target.value)}
          onBlur={commitCustomModel}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
            if (event.key === "Escape") {
              event.preventDefault()
              suppressBlurCommitRef.current = true
              setCustomDraft(model && !knownModel ? model : "")
              setCustomMode(Boolean(model && !knownModel))
              event.currentTarget.blur()
              queueMicrotask(() => {
                suppressBlurCommitRef.current = false
              })
            }
          }}
          placeholder={customPlaceholder}
          aria-label="カスタムモデルID"
          aria-describedby={helpId}
          autoComplete="off"
          className={controlClassName}
        />
      )}

      <p
        id={helpId}
        className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
      >
        一覧にないモデルは「カスタムモデルID」を選び、入力後に確定できます。
        {engine === "codex" && ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].includes(model ?? "") && (
          <> GPT-6 の利用には、対応する Codex CLI とアカウントのアクセス権が必要です。</>
        )}
        {engine === "claude" && model === "claude-fable-5-1" && (
          <> Fable 5.1 の利用には、Claude Code 2.1.255 以降とアカウントのアクセス権が必要です。</>
        )}
      </p>
    </div>
  )
}
