"use client"

/**
 * Who a Ryoko is: name and emoji, personality (start from a template or write
 * it), which AI runs it, and whether it shares the main Ryoko's memory or keeps
 * its own. Used to create a Ryoko and to edit one.
 */

import { useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { RyokoInput, RyokoMemoryMode } from "@/lib/api"

export const PERSONA_TEMPLATES: Array<{ label: string; text: (name: string) => string }> = [
  { label: "秘書", text: (name) => `あなたは ${name}。チームの秘書として、丁寧で落ち着いた言葉づかいで話します。頼まれたことは先回りして準備し、抜けや期限を気にかけます。` },
  { label: "エンジニア", text: (name) => `あなたは ${name}。ソフトウェアエンジニアとして、簡潔に、根拠と手順を添えて答えます。コードや設定は動くことを確かめてから渡します。` },
  { label: "営業アシスタント", text: (name) => `あなたは ${name}。営業チームのアシスタントとして、明るく前向きに話します。顧客とのやりとりの下書き、資料づくり、次の一手の提案が得意です。` },
  { label: "リサーチャー", text: (name) => `あなたは ${name}。調査担当として、出典を確かめ、事実と推測を分けて伝えます。結論を先に、根拠をあとに書きます。` },
  { label: "サポート窓口", text: (name) => `あなたは ${name}。お問い合わせ窓口として、親切で分かりやすい言葉で答えます。分からないことは推測で答えず、担当者につなぎます。` },
]

const MEMORY_CHOICES: Array<{ value: RyokoMemoryMode; title: string; hint: string }> = [
  {
    value: "shared",
    title: "メインの Ryoko と記憶を共有する",
    hint: "これまでに覚えたこと（好み・決めごと・知識）をそのまま使えます。同じチームの中で役割を分けるときに向いています。",
  },
  {
    value: "own",
    title: "この Ryoko 専用の記憶を持つ",
    hint: "メインの Ryoko の記憶は見えず、この Ryoko が覚えたことも他と混ざりません。別のチームや取引先に置くときに向いています。",
  },
]

const inputClass = "apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <span className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{label}</span>
      {hint ? <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{hint}</span> : null}
      {children}
    </div>
  )
}

export function RyokoForm({ initial, submitLabel, busy, onSubmit }: {
  initial?: Partial<RyokoInput>
  submitLabel: string
  busy?: boolean
  onSubmit: (input: RyokoInput) => void
}) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "")
  const [emoji, setEmoji] = useState(initial?.emoji ?? "🤖")
  const [persona, setPersona] = useState(initial?.persona ?? "")
  const [engine, setEngine] = useState<"claude" | "codex">(initial?.engine ?? "claude")
  const [memory, setMemory] = useState<RyokoMemoryMode>(initial?.memory ?? "shared")
  const name = displayName.trim()
  const valid = name.length > 0 && name.length <= 40 && persona.trim().length > 0 && persona.length <= 4000

  return (
    <form
      className="flex flex-col gap-[var(--space-5)]"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit({ displayName: name, emoji: emoji.trim() || undefined, persona: persona.trim(), engine, memory, model: initial?.model })
      }}
    >
      <Field label="名前とアイコン" hint="Slack やチャットで表示される名前です。">
        <div className="flex gap-[var(--space-2)]">
          <input aria-label="アイコンの絵文字" value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)}
            className="apple-input w-16 shrink-0 bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-2 py-2 text-center text-[length:var(--text-title3)]" />
          <input aria-label="名前" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} placeholder="例: 営業の Ryoko" className={inputClass} />
        </div>
      </Field>

      <Field label="人格" hint="話し方・役割・得意なことを書きます。ひな形から選んで直すのが早いです。">
        <div className="flex flex-wrap gap-1.5">
          {PERSONA_TEMPLATES.map((template) => (
            <button key={template.label} type="button" onClick={() => setPersona(template.text(name || "この Ryoko"))}
              className="px-2.5 py-1 rounded-full border border-[var(--separator)] bg-transparent cursor-pointer text-[length:var(--text-caption1)] text-[var(--text-primary)]">
              {template.label}
            </button>
          ))}
        </div>
        <textarea aria-label="人格" value={persona} onChange={(e) => setPersona(e.target.value)} rows={5} maxLength={4000}
          placeholder="例: あなたは〇〇。経理チームのアシスタントとして…" className={`${inputClass} resize-y leading-[var(--leading-relaxed)]`} />
      </Field>

      <Field label="動かす AI">
        <div className="flex gap-[var(--space-4)] text-[length:var(--text-subheadline)]">
          {(["claude", "codex"] as const).map((value) => (
            <label key={value} className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={engine === value} onChange={() => setEngine(value)} />
              {value === "claude" ? "Claude" : "Codex"}
            </label>
          ))}
        </div>
      </Field>

      <Field label="記憶">
        <div className="flex flex-col gap-[var(--space-2)]">
          {MEMORY_CHOICES.map((choice) => {
            const on = memory === choice.value
            return (
              <label key={choice.value} className="flex items-start gap-[var(--space-2)] p-[var(--space-3)] rounded-[var(--radius-md)] border cursor-pointer"
                style={{ borderColor: on ? "var(--accent)" : "var(--separator)", background: on ? "var(--accent-fill)" : "transparent" }}>
                <input type="radio" checked={on} onChange={() => setMemory(choice.value)} className="mt-1" />
                <span className="flex flex-col">
                  <span className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{choice.title}</span>
                  <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">{choice.hint}</span>
                </span>
              </label>
            )
          })}
          <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            どちらでも、記憶を使うのはウェブのチャットと、信頼する人として登録した人の DM だけです（この登録はすべての Ryoko に共通です）。チャンネルでの会話には記憶を持ち込みません。あとから切り替えても、専用の記憶は消えません。
            専用の記憶は AI への指示で分けています。同じ PC の上で動くので、ファイルの読み取りまで仕組みで止めるものではありません。完全に分けたいときは、OpenRyoko を別に立ててください。
          </span>
        </div>
      </Field>

      <div>
        <button type="submit" disabled={!valid || busy}
          className="inline-flex items-center gap-1.5 px-5 py-2 rounded-[var(--radius-md)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]"
          style={{ background: !valid || busy ? "var(--fill-tertiary)" : "var(--accent)", color: !valid || busy ? "var(--text-tertiary)" : "var(--accent-contrast)" }}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
