"use client"

import { useEffect, useState } from "react"
import { RotateCcw, Trash2, Check, Save, Loader2 } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useSettings } from "@/app/settings-provider"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useTheme } from "@/app/providers"
import { THEMES } from "@/lib/themes"
import type { ThemeId } from "@/lib/themes"
import { api } from "@/lib/api"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { ModelSelector } from "@/components/settings/model-selector"
import { UpdateNotificationSettings } from "@/components/settings/update-notification-settings"
import {
  MODEL_VENDORS,
  TRIAGE_MODEL_VENDORS,
  claudeEffortOptionsForModel,
  codexEffortOptionsForModel,
  defaultModelForEngine,
  defaultTriageModelForEngine,
  type SupportedModelEngine,
  type TriageModelEngine,
} from "@/lib/model-catalog"

// ---------------------------------------------------------------------------
// Accent color presets
// ---------------------------------------------------------------------------

const ACCENT_PRESETS = [
  { label: "Red", value: "#EF4444" },
  { label: "Orange", value: "#F97316" },
  { label: "Amber", value: "#F59E0B" },
  { label: "Yellow", value: "#EAB308" },
  { label: "Lime", value: "#84CC16" },
  { label: "Green", value: "#22C55E" },
  { label: "Emerald", value: "#10B981" },
  { label: "Cyan", value: "#06B6D4" },
  { label: "Blue", value: "#3B82F6" },
  { label: "Indigo", value: "#6366F1" },
  { label: "Violet", value: "#8B5CF6" },
  { label: "Pink", value: "#EC4899" },
]

// ---------------------------------------------------------------------------
// Slack App manifest (minimum config — paste-and-go)
// ---------------------------------------------------------------------------

// Build the paste-and-go Slack App manifest for a given bot name. The
// Agents & AI Apps feature (features.assistant_view + assistant:write +
// assistant_thread_* events) is enabled by default so the "New chat" button is
// available out of the box — each new chat becomes its own session.
function buildSlackManifest(botName?: string | null): string {
  const name = (botName ?? "").trim() || "Ryoko"
  return JSON.stringify(
    {
      display_information: { name },
      features: {
        app_home: {
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: name, always_online: true },
        assistant_view: {
          assistant_description: `${name} — your AI assistant`,
          suggested_prompts: [
            { title: "What can you do?", message: "What can you help me with?" },
          ],
        },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "assistant:write",
            "canvases:read",
            "canvases:write",
            "channels:history",
            "channels:read",
            "chat:write",
            "chat:write.customize",
            "files:read",
            "files:write",
            "groups:history",
            "groups:read",
            "im:history",
            "im:read",
            "im:write",
            "mpim:history",
            "mpim:read",
            "mpim:write",
            "reactions:read",
            "reactions:write",
            "users:read",
            "users:read.email",
          ],
          user: [
            "channels:history",
            "channels:read",
            "files:read",
            "groups:history",
            "groups:read",
            "im:history",
            "im:read",
            "mpim:history",
            "mpim:read",
            "search:read",
            "users:read",
            "bookmarks:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention",
            "assistant_thread_context_changed",
            "assistant_thread_started",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
            "reaction_added",
          ],
        },
        socket_mode_enabled: true,
      },
    },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// Config type (gateway API)
// ---------------------------------------------------------------------------

interface Config {
  gateway?: { port?: number; host?: string }
  engines?: {
    default?: SupportedModelEngine
    claude?: { bin?: string; model?: string; effortLevel?: string; interactive?: boolean }
    codex?: { bin?: string; model?: string; effortLevel?: string }
    gemini?: { bin?: string; model?: string; effortLevel?: string }
  }
  sessions?: {
    maxDurationMinutes?: number
    maxCostUsd?: number
    interruptOnNewMessage?: boolean
    rateLimitStrategy?: "wait" | "fallback"
    fallbackEngine?: "codex"
  }
  connectors?: {
    slack?: {
      appToken?: string
      botToken?: string
      shareSessionInChannel?: boolean
      allowFrom?: string | string[]
      ignoreOldMessagesOnBoot?: boolean
      respondTo?: {
        im?: "always" | "mention" | "never"
        mpim?: "always" | "mention" | "never"
        channel?: "always" | "mention" | "never"
        engagedThreads?: boolean
      }
      triage?: {
        enabled?: boolean
        engine?: "claude" | "codex"
        bin?: string
        model?: string
        timeoutMs?: number
        threadContextLimit?: number
        persona?: string
      }
      goalExtraction?: {
        enabled?: boolean
        engine?: "claude" | "codex"
        bin?: string
        model?: string
        timeoutMs?: number
      }
      agentsCanvas?: {
        enabled?: boolean
        channelId?: string
        title?: string
        pollIntervalMs?: number
        maxPerGroup?: number
      }
    }
    discord?: {
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
      respondTo?: {
        dm?: "always" | "mention" | "never"
        channel?: "always" | "mention" | "never"
        engagedThreads?: boolean
      }
      replyStyle?: "channel" | "reply" | "thread"
    }
    telegram?: {
      botToken?: string
      allowFrom?: number[]
      ignoreOldMessagesOnBoot?: boolean
    }
    whatsapp?: {
      authDir?: string
      allowFrom?: string[]
    }
    web?: Record<string, never>
    instances?: Array<{
      id: string
      type: "discord" | "slack" | "whatsapp" | "telegram"
      employee?: string
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
      appToken?: string
      authDir?: string
      ignoreOldMessagesOnBoot?: boolean
      [key: string]: unknown
    }>
  }
  logging?: {
    level?: string
    stdout?: boolean
    file?: boolean
  }
  cron?: {
    defaultDelivery?: { connector?: string; channel?: string }
  }
  portal?: {
    portalName?: string
    operatorName?: string
  }
  [key: string]: unknown
}

function configuredConnectorIds(config: Config): string[] {
  const ids = new Set<string>()
  for (const [name, value] of Object.entries(config.connectors ?? {})) {
    if (name === "instances" || name === "web" || !value || typeof value !== "object") continue
    ids.add(name)
  }
  for (const instance of config.connectors?.instances ?? []) {
    if (instance.id) ids.add(instance.id)
  }
  if (config.cron?.defaultDelivery?.connector && config.cron.defaultDelivery.connector !== "web") {
    ids.add(config.cron.defaultDelivery.connector)
  }
  return Array.from(ids).sort()
}

// ---------------------------------------------------------------------------
// Section wrapper using CSS variable styling
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-[var(--space-6)]">
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] px-[var(--space-2)] pb-[var(--space-2)]"
      >
        {title}
      </div>
      <div
        className="bg-[var(--material-regular)] rounded-[var(--radius-md)] border border-[var(--separator)] p-[var(--space-4)]"
      >
        {children}
      </div>
    </section>
  )
}

function FieldRow({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between py-[var(--space-2)] gap-[var(--space-4)]"
    >
      <label
        htmlFor={htmlFor}
        className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] shrink-0"
      >
        {label}
      </label>
      <div className="w-[240px] shrink-0">{children}</div>
    </div>
  )
}

function SettingsInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
    />
  )
}

