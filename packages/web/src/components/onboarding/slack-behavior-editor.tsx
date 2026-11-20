"use client"

/**
 * "How should the bot behave in Slack?" as a few plain questions, a live
 * summary of what will happen, and per-channel exceptions. Saves through the
 * normal config endpoint (which reloads the connector) at the revision it read.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, Loader2, Plus, Trash2 } from "lucide-react"
import { api, ConfigConflictError } from "@/lib/api"
import {
  behaviorFromConfig, behaviorToConfigPatch, describeBehavior, usesMentions,
  type ChannelChoice, type GroupDmChoice, type RespondMode, type SlackBehavior, type SlackBehaviorConfig,
} from "@/lib/slack-behavior"

interface SlackChannel { id: string; name: string; isPrivate: boolean }

function Choice<T extends string>({ name, value, current, onPick, title, hint }: {
  name: string; value: T; current: T; onPick: (v: T) => void; title: string; hint?: ReactNode
}) {
  const on = value === current
  return (
    <label
      className="flex items-start gap-[var(--space-2)] p-[var(--space-3)] rounded-[var(--radius-md)] border cursor-pointer"
      style={{ borderColor: on ? "var(--accent)" : "var(--separator)", background: on ? "var(--accent-fill)" : "transparent" }}
    >
      <input type="radio" name={name} checked={on} onChange={() => onPick(value)} className="mt-1" />
      <span className="flex flex-col">
        <span className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</span>
        {hint ? <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">{hint}</span> : null}
      </span>
    </label>
  )
}

function Question({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[var(--space-2)]">
      <h3 className="m-0 text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</h3>
      {children}
    </section>
  )
}

const EXCEPTION_LABEL: Record<RespondMode, string> = {
  always: "すべてに返事",
  mention: "メンションだけ",
  never: "話さない",
}

function Exceptions({ behavior, channels, channelError, onChange }: {
  behavior: SlackBehavior
  channels: SlackChannel[] | null
  channelError: string | null
  onChange: (exceptions: Record<string, RespondMode>) => void
}) {
  const [adding, setAdding] = useState("")
  const nameOf = (id: string) => channels?.find((c) => c.id === id)?.name ?? id
  const unused = (channels ?? []).filter((c) => !(c.id in behavior.exceptions))
  const set = (id: string, value: RespondMode) => onChange({ ...behavior.exceptions, [id]: value })
  const remove = (id: string) => {
    const { [id]: _gone, ...rest } = behavior.exceptions
    onChange(rest)
  }

  return (
    <Question title="チャンネルごとの例外">
      <p className="m-0 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        専用チャンネルでは全部に返事、雑談チャンネルでは話さない、のようにチャンネルごとに変えられます。bot を招待済みのチャンネルから選べます。
      </p>
      {Object.entries(behavior.exceptions).map(([id, value]) => (
        <div key={id} className="flex items-center gap-[var(--space-2)]">
          <span className="flex-1 text-[length:var(--text-subheadline)] text-[var(--text-primary)]">#{nameOf(id)}</span>
          <select value={value} onChange={(e) => set(id, e.target.value as RespondMode)} aria-label={`#${nameOf(id)} の振る舞い`}
            className="bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--text-footnote)]">
            {(Object.keys(EXCEPTION_LABEL) as RespondMode[]).map((m) => <option key={m} value={m}>{EXCEPTION_LABEL[m]}</option>)}
          </select>
          <button type="button" onClick={() => remove(id)} aria-label={`#${nameOf(id)} の例外を外す`} className="bg-transparent border-none cursor-pointer text-[var(--text-tertiary)] p-1">
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {channels === null && !channelError && <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"><Loader2 size={12} className="animate-spin inline mr-1" />チャンネルを読み込み中…</div>}
      {channelError && <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{channelError}</div>}
      {unused.length > 0 && (
        <div className="flex items-center gap-[var(--space-2)]">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="例外を作るチャンネル"
            className="flex-1 bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[length:var(--text-footnote)]">
            <option value="">チャンネルを選ぶ…</option>
            {unused.map((c) => <option key={c.id} value={c.id}>{c.isPrivate ? "🔒 " : "#"}{c.name}</option>)}
          </select>
          <button type="button" disabled={!adding} onClick={() => { set(adding, "always"); setAdding("") }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-transparent cursor-pointer text-[length:var(--text-footnote)] text-[var(--text-primary)] disabled:opacity-50">
            <Plus size={14} /> 例外を追加
          </button>
        </div>
      )}
    </Question>
  )
}

export function SlackBehaviorEditor() {
  const [loaded, setLoaded] = useState<{ behavior: SlackBehavior; revision: string | null } | null>(null)
  const [behavior, setBehavior] = useState<SlackBehavior | null>(null)
  const [channels, setChannels] = useState<SlackChannel[] | null>(null)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = () => {
    api.getConfigWithRevision()
      .then(({ config, revision }) => {
        const slack = (config.connectors as { slack?: SlackBehaviorConfig } | undefined)?.slack
        const read = behaviorFromConfig(slack)
        setLoaded({ behavior: read, revision })
        setBehavior(read)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }
  useEffect(load, [])
  useEffect(() => {
    fetch("/api/connectors/slack/channels")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.ok && Array.isArray(body.channels)) setChannels(body.channels)
        else setChannelError(body.error === "slack_not_configured"
          ? "Slack がまだつながっていないので、チャンネルを選べません。先に Slack につないでください。"
          : "チャンネル一覧を読めませんでした。")
      })
      .catch(() => setChannelError("チャンネル一覧を読めませんでした。"))
  }, [])

  const nameOf = useMemo(() => (id: string) => channels?.find((c) => c.id === id)?.name ?? id, [channels])

  if (loadError) return <div className="text-[length:var(--text-footnote)] text-[var(--system-red)]">設定を読めませんでした: {loadError}</div>
  if (!behavior || !loaded) return <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]"><Loader2 size={14} className="animate-spin inline mr-1" />読み込み中…</div>

  const update = (patch: Partial<SlackBehavior>) => { setMessage(null); setBehavior({ ...behavior, ...patch }) }
  const dirty = JSON.stringify(behavior) !== JSON.stringify(loaded.behavior)

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const patch = behaviorToConfigPatch(behavior, loaded.behavior)
      const { revision } = await api.updateConfigAtRevision({ connectors: { slack: patch } }, loaded.revision)
      setLoaded({ behavior, revision })
      setMessage({ ok: true, text: "保存しました。Slack の接続を読み込み直したので、もう反映されています。" })
    } catch (err) {
      setMessage(err instanceof ConfigConflictError
        ? { ok: false, text: "ほかの画面で設定が変わっていました。読み込み直したので、もう一度選んで保存してください。" }
        : { ok: false, text: err instanceof Error ? err.message : String(err) })
      if (err instanceof ConfigConflictError) load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-5)]">
      <Question title="1対1の DM では？">
        <Choice name="dm" value="always" current={behavior.dm} onPick={(dm) => update({ dm })} title="いつも返事する" />
        <Choice name="dm" value="never" current={behavior.dm} onPick={(dm) => update({ dm })} title="返事しない" />
      </Question>

      <Question title="チャンネルでは、どんなときに話す？">
        <Choice<ChannelChoice> name="channel" value="mention" current={behavior.channel} onPick={(channel) => update({ channel })}
          title="@メンションされたときだけ" hint="呼ばれない限り黙っています。いちばん静かです。" />
        <Choice<ChannelChoice> name="channel" value="auto" current={behavior.channel} onPick={(channel) => update({ channel })}
          title="会話を読んで、必要なときだけ（空気読み）" hint="メンションがなくても、自分に向けた質問や手伝えそうな話には加わります。関係ない雑談には反応しません。" />
        <Choice<ChannelChoice> name="channel" value="always" current={behavior.channel} onPick={(channel) => update({ channel })}
          title="すべてのメッセージに返事する" hint="bot 専用のチャンネル向けです。" />
        <Choice<ChannelChoice> name="channel" value="never" current={behavior.channel} onPick={(channel) => update({ channel })}
          title="チャンネルでは話さない" hint="DM だけで使います。" />
      </Question>

      <Question title="グループ DM（複数人の DM）では？">
        <div className="grid gap-[var(--space-2)] sm:grid-cols-2">
          {([["same", "チャンネルと同じ"], ["always", "すべてに返事"], ["mention", "メンションだけ"], ["never", "話さない"]] as [GroupDmChoice, string][]).map(([value, title]) => (
            <Choice<GroupDmChoice> key={value} name="groupDm" value={value} current={behavior.groupDm} onPick={(groupDm) => update({ groupDm })} title={title} />
          ))}
        </div>
      </Question>

      {usesMentions(behavior) && (
        <Question title="一度返事したスレッドでは？">
          <Choice name="threads" value="yes" current={behavior.engagedThreads ? "yes" : "no"} onPick={() => update({ engagedThreads: true })}
            title="メンションなしでも続けて返事する" hint="会話の途中で毎回呼ばなくて済みます（おすすめ）。" />
          <Choice name="threads" value="no" current={behavior.engagedThreads ? "yes" : "no"} onPick={() => update({ engagedThreads: false })}
            title="毎回メンションが必要" />
        </Question>
      )}

      <Exceptions behavior={behavior} channels={channels} channelError={channelError} onChange={(exceptions) => update({ exceptions })} />

      <section className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-quaternary)] p-[var(--space-4)] flex flex-col gap-1">
        <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)] mb-1">こうなります</div>
        {describeBehavior(behavior, nameOf).map((line) => (
          <div key={line} className="flex gap-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"><Check size={14} className="shrink-0 mt-0.5 text-[var(--system-green)]" />{line}</div>
        ))}
        {behavior.channel === "auto" && (
          <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            空気読みの仕組み（Jev を使うか、どれくらい自分から加わるか）は <a href="/settings">設定ページ</a> の Jev の欄で細かく決められます。
          </div>
        )}
      </section>

      <div className="flex items-center gap-[var(--space-3)]">
        <button type="button" onClick={save} disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 px-5 py-2 rounded-[var(--radius-md)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]"
          style={{ background: !dirty || saving ? "var(--fill-tertiary)" : "var(--accent)", color: !dirty || saving ? "var(--text-tertiary)" : "var(--accent-contrast)" }}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : null}
          {saving ? "保存中…" : dirty ? "この内容で保存" : "保存済み"}
        </button>
        {message && <span className="text-[length:var(--text-footnote)]" style={{ color: message.ok ? "var(--system-green)" : "var(--system-red)" }}>{message.text}</span>}
      </div>
    </div>
  )
}