function SettingsSelect({
  id,
  value,
  onChange,
  options,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-[44px] h-[24px] rounded-[12px] border-none cursor-pointer relative shrink-0 transition-[background] duration-200 ease-[var(--ease-smooth)]"
      style={{
        background: checked ? "var(--system-green)" : "var(--fill-primary)",
      }}
    >
      <span
        className="absolute top-[2px] w-[20px] h-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200 ease-[var(--ease-spring)]"
        style={{
          left: checked ? 22 : 2,
        }}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Whisper STT language list (curated top ~35)
// ---------------------------------------------------------------------------

const WHISPER_LANGUAGES: Record<string, string> = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
  nl: "Dutch", sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian",
  uk: "Ukrainian", he: "Hebrew", da: "Danish", fi: "Finnish", hu: "Hungarian",
  no: "Norwegian", sk: "Slovak", hr: "Croatian", ca: "Catalan", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", ms: "Malay", tl: "Filipino", sr: "Serbian",
  lt: "Lithuanian", lv: "Latvian", sl: "Slovenian", et: "Estonian",
}

// ---------------------------------------------------------------------------
// Voice Input (STT) settings section — self-contained state
// ---------------------------------------------------------------------------

function SttSettingsSection() {
  const [status, setStatus] = useState<{
    available: boolean
    model: string | null
    downloading: boolean
    progress: number
    languages: string[]
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [addLang, setAddLang] = useState("")

  useEffect(() => {
    api.sttStatus().then(setStatus).catch(() => {})
  }, [])

  // Poll for download progress
  useEffect(() => {
    if (!status?.downloading) return
    const timer = setInterval(() => {
      api.sttStatus().then(setStatus).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [status?.downloading])

  function handleRemoveLanguage(code: string) {
    if (!status || status.languages.length <= 1) return
    const next = status.languages.filter((l) => l !== code)
    setSaving(true)
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  function handleAddLanguage() {
    if (!addLang || !status || status.languages.includes(addLang)) return
    const next = [...status.languages, addLang]
    setSaving(true)
    setAddLang("")
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  function handleDownload() {
    api.sttDownload()
      .then(() => setStatus((prev) => prev ? { ...prev, downloading: true, progress: 0 } : prev))
      .catch(() => {})
  }

  if (!status) return null

  const availableLangs = Object.entries(WHISPER_LANGUAGES)
    .filter(([code]) => !status.languages.includes(code))
    .sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <Section title="音声入力">
      {/* Status row */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
        <div
          className="w-[8px] h-[8px] rounded-full shrink-0"
          style={{
            background: status.available ? "var(--system-green)" : "var(--system-red)",
          }}
        />
        <div className="flex-1">
          <div className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            {status.available
              ? `Whisper ${(status.model || "small").charAt(0).toUpperCase() + (status.model || "small").slice(1)}`
              : "No model installed"}
          </div>
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {status.available
              ? "Offline speech recognition ready"
              : "Download a model to enable voice input"}
          </div>
        </div>
      </div>

      {/* Download section */}
      {!status.available && !status.downloading && (
        <button
          onClick={handleDownload}
          className="w-full p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] mb-[var(--space-4)]"
        >
          Download Whisper Small (~500MB)
        </button>
      )}

      {/* Download progress */}
      {status.downloading && (
        <div className="mb-[var(--space-4)]">
          <div className="flex justify-between mb-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            <span>モデルをダウンロード中…</span>
            <span>{status.progress}%</span>
          </div>
          <div className="h-[6px] rounded-[3px] bg-[var(--fill-tertiary)] overflow-hidden">
            <div
              className="h-full rounded-[3px] bg-[var(--accent)] transition-[width] duration-300 ease-out"
              style={{
                width: `${status.progress}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Languages section — only when model is available */}
      {status.available && (
        <>
          <div className="border-t border-[var(--separator)] mt-[var(--space-2)] pt-[var(--space-3)]">
            <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              文字起こし言語
            </div>
            <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
              最初の言語がデフォルトになります。複数追加するとチャットで言語ピッカーが表示されます。
            </div>

            {/* Language chips */}
            <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]">
              {status.languages.map((code) => (
                <div
                  key={code}
                  className="inline-flex items-center gap-[var(--space-1)] px-[8px] py-[3px] rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-primary)]"
                >
                  <span className="font-[family-name:var(--font-mono)] uppercase text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] mr-[2px]">
                    {code}
                  </span>
                  {WHISPER_LANGUAGES[code] || code}
                  {status.languages.length > 1 && (
                    <button
                      onClick={() => handleRemoveLanguage(code)}
                      disabled={saving}
                      aria-label={`Remove ${WHISPER_LANGUAGES[code] || code}`}
                      className="bg-none border-none cursor-pointer p-0 ml-[2px] text-[var(--text-quaternary)] text-[14px] leading-none flex items-center"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add language */}
            <div className="flex gap-[var(--space-2)]">
              <select
                value={addLang}
                onChange={(e) => setAddLang(e.target.value)}
                className="flex-1 bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] cursor-pointer"
                style={{
                  color: addLang ? "var(--text-primary)" : "var(--text-tertiary)",
                }}
              >
                <option value="">言語を追加…</option>
                {availableLangs.map(([code, name]) => (
                  <option key={code} value={code}>
                    {code.toUpperCase()} — {name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAddLanguage}
                disabled={!addLang || saving}
                className="px-[14px] py-[6px] rounded-[var(--radius-sm)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] shrink-0"
                style={{
                  background: addLang ? "var(--accent)" : "var(--fill-tertiary)",
                  color: addLang ? "var(--accent-contrast)" : "var(--text-quaternary)",
                  cursor: addLang ? "pointer" : "default",
                }}
              >
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Slack onboarding guide (manifest copy panel)
// ---------------------------------------------------------------------------

function SlackSetupGuide() {
  const { settings } = useSettings()
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(true)
  const manifest = buildSlackManifest(settings.portalName)

  function handleCopy() {
    navigator.clipboard.writeText(manifest).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-[var(--space-3)] mb-[var(--space-3)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full text-left cursor-pointer"
      >
        <span className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          Slack App セットアップガイド
        </span>
        <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {open ? "閉じる" : "開く"}
        </span>
      </button>
      {open && (
        <div className="mt-[var(--space-3)]">
          <ol className="list-decimal pl-[20px] text-[length:var(--text-caption1)] text-[var(--label-secondary)] leading-relaxed mb-[var(--space-3)] space-y-[2px]">
            <li>
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] underline"
              >
                Slack API の Your Apps ページ
              </a>
              を開き、「Create New App」を選択。
            </li>
            <li>「From a manifest」を選び、対象ワークスペースを指定。</li>
            <li>下のJSONをコピーして貼り付け、「Create」で作成。</li>
            <li>
              「Install to Workspace」を実行し、OAuth & Permissions の「Bot User OAuth
              Token」（<code>xoxb-…</code>）を下の Bot Token に貼り付け。
            </li>
            <li>
              「Basic Information」→「App-Level Tokens」で <code>connections:write</code>{" "}
              スコープ付きトークンを発行し（<code>xapp-…</code>）、下の App Token に貼り付け。
            </li>
          </ol>
          <div className="relative">
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy manifest JSON"
              className="absolute top-2 right-2 py-0.5 px-2 text-[11px] rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] text-[var(--text-secondary)] border border-[var(--separator)] cursor-pointer"
            >
              {copied ? "コピー済み" : "コピー"}
            </button>
            <pre className="bg-[var(--fill-tertiary)] border border-[var(--separator)] rounded-[var(--radius-md)] py-[var(--space-3)] px-[var(--space-4)] overflow-x-auto text-[12px] leading-normal font-['SF_Mono',Menlo,monospace] text-[var(--text-primary)] max-h-[280px]">
              <code>{manifest}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  useBreadcrumbs([{ label: 'Settings' }])
  const {
    settings,
    setAccentColor,
    setPortalName,
    setPortalSubtitle,
    setOperatorName,
    setPortalEmoji,
    setLanguage,
    resetAll,
  } = useSettings()
  const { theme, setTheme } = useTheme()

  // Local branding inputs
  const [nameValue, setNameValue] = useState(settings.portalName ?? "")
  const [subtitleValue, setSubtitleValue] = useState(settings.portalSubtitle ?? "")
  const [operatorNameValue, setOperatorNameValue] = useState(settings.operatorName ?? "")
  const [emojiValue, setEmojiValue] = useState(settings.portalEmoji ?? "")
  const [languageValue, setLanguageValue] = useState(settings.language ?? "English")
  const [customHex, setCustomHex] = useState(settings.accentColor ?? "")
  const [showCooEmojiPicker, setShowCooEmojiPicker] = useState(false)

  // Gateway config state
  const [config, setConfig] = useState<Config>({})
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    type: "success" | "error"
    message: string
  } | null>(null)

  // WhatsApp QR code state
  const [waQr, setWaQr] = useState<string | null>(null)
  const [waStatus, setWaStatus] = useState<string>("unknown")

  // Employees list for instance binding
  const [employees, setEmployees] = useState<Array<{name: string, displayName: string}>>([])

  // Slack channels for the Agents View canvas channel picker.
  // We only fetch when the bot tokens are present, since hitting the API
  // without credentials just returns an error and a confusing spinner.
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; isPrivate: boolean }> | null>(null)
  const [slackChannelsLoading, setSlackChannelsLoading] = useState(false)
  const [slackChannelsError, setSlackChannelsError] = useState<string | null>(null)

  useEffect(() => {
    api.getOrg().then((org: any) => {
      if (org?.employees) {
        setEmployees(org.employees.map((e: any) => typeof e === 'string' ? { name: e, displayName: e } : { name: e.name, displayName: e.displayName || e.name }))
      }
    }).catch(() => {})
  }, [])

  const refreshSlackChannels = async () => {
    setSlackChannelsLoading(true)
    setSlackChannelsError(null)
    try {
      const res = await fetch("/api/connectors/slack/channels")
      const body = await res.json()
      if (!body?.ok) {
        const err = body?.error || `HTTP ${res.status}`
        if (err === "missing_scope") {
          setSlackChannelsError("Bot に canvases / channels scope が足りません。上のSlack App Manifestを貼り直して再インストールしてください。")
        } else if (err === "slack_not_configured") {
          setSlackChannelsError("Slack コネクタが未起動です。先に Bot Token / App Token を保存して再起動してください。")
        } else {
          setSlackChannelsError(`チャンネル取得失敗: ${err}`)
        }
        setSlackChannels(null)
      } else {
        setSlackChannels(body.channels ?? [])
      }
    } catch (err) {
      setSlackChannelsError(err instanceof Error ? err.message : String(err))
      setSlackChannels(null)
    } finally {
      setSlackChannelsLoading(false)
    }
  }

  // Sync local values when settings change externally (e.g., reset)
  useEffect(() => {
    setNameValue(settings.portalName ?? "")
    setSubtitleValue(settings.portalSubtitle ?? "")
    setOperatorNameValue(settings.operatorName ?? "")
    setEmojiValue(settings.portalEmoji ?? "")
    setLanguageValue(settings.language ?? "English")
    setCustomHex(settings.accentColor ?? "")
  }, [
    settings.portalName,
    settings.portalSubtitle,
    settings.operatorName,
    settings.portalEmoji,
    settings.language,
    settings.accentColor,
  ])

  // Load gateway config
  function loadConfig() {
    setConfigLoading(true)
    api
      .getConfig()
      .then((data) => {
        setConfig(data as Config)
        setConfigError(null)
      })
      .catch((err) => setConfigError(err.message))
      .finally(() => setConfigLoading(false))
  }

  useEffect(() => {
    loadConfig()
  }, [])

  // Poll for WhatsApp QR code when WhatsApp connector is configured
  useEffect(() => {
    if (!config.connectors?.whatsapp) return

    let cancelled = false

    async function checkQr() {
      try {
        const statusRes = await fetch("/api/status")
        const status = await statusRes.json()
        const connStatus = status?.connectors?.whatsapp?.status
        if (!cancelled) setWaStatus(connStatus ?? "unknown")

        if (connStatus === "qr_pending") {
          const qrRes = await fetch("/api/connectors/whatsapp/qr")
          const data = await qrRes.json()
          if (!cancelled) setWaQr(data.qr)
        } else {
          if (!cancelled) setWaQr(null)
        }
      } catch {
        // non-fatal
      }
    }

    void checkQr()
    const interval = setInterval(() => { void checkQr() }, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [config.connectors?.whatsapp])

  function updateConfig(path: string[], value: unknown) {
    setConfig((prev) => {
      const next = structuredClone(prev)
      let obj: Record<string, unknown> = next
      for (let i = 0; i < path.length - 1; i++) {
        if (!obj[path[i]] || typeof obj[path[i]] !== "object") {
          obj[path[i]] = {}
        }
        obj = obj[path[i]] as Record<string, unknown>
      }
      obj[path[path.length - 1]] = value
      // Both the default-model and engine-specific pickers use this path.
      // Changing models must not leave an invisible max effort selected.
      if (
        obj.effortLevel === "max" && (
          (path.join(".") === "engines.codex.model" && value !== "gpt-6-astra") ||
          (path.join(".") === "engines.claude.model" && value !== "claude-fable-5-1")
        )
      ) {
        obj.effortLevel = "default"
      }
      return next
    })
  }

  function handleSave() {
    setSaving(true)
    setFeedback(null)
    api
      .updateConfig(config)
      .then((response) => {
        // Backend signals "partial" when the file was written but at least
        // one connector failed to (re)start — typically a bad Slack token.
        // Show the underlying errors so the user can fix them, instead of
        // a misleading "Settings saved" toast.
        const r = response as {
          status?: string
          connectorsReload?: { errors?: string[] }
          connectorsReloadError?: string
        }
        if (r?.connectorsReloadError) {
          setFeedback({
            type: "error",
            message: `Settings saved but connector reload failed: ${r.connectorsReloadError}`,
          })
          return
        }
        const reloadErrors = r?.connectorsReload?.errors ?? []
        if (r?.status === "partial" || reloadErrors.length > 0) {
          setFeedback({
            type: "error",
            message: `Settings saved but ${reloadErrors.length} connector(s) failed: ${reloadErrors.join("; ")}`,
          })
          return
        }
        setFeedback({ type: "success", message: "Settings saved successfully" })
      })
      .catch((err) =>
        setFeedback({
          type: "error",
          message: `Failed to save: ${err.message}`,
        })
      )
      .finally(() => setSaving(false))
  }

  const defaultModelEngine: SupportedModelEngine =
    config.engines?.default === "codex"
      ? "codex"
      : config.engines?.default === "gemini"
        ? "gemini"
        : "claude"

  return (
    <PageLayout>
      <div
        className="h-full overflow-y-auto bg-[var(--bg)]"
      >
        <div
          className="max-w-[640px] mx-auto px-[var(--space-4)] py-[var(--space-6)] pb-[var(--space-12)]"
        >
          {/* Page header */}
          <h1
            className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-6)]"
          >
            Settings
          </h1>

          {/* -- Section 1: Appearance -- */}
          <Section title="外観">
            {/* Theme picker */}
            <div
              className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]"
            >
              Theme
            </div>
            <div
              className="grid grid-cols-5 gap-[var(--space-2)] mb-[var(--space-4)]"
            >
              {THEMES.map((t) => {
                const isActive = theme === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="flex flex-col items-center gap-[var(--space-1)] px-[var(--space-2)] py-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] cursor-pointer transition-all duration-150 ease-[var(--ease-smooth)]"
                    style={{
                      border: isActive
                        ? "2px solid var(--accent)"
                        : "2px solid var(--separator)",
                    }}
                  >
                    <span className="text-[24px]">{t.emoji}</span>
                    <span
                      className="text-[length:var(--text-caption2)]"
                      style={{
                        fontWeight: isActive
                          ? "var(--weight-semibold)"
                          : "var(--weight-medium)",
                        color: isActive
                          ? "var(--accent)"
                          : "var(--text-secondary)",
                      }}
                    >
                      {t.label}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Accent color */}
            <div
              className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]"
            >
              Accent Color
            </div>
            <div
              className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]"
            >
              {ACCENT_PRESETS.map((preset) => {
                const isActive = settings.accentColor === preset.value
                return (
                  <button
                    key={preset.value}
                    onClick={() => setAccentColor(preset.value)}
                    aria-label={preset.label}
                    title={preset.label}
                    className="w-[32px] h-[32px] rounded-full cursor-pointer transition-all duration-100 ease-[var(--ease-smooth)] flex items-center justify-center"
                    style={{
                      background: preset.value,
                      border: isActive
                        ? "2px solid var(--text-primary)"
                        : "2px solid transparent",
                      outline: isActive
                        ? `2px solid ${preset.value}`
                        : "none",
                      outlineOffset: 2,
                    }}
                  >
                    {isActive && (
                      <Check size={14} color="#fff" strokeWidth={3} />
                    )}
                  </button>
                )
              })}
            </div>

            {/* Custom hex input */}
            <div
              className="flex items-center gap-[var(--space-3)]"
            >
              <label
                className="flex items-center gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] cursor-pointer"
              >
                Custom:
                <input
                  type="color"
                  value={settings.accentColor ?? "#3B82F6"}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="w-[28px] h-[28px] border-none rounded-full cursor-pointer bg-transparent p-0"
                />
              </label>
              <input
                type="text"
                placeholder="#3B82F6"
                value={customHex}
                onChange={(e) => {
                  setCustomHex(e.target.value)
                  if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
                    setAccentColor(e.target.value)
                  }
                }}
                className="apple-input w-[90px] px-[8px] py-[4px] text-[length:var(--text-caption1)] bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] text-[var(--text-primary)] font-mono"
              />
              {settings.accentColor && (
                <button
                  onClick={() => setAccentColor(null)}
                  className="text-[length:var(--text-footnote)] text-[var(--system-blue)] bg-none border-none cursor-pointer p-0 inline-flex items-center gap-[4px]"
                >
                  <RotateCcw size={12} />
                  リセット
                </button>
              )}
            </div>
          </Section>

          {/* -- COO Emoji -- */}
          <Section title="COO絵文字">
            <div>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
                サイドバーに表示される COO の絵文字を選択してください。
              </div>
              <div className="relative flex items-center gap-[var(--space-4)]">
                <button
                  onClick={() => setShowCooEmojiPicker(!showCooEmojiPicker)}
                  className="text-4xl cursor-pointer bg-transparent border-none p-0"
                >
                  {settings.portalEmoji ?? "\u{1F9DE}"}
                </button>
                <div>
                  <div className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                    {settings.operatorName || "Jimbo"}
                  </div>
                  <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                    絵文字をクリックして変更
                  </div>
                </div>
                {showCooEmojiPicker && (
                  <EmojiPicker
                    current={settings.portalEmoji ?? "\u{1F9DE}"}
                    onSelect={(emoji) => {
                      setPortalEmoji(emoji)
                      setShowCooEmojiPicker(false)
                    }}
                    onClose={() => setShowCooEmojiPicker(false)}
                  />
                )}
              </div>
            </div>
          </Section>

          {/* -- Section 2: Branding -- */}
          <Section title="ブランディング">
            <div
              className="flex flex-col gap-[var(--space-3)]"
            >
              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Name
                </label>
                <input
                  type="text"
                  className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
                  placeholder="Jinn"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={() => {
                    setPortalName(nameValue || null)
                    api.completeOnboarding({ portalName: nameValue || undefined }).catch(() => {})
                  }}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Subtitle
                </label>
                <input
                  type="text"
                  className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
                  placeholder="Command Centre"
                  value={subtitleValue}
                  onChange={(e) => setSubtitleValue(e.target.value)}
                  onBlur={() => setPortalSubtitle(subtitleValue || null)}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Operator Name
                </label>
                <input
                  type="text"
                  className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
                  placeholder="Your Name"
                  value={operatorNameValue}
                  onChange={(e) => setOperatorNameValue(e.target.value)}
                  onBlur={() => {
                    setOperatorName(operatorNameValue || null)
                    api.completeOnboarding({ operatorName: operatorNameValue || undefined }).catch(() => {})
                  }}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Emoji
                </label>
                <input
                  type="text"
                  className="apple-input w-[80px] text-center text-[length:var(--text-title2)] px-[8px] py-[6px] bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)]"
                  placeholder="\ud83e\uddde"
                  value={emojiValue}
                  onChange={(e) => setEmojiValue(e.target.value)}
                  onBlur={() => setPortalEmoji(emojiValue || null)}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Language
                </label>
                <select
                  value={languageValue}
                  onChange={(e) => setLanguageValue(e.target.value)}
                  onBlur={() => {
                    setLanguage(languageValue || "English")
                    api.completeOnboarding({ language: languageValue || undefined }).catch(() => {})
                  }}
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer"
                >
                  <option value="English">English</option>
                  <option value="Spanish">Spanish</option>
                  <option value="French">French</option>
                  <option value="German">German</option>
                  <option value="Portuguese">Portuguese</option>
                  <option value="Italian">Italian</option>
                  <option value="Dutch">Dutch</option>
                  <option value="Russian">Russian</option>
                  <option value="Chinese">Chinese</option>
                  <option value="Japanese">Japanese</option>
                  <option value="Korean">Korean</option>
                  <option value="Arabic">Arabic</option>
                  <option value="Hindi">Hindi</option>
                  <option value="Bulgarian">Bulgarian</option>
                </select>
              </div>
            </div>
          </Section>

          {/* Gateway config feedback */}
          {feedback && (
            <div
              className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)]"
              style={{
                background:
                  feedback.type === "success"
                    ? "rgba(34,197,94,0.1)"
                    : "rgba(239,68,68,0.1)",
                border: `1px solid ${
                  feedback.type === "success"
                    ? "rgba(34,197,94,0.3)"
                    : "rgba(239,68,68,0.3)"
                }`,
                color:
                  feedback.type === "success"
                    ? "var(--system-green)"
                    : "var(--system-red)",
              }}
            >
              {feedback.message}
            </div>
          )}

          {configLoading ? (
            <div
              className="text-center p-[var(--space-8)] text-[var(--text-tertiary)] text-[length:var(--text-footnote)]"
            >
              <Loader2
                size={20}
                className="mx-auto mb-[var(--space-2)] animate-spin"
              />
              Loading gateway config...
            </div>
          ) : configError ? (
            <div
              className="mb-[var(--space-6)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
            >
              Failed to load config: {configError}
            </div>
          ) : (
            <>
              {/* -- Section 3: Gateway Configuration -- */}
              <Section title="ゲートウェイ設定">
                <FieldRow label="Port">
                  <SettingsInput
                    type="number"
                    value={String(config.gateway?.port ?? "")}
                    onChange={(v) =>
                      updateConfig(["gateway", "port"], Number(v) || 0)
                    }
                    placeholder="7777"
                  />
                </FieldRow>
                <FieldRow label="Host">
                  <SettingsInput
                    value={config.gateway?.host ?? ""}
                    onChange={(v) => updateConfig(["gateway", "host"], v)}
                    placeholder="127.0.0.1"
                  />
                </FieldRow>
                <FieldRow label="既定モデルのベンダー" htmlFor="default-model-vendor">
                  <SettingsSelect
                    id="default-model-vendor"
                    value={defaultModelEngine}
                    onChange={(v) => {
                      const engine = v as SupportedModelEngine
                      updateConfig(
                        ["engines", "default"],
                        engine,
                      )
                      if (!config.engines?.[engine]?.model) {
                        updateConfig(
                          ["engines", engine, "model"],
                          defaultModelForEngine(engine),
                        )
                      }
                      if (engine === "gemini" && !config.engines?.gemini?.bin) {
                        updateConfig(["engines", "gemini", "bin"], "gemini")
                      }
                    }}
                    options={MODEL_VENDORS}
                  />
                </FieldRow>
                <FieldRow label="既定モデル" htmlFor="default-model">
                  <ModelSelector
                    id="default-model"
                    engine={defaultModelEngine}
                    model={
                      config.engines?.[defaultModelEngine]?.model ??
                      defaultModelForEngine(defaultModelEngine)
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["engines", defaultModelEngine, "model"],
                        v ?? defaultModelForEngine(defaultModelEngine),
                      )
                    }
                  />
                </FieldRow>
              </Section>

              {/* -- Section 4: Engine Configuration -- */}
              <Section title="エンジン設定">
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Claude
                </div>
                <FieldRow label="Binary Path">
                  <SettingsInput
                    value={config.engines?.claude?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "bin"], v)
                    }
                    placeholder="claude"
                  />
                </FieldRow>
                <FieldRow label="Model" htmlFor="claude-engine-model">
                  <ModelSelector
                    id="claude-engine-model"
                    engine="claude"
                    model={
                      config.engines?.claude?.model ?? defaultModelForEngine("claude")
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["engines", "claude", "model"],
                        v ?? defaultModelForEngine("claude"),
                      )
                    }
                  />
                </FieldRow>
                <FieldRow label="Effort Level">
                  <SettingsSelect
                    value={config.engines?.claude?.effortLevel ?? "default"}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "effortLevel"], v)
                    }
                    options={claudeEffortOptionsForModel(config.engines?.claude?.model)}
                  />
                </FieldRow>
                <FieldRow label="インタラクティブPTY（Max定額）">
                  <ToggleSwitch
                    checked={config.engines?.claude?.interactive ?? false}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "interactive"], v)
                    }
                  />
                </FieldRow>
                <div
                  className="text-[length:var(--text-caption1)] text-[var(--label-secondary)] mt-[4px]"
                >
                  有効にすると Claude の作業ターンを PTY（cc_entrypoint=cli）で実行します。
                  Claude CLI が Max サブスクリプションでログイン済みなら、API 従量課金ではなく Max 側の利用枠で実行されます。
                  SSH リモート実行の従業員は headless <code>claude -p</code> にフォールバックします。
                  <strong>変更の反映にはゲートウェイの再起動が必要です</strong>（保存後に <code>ryoko stop &amp;&amp; ryoko start</code> など）。
                </div>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Codex
                </div>
                <FieldRow label="Binary Path">
                  <SettingsInput
                    value={config.engines?.codex?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "bin"], v)
                    }
                    placeholder="codex"
                  />
                </FieldRow>
                <FieldRow label="Model" htmlFor="codex-engine-model">
                  <ModelSelector
                    id="codex-engine-model"
                    engine="codex"
                    model={
                      config.engines?.codex?.model ?? defaultModelForEngine("codex")
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["engines", "codex", "model"],
                        v ?? defaultModelForEngine("codex"),
                      )
                    }
                  />
                </FieldRow>
                <FieldRow label="Effort Level">
                  <SettingsSelect
                    value={config.engines?.codex?.effortLevel ?? "default"}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "effortLevel"], v)
                    }
                    options={codexEffortOptionsForModel(config.engines?.codex?.model)}
                  />
                </FieldRow>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Gemini
                </div>
                <FieldRow label="Binary Path">
                  <SettingsInput
                    value={config.engines?.gemini?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "gemini", "bin"], v)
                    }
                    placeholder="gemini"
                  />
                </FieldRow>
                <FieldRow label="Model" htmlFor="gemini-engine-model">
                  <ModelSelector
                    id="gemini-engine-model"
                    engine="gemini"
                    model={
                      config.engines?.gemini?.model ?? defaultModelForEngine("gemini")
                    }
                    onChange={(v) => {
                      updateConfig(
                        ["engines", "gemini", "model"],
                        v ?? defaultModelForEngine("gemini"),
                      )
                      if (!config.engines?.gemini?.bin) {
                        updateConfig(["engines", "gemini", "bin"], "gemini")
                      }
                    }}
                  />
                </FieldRow>
              </Section>

              {/* -- Section 5: Sessions -- */}
              <Section title="セッション">
                <FieldRow label="新規メッセージで中断">
                  <ToggleSwitch
                    checked={config.sessions?.interruptOnNewMessage ?? true}
                    onChange={(v) =>
                      updateConfig(["sessions", "interruptOnNewMessage"], v)
                    }
                  />
                </FieldRow>
                <div
                  className="text-[length:var(--text-caption1)] text-[var(--label-secondary)] mt-[4px]"
                >
                  有効にすると、実行中のセッションに新しいメッセージを送ると現在のエージェントを停止し、
                  すぐに新しいメッセージの処理を開始します。無効時はメッセージはキューに入ります。
                </div>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <FieldRow label="Claude が利用上限に達した時">
                  <SettingsSelect
                    value={config.sessions?.rateLimitStrategy ?? "fallback"}
                    onChange={(v) =>
                      updateConfig(["sessions", "rateLimitStrategy"], v)
                    }
                    options={[
                      { value: "wait", label: "待機して自動再開" },
                      { value: "fallback", label: "GPT (Codex) に切り替え" },
                    ]}
                  />
                </FieldRow>
                <div
                  className="text-[length:var(--text-caption1)] text-[var(--label-secondary)] mt-[4px]"
                >
                  「待機」は Claude のリセットを待ってからセッションを自動再開します。
                  「切り替え」は即座に GPT で応答し、リセット後に Claude へ戻します。
                </div>
              </Section>

              {/* -- Section 6: Connectors -- */}
              <Section title="コネクタ">
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Slack
                </div>
                <SlackSetupGuide />
                <FieldRow label="App Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.slack?.appToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "appToken"], v)
                    }
                    placeholder="xapp-..."
                  />
                </FieldRow>
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-[-4px] mb-[var(--space-2)] pl-[var(--space-1)]">
                  Basic Information → App-Level Tokens で発行したトークン（<code>xapp-…</code>）。
                </div>
                <FieldRow label="Bot Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.slack?.botToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "botToken"], v)
                    }
                    placeholder="xoxb-..."
                  />
                </FieldRow>
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-[-4px] mb-[var(--space-2)] pl-[var(--space-1)]">
                  ワークスペースにインストール後の OAuth & Permissions →
                  Bot User OAuth Token（<code>xoxb-…</code>）。
                </div>
                <FieldRow label="チャンネルでセッションを共有">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.shareSessionInChannel ?? false}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "shareSessionInChannel"], v)
                    }
                  />
                </FieldRow>
                <FieldRow label="許可ユーザー">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.slack?.allowFrom)
                      ? config.connectors?.slack?.allowFrom?.join(", ")
                      : config.connectors?.slack?.allowFrom ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
                      )
                    }
                    placeholder="U123, U456"
                  />
                </FieldRow>
                <FieldRow label="起動時に古いメッセージを無視">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.ignoreOldMessagesOnBoot ?? true}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "ignoreOldMessagesOnBoot"], v)
                    }
                  />
                </FieldRow>

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-3)] mb-[var(--space-2)]"
                >
                  応答ゲート（respondTo）
                </div>
                {(["im", "mpim", "channel"] as const).map((scope) => (
                  <FieldRow
                    key={scope}
                    label={
                      scope === "im" ? "DM（1対1）" : scope === "mpim" ? "グループDM" : "チャンネル"
                    }
                  >
                    <SettingsSelect
                      value={config.connectors?.slack?.respondTo?.[scope] ?? "always"}
                      onChange={(v) =>
                        updateConfig(
                          ["connectors", "slack", "respondTo", scope],
                          v as "always" | "mention" | "never",
                        )
                      }
                      options={[
                        { value: "always", label: "常に応答" },
                        { value: "mention", label: "@メンション時のみ" },
                        { value: "never", label: "応答しない" },
                      ]}
                    />
                  </FieldRow>
                ))}
                <FieldRow label="参加済みスレッドは再メンション不要">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.respondTo?.engagedThreads ?? true}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "respondTo", "engagedThreads"], v)
                    }
                  />
                </FieldRow>

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-3)] mb-[var(--space-2)]"
                >
                  空気読みトリアージ
                </div>
                <FieldRow label="有効化">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.triage?.enabled ?? false}
                    onChange={(v) => {
                      updateConfig(["connectors", "slack", "triage", "enabled"], v)
                      if (v && !config.connectors?.slack?.triage?.engine) {
                        updateConfig(["connectors", "slack", "triage", "engine"], "codex")
                      }
                      if (v && !config.connectors?.slack?.triage?.model) {
                        updateConfig(
                          ["connectors", "slack", "triage", "model"],
                          defaultTriageModelForEngine("codex"),
                        )
                      }
                    }}
                  />
                </FieldRow>
                <FieldRow label="モデルのベンダー" htmlFor="triage-model-vendor">
                  <SettingsSelect
                    id="triage-model-vendor"
                    value={config.connectors?.slack?.triage?.engine ?? "codex"}
                    onChange={(v) => {
                      const engine = v as TriageModelEngine
                      updateConfig(
                        ["connectors", "slack", "triage", "engine"],
                        engine,
                      )
                      updateConfig(
                        ["connectors", "slack", "triage", "model"],
                        defaultTriageModelForEngine(engine),
                      )
                    }}
                    options={TRIAGE_MODEL_VENDORS}
                  />
                </FieldRow>
                <FieldRow label="モデル" htmlFor="triage-model">
                  <ModelSelector
                    id="triage-model"
                    engine={config.connectors?.slack?.triage?.engine ?? "codex"}
                    model={config.connectors?.slack?.triage?.model}
                    allowAutomatic
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "triage", "model"],
                        v ?? null,
                      )
                    }
                  />
                </FieldRow>
                <FieldRow label="タイムアウト (ms)">
                  <SettingsInput
                    type="number"
                    value={
                      config.connectors?.slack?.triage?.timeoutMs !== undefined
                        ? String(config.connectors.slack.triage.timeoutMs)
                        : ""
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "triage", "timeoutMs"],
                        v.trim() ? Number(v) : undefined,
                      )
                    }
                    placeholder="20000"
                  />
                </FieldRow>
                <FieldRow label="スレッド文脈の取得件数">
                  <SettingsInput
                    type="number"
                    value={
                      config.connectors?.slack?.triage?.threadContextLimit !== undefined
                        ? String(config.connectors.slack.triage.threadContextLimit)
                        : ""
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "triage", "threadContextLimit"],
                        v.trim() ? Number(v) : undefined,
                      )
                    }
                    placeholder="10"
                  />
                </FieldRow>
                <FieldRow label="ペルソナ（任意）">
                  <SettingsInput
                    value={config.connectors?.slack?.triage?.persona ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "triage", "persona"],
                        v.trim() || undefined,
                      )
                    }
                    placeholder="Short description of what this bot is good at"
                  />
                </FieldRow>
                <FieldRow label="バイナリパス上書き（任意）">
                  <SettingsInput
                    value={config.connectors?.slack?.triage?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "triage", "bin"],
                        v.trim() || undefined,
                      )
                    }
                    placeholder="codex"
                  />
                </FieldRow>

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-3)] mb-[var(--space-2)]"
                >
                  Goal 判定
                </div>
                <FieldRow label="有効化">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.goalExtraction?.enabled ?? false}
                    onChange={(v) => {
                      updateConfig(["connectors", "slack", "goalExtraction", "enabled"], v)
                      if (v && !config.connectors?.slack?.goalExtraction?.engine) {
                        updateConfig(["connectors", "slack", "goalExtraction", "engine"], "codex")
                      }
                      if (v && !config.connectors?.slack?.goalExtraction?.model) {
                        updateConfig(
                          ["connectors", "slack", "goalExtraction", "model"],
                          defaultTriageModelForEngine("codex"),
                        )
                      }
                    }}
                  />
                </FieldRow>
                <FieldRow label="モデルのベンダー" htmlFor="goal-model-vendor">
                  <SettingsSelect
                    id="goal-model-vendor"
                    value={config.connectors?.slack?.goalExtraction?.engine ?? "codex"}
                    onChange={(v) => {
                      const engine = v as TriageModelEngine
                      updateConfig(
                        ["connectors", "slack", "goalExtraction", "engine"],
                        engine,
                      )
                      updateConfig(
                        ["connectors", "slack", "goalExtraction", "model"],
                        defaultTriageModelForEngine(engine),
                      )
                    }}
                    options={TRIAGE_MODEL_VENDORS}
                  />
                </FieldRow>
                <FieldRow label="モデル" htmlFor="goal-model">
                  <ModelSelector
                    id="goal-model"
                    engine={config.connectors?.slack?.goalExtraction?.engine ?? "codex"}
                    model={config.connectors?.slack?.goalExtraction?.model}
                    allowAutomatic
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "goalExtraction", "model"],
                        v ?? null,
                      )
                    }
                  />
                </FieldRow>
                <FieldRow label="タイムアウト (ms)">
                  <SettingsInput
                    type="number"
                    value={
                      config.connectors?.slack?.goalExtraction?.timeoutMs !== undefined
                        ? String(config.connectors.slack.goalExtraction.timeoutMs)
                        : ""
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "goalExtraction", "timeoutMs"],
                        v.trim() ? Number(v) : undefined,
                      )
                    }
                    placeholder="30000"
                  />
                </FieldRow>
                <FieldRow label="バイナリパス上書き（任意）">
                  <SettingsInput
                    value={config.connectors?.slack?.goalExtraction?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "goalExtraction", "bin"],
                        v.trim() || undefined,
                      )
                    }
                    placeholder="codex"
                  />
                </FieldRow>

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-3)] mb-[var(--space-2)]"
                >
                  Agents View Canvas
                </div>
                {/*
                  Discovery hint for retroactive enablement: if the user has
                  already configured Slack tokens but hasn't enabled Canvas,
                  surface a gentle nudge so they don't miss the feature.
                */}
                {(config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) &&
                  !config.connectors?.slack?.agentsCanvas?.enabled && (
                    <div
                      className="mx-[var(--space-2)] mb-[var(--space-3)] p-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--accent-fill)] bg-[color-mix(in_srgb,var(--accent-fill)_30%,transparent)]"
                    >
                      <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)] mb-[var(--space-1)]">
                        💡 Slack 連携済みです — Canvas も有効化してみませんか？
                      </div>
                      <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                        いま動いている全 Ryoko セッションが Slack の Canvas タブにライブ表示されます。
                        下の「有効化」を ON にしてチャンネルを選ぶだけで30秒以内に作成されます。
                        必要 scope は <code className="text-[var(--accent)]">canvases:write</code> と
                        <code className="text-[var(--accent)] ml-1">canvases:read</code>（manifest を貼り直して reinstall すれば自動）。
                      </div>
                    </div>
                  )}
                <p
                  className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] mb-[var(--space-2)] px-[var(--space-2)]"
                >
                  今動いている Ryoko のセッション一覧（running / waiting / errored / idle）
                  を Slack の Canvas に自動同期します。指定したチャンネル直下のタブとして
                  常に最新状態が見えるようになります。Bot に
                  <code className="mx-1 text-[var(--accent)]">canvases:write</code>
                  と
                  <code className="mx-1 text-[var(--accent)]">canvases:read</code>
                  scope が必要です（上の Slack App Manifest を貼り直して reinstall すれば
                  自動で揃います）。
                </p>
                <FieldRow label="有効化">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.agentsCanvas?.enabled ?? false}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "agentsCanvas", "enabled"], v)
                    }
                  />
                </FieldRow>
                <FieldRow label="表示先チャンネル">
                  <div className="flex w-full gap-[var(--space-2)] items-center">
                    {slackChannels && slackChannels.length > 0 ? (
                      <select
                        className="flex-1 bg-[var(--surface-secondary)] border border-[var(--separator)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)]"
                        value={config.connectors?.slack?.agentsCanvas?.channelId ?? ""}
                        onChange={(e) =>
                          updateConfig(
                            ["connectors", "slack", "agentsCanvas", "channelId"],
                            e.target.value || undefined,
                          )
                        }
                      >
                        <option value="">— 選択してください —</option>
                        {slackChannels.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.isPrivate ? "🔒 " : "#"}{c.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <SettingsInput
                        value={config.connectors?.slack?.agentsCanvas?.channelId ?? ""}
                        onChange={(v) =>
                          updateConfig(
                            ["connectors", "slack", "agentsCanvas", "channelId"],
                            v.trim() || undefined,
                          )
                        }
                        placeholder="C01234ABCDE — bot が member のチャンネル"
                      />
                    )}
                    <button
                      type="button"
                      onClick={refreshSlackChannels}
                      disabled={slackChannelsLoading}
                      className="px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] bg-[var(--surface-secondary)] border border-[var(--separator)] rounded-[var(--radius-control)] hover:bg-[var(--surface-tertiary)] disabled:opacity-50"
                    >
                      {slackChannelsLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : slackChannels ? (
                        "更新"
                      ) : (
                        "読み込み"
                      )}
                    </button>
                  </div>
                </FieldRow>
                {slackChannelsError ? (
                  <p className="text-[length:var(--text-caption1)] text-[var(--accent-red,#ef4444)] px-[var(--space-2)] -mt-[var(--space-1)] mb-[var(--space-2)]">
                    {slackChannelsError}
                  </p>
                ) : null}
                <FieldRow label="Canvas タイトル">
                  <SettingsInput
                    value={config.connectors?.slack?.agentsCanvas?.title ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "agentsCanvas", "title"],
                        v.trim() || undefined,
                      )
                    }
                    placeholder="Ryoko Agents View"
                  />
                </FieldRow>
                <FieldRow label="更新間隔 (ms)">
                  <SettingsInput
                    type="number"
                    value={
                      config.connectors?.slack?.agentsCanvas?.pollIntervalMs !== undefined
                        ? String(config.connectors.slack.agentsCanvas.pollIntervalMs)
                        : ""
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "agentsCanvas", "pollIntervalMs"],
                        v.trim() ? Number(v) : undefined,
                      )
                    }
                    placeholder="30000（30秒, 最小 5000）"
                  />
                </FieldRow>
                <FieldRow label="グループ毎の最大表示件数">
                  <SettingsInput
                    type="number"
                    value={
                      config.connectors?.slack?.agentsCanvas?.maxPerGroup !== undefined
                        ? String(config.connectors.slack.agentsCanvas.maxPerGroup)
                        : ""
                    }
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "agentsCanvas", "maxPerGroup"],
                        v.trim() ? Number(v) : undefined,
                      )
                    }
                    placeholder="10"
                  />
                </FieldRow>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Discord
                </div>
                <FieldRow label="Bot Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.discord?.botToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "botToken"], v)
                    }
                    placeholder="Bot token..."
                  />
                </FieldRow>
                <FieldRow label="Allow From">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.discord?.allowFrom)
                      ? config.connectors?.discord?.allowFrom?.join(", ")
                      : config.connectors?.discord?.allowFrom ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "discord", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
                      )
                    }
                    placeholder="User IDs, comma-separated (optional)"
                  />
                </FieldRow>
                <FieldRow label="Guild ID">
                  <SettingsInput
                    value={config.connectors?.discord?.guildId ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "guildId"], v.trim() || undefined)
                    }
                    placeholder="サーバー/Guild ID（任意）"
                  />
                </FieldRow>
                <FieldRow label="Channel ID">
                  <SettingsInput
                    value={config.connectors?.discord?.channelId ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "channelId"], v.trim() || undefined)
                    }
                    placeholder="このチャンネルに限定（右クリック → Copy Channel ID）"
                  />
                </FieldRow>

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-3)] mb-[var(--space-2)]"
                >
                  応答ゲート（respondTo）
                </div>
                {(["dm", "channel"] as const).map((scope) => (
                  <FieldRow
                    key={scope}
                    label={scope === "dm" ? "DM（1対1・グループ）" : "チャンネル/スレッド"}
                  >
                    <SettingsSelect
                      value={config.connectors?.discord?.respondTo?.[scope] ?? "always"}
                      onChange={(v) =>
                        updateConfig(
                          ["connectors", "discord", "respondTo", scope],
                          v as "always" | "mention" | "never",
                        )
                      }
                      options={[
                        { value: "always", label: "常に応答" },
                        { value: "mention", label: "@メンション/リプライ時のみ" },
                        { value: "never", label: "応答しない" },
                      ]}
                    />
                  </FieldRow>
                ))}
                <FieldRow label="参加済みスレッドは再メンション不要">
                  <ToggleSwitch
                    checked={config.connectors?.discord?.respondTo?.engagedThreads ?? true}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "respondTo", "engagedThreads"], v)
                    }
                  />
                </FieldRow>
                <FieldRow label="返信スタイル（平場チャンネル）">
                  <SettingsSelect
                    value={config.connectors?.discord?.replyStyle ?? "channel"}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "discord", "replyStyle"],
                        v as "channel" | "reply" | "thread",
                      )
                    }
                    options={[
                      { value: "channel", label: "そのままチャンネルへ" },
                      { value: "reply", label: "元メッセージにリプライ" },
                      { value: "thread", label: "スレッドを作成して返信" },
                    ]}
                  />
                </FieldRow>

                {/* Telegram */}
                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Telegram
                </div>
                <FieldRow label="Bot Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.telegram?.botToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "telegram", "botToken"], v)
                    }
                    placeholder="123456:ABC-DEF..."
                  />
                </FieldRow>
                <FieldRow label="許可ユーザー (User ID)">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.telegram?.allowFrom)
                      ? config.connectors?.telegram?.allowFrom?.join(", ")
                      : ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "telegram", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => Number(entry.trim())).filter((n) => !isNaN(n)) : undefined,
                      )
                    }
                    placeholder="Telegram の User ID をカンマ区切り（任意）"
                  />
                </FieldRow>
                <FieldRow label="起動時に古いメッセージを無視">
                  <ToggleSwitch
                    checked={config.connectors?.telegram?.ignoreOldMessagesOnBoot ?? true}
                    onChange={(v) =>
                      updateConfig(["connectors", "telegram", "ignoreOldMessagesOnBoot"], v)
                    }
                  />
                </FieldRow>

                {/* WhatsApp */}
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-4)] mb-[var(--space-2)]"
                >
                  WhatsApp
                </div>
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]"
                >
                  初回起動時、下のQRコードを WhatsApp アプリでスキャンして接続してください。認証情報は次回以降キャッシュされます。
                </div>
                <FieldRow label="認証ディレクトリ">
                  <SettingsInput
                    value={config.connectors?.whatsapp?.authDir ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "whatsapp", "authDir"], v.trim() || undefined)
                    }
                    placeholder="デフォルト: ~/.ryoko/.whatsapp-auth"
                  />
                </FieldRow>
                <FieldRow label="許可送信元">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.whatsapp?.allowFrom)
                      ? config.connectors?.whatsapp?.allowFrom?.join(", ")
                      : ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "whatsapp", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
                      )
                    }
                    placeholder="447700900000@s.whatsapp.net, ...（任意）"
                  />
                </FieldRow>

                {waQr && (
                  <div
                    className="mt-[var(--space-3)] flex flex-col items-center gap-[var(--space-2)]"
                  >
                    <div
                      className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-secondary)]"
                    >
                      WhatsApp でスキャンして接続
                    </div>
                    <img
                      src={waQr}
                      alt="WhatsApp QRコード"
                      className="w-[200px] h-[200px] rounded-[var(--radius-md)] border border-[var(--separator)] bg-white p-[8px]"
                    />
                    <div
                      className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
                    >
                      WhatsApp → リンク済み端末 → 端末をリンク
                    </div>
                  </div>
                )}
                {config.connectors?.whatsapp && waStatus === "ok" && (
                  <div
                    className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-green)] font-semibold"
                  >
                    ✓ 接続済み
                  </div>
                )}

                {/* Connector Instances */}
                <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />
                <div className="flex items-center justify-between mb-[var(--space-2)]">
                  <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
                    コネクタインスタンス
                  </div>
                  <div className="flex items-center gap-[var(--space-2)]">
                    <button
                      className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
                      onClick={async () => {
                        try {
                          const result = await api.reloadConnectors()
                          const parts: string[] = []
                          if (result.stopped.length) parts.push(`Stopped: ${result.stopped.join(", ")}`)
                          if (result.started.length) parts.push(`Started: ${result.started.join(", ")}`)
                          if (result.errors.length) parts.push(`Errors: ${result.errors.join(", ")}`)
                          alert(parts.length ? parts.join("\n") : "No connector instances to reload")
                        } catch {
                          alert("Failed to reload connectors")
                        }
                      }}
                    >
                      <RotateCcw size={12} />
                      Reload
                    </button>
                    <button
                      className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent)] hover:opacity-80 transition-opacity"
                      onClick={() => {
                        const instances = [...(config.connectors?.instances || [])]
                        const id = `discord-${instances.length + 1}`
                        instances.push({ id, type: "discord" })
                        updateConfig(["connectors", "instances"], instances)
                      }}
                    >
                      + Add Instance
                    </button>
                  </div>
                </div>
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
                  Add multiple connector instances of the same type, each bound to a specific employee.
                </div>
                {(config.connectors?.instances || []).map((instance: any, idx: number) => (
                  <div
                    key={instance.id || idx}
                    className="mb-[var(--space-4)] p-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg-secondary)]"
                  >
                    <div className="flex items-center justify-between mb-[var(--space-2)]">
                      <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                        {instance.id || `Instance ${idx + 1}`}
                      </div>
                      <button
                        className="text-[var(--system-red)] hover:opacity-80 transition-opacity p-[var(--space-1)]"
                        onClick={() => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances.splice(idx, 1)
                          updateConfig(["connectors", "instances"], instances.length > 0 ? instances : undefined)
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <FieldRow label="Instance ID">
                      <SettingsInput
                        value={instance.id ?? ""}
                        onChange={(v) => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances[idx] = { ...instances[idx], id: v }
                          updateConfig(["connectors", "instances"], instances)
                        }}
                        placeholder="e.g. discord-vox"
                      />
                    </FieldRow>
                    <FieldRow label="Type">
                      <SettingsSelect
                        value={instance.type ?? "discord"}
                        onChange={(v) => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances[idx] = { ...instances[idx], type: v as "discord" | "slack" | "whatsapp" }
                          updateConfig(["connectors", "instances"], instances)
                        }}
                        options={[
                          { value: "discord", label: "Discord" },
                          { value: "slack", label: "Slack" },
                          { value: "whatsapp", label: "WhatsApp" },
                        ]}
                      />
                    </FieldRow>
                    <FieldRow label="Employee">
                      <SettingsSelect
                        value={instance.employee ?? ""}
                        onChange={(v) => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances[idx] = { ...instances[idx], employee: v || undefined }
                          updateConfig(["connectors", "instances"], instances)
                        }}
                        options={[
                          { value: "", label: "Default (COO)" },
                          ...employees.map((e) => ({ value: e.name, label: e.displayName })),
                        ]}
                      />
                    </FieldRow>
                    {/* Type-specific fields */}
                    {(instance.type === "discord" || !instance.type) && (
                      <>
                        <FieldRow label="Bot Token">
                          <SettingsInput
                            type="password"
                            value={instance.botToken ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], botToken: v }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Bot token..."
                          />
                        </FieldRow>
                        <FieldRow label="Guild ID">
                          <SettingsInput
                            value={instance.guildId ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], guildId: v.trim() || undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Server/Guild ID"
                          />
                        </FieldRow>
                        <FieldRow label="Channel ID">
                          <SettingsInput
                            value={instance.channelId ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], channelId: v.trim() || undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Restrict to channel (optional)"
                          />
                        </FieldRow>
                        <FieldRow label="Allow From">
                          <SettingsInput
                            value={Array.isArray(instance.allowFrom) ? instance.allowFrom.join(", ") : instance.allowFrom ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], allowFrom: v.trim() ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="User IDs, comma-separated (optional)"
                          />
                        </FieldRow>
                      </>
                    )}
                    {instance.type === "slack" && (
                      <>
                        <FieldRow label="App Token">
                          <SettingsInput
                            type="password"
                            value={instance.appToken ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], appToken: v }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="xapp-..."
                          />
                        </FieldRow>
                        <FieldRow label="Bot Token">
                          <SettingsInput
                            type="password"
                            value={instance.botToken ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], botToken: v }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="xoxb-..."
                          />
                        </FieldRow>
                      </>
                    )}
                    {instance.type === "whatsapp" && (
                      <>
                        <FieldRow label="Auth Directory">
                          <SettingsInput
                            value={instance.authDir ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], authDir: v.trim() || undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Default: ~/.jinn/.whatsapp-auth"
                          />
                        </FieldRow>
                        <FieldRow label="Allow From">
                          <SettingsInput
                            value={Array.isArray(instance.allowFrom) ? instance.allowFrom.join(", ") : ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], allowFrom: v.trim() ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Phone JIDs, comma-separated"
                          />
                        </FieldRow>
                      </>
                    )}
                  </div>
                ))}

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Web UI
                </div>
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
                >
                  Web conversations use queued one-shot resume flow for both engines.
                </div>
              </Section>

              {/* -- Section 6: Cron -- */}
              <Section title="自動化の通知">
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]"
                >
                  ジョブの作成・有効化・実行は<a href="/cron" className="text-[var(--accent)] underline">自動化ページ</a>で行います。ここは通知の既定値だけを設定します。
                </div>
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Default Delivery
                </div>
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]"
                >
                  When a cron job has no delivery configured, results will be sent here.
                </div>
                <FieldRow label="Connector">
                  <SettingsSelect
                    value={config.cron?.defaultDelivery?.connector ?? ""}
                    onChange={(v) =>
                      updateConfig(["cron", "defaultDelivery", "connector"], v || undefined)
                    }
                    options={[
                      { value: "", label: "None (fire & forget)" },
                      { value: "web", label: "Web" },
                      { value: "slack", label: "Slack" },
                    ]}
                  />
                </FieldRow>
                {config.cron?.defaultDelivery?.connector && (
                  <FieldRow label="Channel">
                    <SettingsInput
                      value={config.cron?.defaultDelivery?.channel ?? ""}
                      onChange={(v) =>
                        updateConfig(["cron", "defaultDelivery", "channel"], v)
                      }
                      placeholder="#general"
                    />
                  </FieldRow>
                )}
                <UpdateNotificationSettings
                  connectorOptions={configuredConnectorIds(config)}
                  defaultConnector={config.cron?.defaultDelivery?.connector}
                  defaultChannel={config.cron?.defaultDelivery?.channel}
                />
              </Section>

              {/* -- Section 7: Logging -- */}
              <Section title="Logging">
                <FieldRow label="Level">
                  <SettingsSelect
                    value={config.logging?.level ?? "info"}
                    onChange={(v) => updateConfig(["logging", "level"], v)}
                    options={[
                      { value: "debug", label: "Debug" },
                      { value: "info", label: "Info" },
                      { value: "warn", label: "Warn" },
                      { value: "error", label: "Error" },
                    ]}
                  />
                </FieldRow>
                <FieldRow label="Stdout">
                  <ToggleSwitch
                    checked={config.logging?.stdout ?? true}
                    onChange={(v) => updateConfig(["logging", "stdout"], v)}
                  />
                </FieldRow>
                <FieldRow label="File Logging">
                  <ToggleSwitch
                    checked={config.logging?.file ?? false}
                    onChange={(v) => updateConfig(["logging", "file"], v)}
                  />
                </FieldRow>
              </Section>

              {/* -- Section 8: Voice Input (STT) -- */}
              <SttSettingsSection />

              {/* Save button for gateway config */}
              <div
                className="flex justify-end gap-[var(--space-3)] mb-[var(--space-6)]"
              >
                <button
                  onClick={() => loadConfig()}
                  className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-medium)] inline-flex items-center gap-[6px]"
                >
                  <RotateCcw size={14} />
                  再読み込み
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] inline-flex items-center gap-[6px] transition-all duration-150 ease-[var(--ease-smooth)]"
                  style={{
                    cursor: saving ? "wait" : "pointer",
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  <Save size={14} />
                  {saving ? "保存中…" : "設定を保存"}
                </button>
              </div>
            </>
          )}

          {/* -- Section 7: Reset -- */}
          <Section title="リセット">
            <div
              className="flex items-center justify-center gap-[var(--space-3)] flex-wrap"
            >
              <button
                onClick={() => {
                  localStorage.removeItem("jinn-onboarded")
                  window.location.reload()
                }}
                className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
              >
                <RotateCcw size={14} />
                オンボーディングを再実行
              </button>
              <button
                onClick={() => {
                  if (
                    window.confirm("すべての設定を初期値に戻しますか？")
                  ) {
                    localStorage.removeItem("jinn-settings")
                    localStorage.removeItem("jinn-theme")
                    resetAll()
                    window.location.reload()
                  }
                }}
                className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--system-red)] text-white border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
              >
                <Trash2 size={14} />
                すべての設定をリセット
              </button>
            </div>
          </Section>
        </div>
      </div>
    </PageLayout>
  )
}
