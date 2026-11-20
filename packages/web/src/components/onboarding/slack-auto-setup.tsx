"use client"

/**
 * Slack in four guided steps, each with a picture of the Slack screen it
 * sends the person to: name and picture → paste one configuration refresh
 * token (the gateway creates the app) → allow it in Slack → paste the Socket
 * Mode app token (Slack has no API that makes one). Slack only returns the
 * installer to HTTPS, so a gateway opened over http hands Slack a static relay
 * page that forwards the browser back here (see site/slack/callback).
 */

import { useEffect, useState, type ReactNode } from "react"
import { Check, ExternalLink, Loader2 } from "lucide-react"
import { api, type SlackAppStatus, type SlackProvisionResult } from "@/lib/api"
import { SlackIconPicker } from "./slack-icon-picker"
import { GuideList, GuideShot, GuideStep } from "./slack-guide"
import { describeConnectOutcome, describeProvisionError } from "./slack-messages"

const SLACK_APPS_URL = "https://api.slack.com/apps"
const CALLBACK_PATH = "/api/onboarding/slack/oauth/callback"
const SHOTS = "/guide/slack"
const POLL_MS = 2_000
/** The install link's state lives 30 minutes on the gateway; stop asking after that. */
const POLL_LIMIT_MS = 30 * 60_000
const NAME_MAX = 35

const inputClass = "apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"
const labelClass = "block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
const noteClass = "text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
const linkishClass = "bg-transparent border-none p-0 underline cursor-pointer text-inherit"

type Created = Extract<SlackProvisionResult, { ok: true }>
type Result = { ok: boolean; message: string } | null

/** Where Slack sends the installer back: our own callback over HTTPS, else the relay page returns to this origin. */
function returnRoute(): { redirectUrl?: string; returnTo?: string } {
  if (typeof window === "undefined") return {}
  return window.location.protocol === "https:"
    ? { redirectUrl: `${window.location.origin}${CALLBACK_PATH}` }
    : { returnTo: window.location.origin }
}

function PrimaryButton({ busy, disabled, onClick, children }: { busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const off = Boolean(busy || disabled)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-md)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]"
      style={{ background: off ? "var(--fill-tertiary)" : "var(--accent)", color: off ? "var(--text-tertiary)" : "var(--accent-contrast)" }}
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : null}
      {children}
    </button>
  )
}

function LinkButton({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center justify-center gap-1.5 self-start px-4 py-2 rounded-[var(--radius-md)] border text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] no-underline"
      style={primary
        ? { background: "var(--accent)", color: "var(--accent-contrast)", borderColor: "var(--accent)" }
        : { borderColor: "var(--separator)", color: "var(--text-primary)" }}>
      {children} <ExternalLink size={14} />
    </a>
  )
}

function ResultLine({ result }: { result: Result }) {
  if (!result) return null
  return (
    <div className="text-[length:var(--text-footnote)] whitespace-pre-wrap" style={{ color: result.ok ? "var(--system-green)" : "var(--system-red)" }}>
      {result.message}
    </div>
  )
}

function SecretInput({ label, prefix, value, onChange, placeholder }: { label: string; prefix: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const wrong = value !== "" && !value.startsWith(prefix)
  return (
    <div>
      <label className={labelClass}>{label} <span className="text-[var(--text-quaternary)]">{prefix}…</span></label>
      <input type="password" className={inputClass} value={value} onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder ?? prefix} autoComplete="off" spellCheck={false} aria-label={label} />
      {wrong ? <div className="text-[length:var(--text-caption1)] text-[var(--system-orange)] mt-1">{prefix} で始まる文字列を貼ってください。</div> : null}
    </div>
  )
}

function CreateSteps({ bot, defaultName, status, onCreated, onRefresh }: {
  bot?: string
  defaultName: string
  status: SlackAppStatus | null
  onCreated: (app: Created) => void
  /** Re-read what the gateway kept: a failed attempt may still have rotated the token. */
  onRefresh: () => void
}) {
  const [name, setName] = useState((status?.name ?? defaultName).slice(0, NAME_MAX))
  const [fresh, setFresh] = useState(false)
  const [icon, setIcon] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const reuse = Boolean(status?.hasConfigToken) && !token
  const canSubmit = Boolean(name.trim()) && (reuse || token.startsWith("xoxe-"))

  const submit = async () => {
    setBusy(true)
    setResult(null)
    try {
      const outcome = await api.provisionSlackApp({ name: name.trim(), refreshToken: token || undefined, icon: icon ?? undefined, fresh, bot, ...returnRoute() })
      // Slack saw it: the token is spent (rotated) or refused either way.
      setToken("")
      if (outcome.ok) {
        onCreated(outcome)
      } else {
        setResult({ ok: false, message: describeProvisionError(outcome.error) })
        onRefresh()
      }
    } catch (err) {
      // A refused request (400) never reached Slack: keep what was typed.
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <GuideStep n={1} title="Slack での名前とアイコンを決める" state="active">
        <div>
          <label className={labelClass} htmlFor="ob-slack-name">名前</label>
          <input id="ob-slack-name" className={inputClass} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        <SlackIconPicker name={name} onChange={setIcon} />
      </GuideStep>

      <GuideStep n={2} title="Slack の「設定トークン」を貼る" state="active">
        <p className="m-0 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          このトークン1つで、OpenRyoko が Slack アプリを自動で作ります。ボタンで Slack のアプリ管理画面を開き、ページのいちばん下にある欄を使います。
        </p>
        <LinkButton href={SLACK_APPS_URL}>Slack のアプリ管理画面を開く</LinkButton>
        <GuideList items={[
          <>ページ下の「Your App Configuration Tokens」で「<b>Generate Token</b>」を押す。出てきた画面でワークスペースを選び、「Generate」を押す</>,
          <>表に行が増えるので、その行の <b>Refresh Token</b> の「<b>Copy</b>」を押す（Access Token ではありません）</>,
        ]} />
        <GuideShot src={`${SHOTS}/config-token-list.png`} alt="Your App Configuration Tokens の欄" caption="ページのいちばん下にある欄" />
        <div className="max-w-[360px]">
          <GuideShot src={`${SHOTS}/config-token-generate.png`} alt="ワークスペースを選ぶ画面" caption="1 で出てくる画面。ワークスペースを選んで Generate" />
        </div>
        <SecretInput label="コピーした Refresh Token" prefix="xoxe-" value={token} onChange={setToken}
          placeholder={status?.hasConfigToken ? "さっき失敗したときのトークンを使います（貼り直し不要）" : undefined} />
        {status?.appId && !status.canUpdateApp && (
          <p className={noteClass}>前回のアプリ（{status.appId}）は Slack との接続まで済んでいるので、ここからは更新できません。もう一度設定すると、新しいアプリを作ります。前のアプリが要らなければ、Slack のアプリ管理画面で削除してください。</p>
        )}
        {status?.appId && status.canUpdateApp && (
          <label className="flex items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
            前回作ったアプリ（{status.appId}）を更新せず、新しいアプリとして作る
          </label>
        )}
        <div><PrimaryButton busy={busy} disabled={!canSubmit} onClick={submit}>{busy ? "Slack アプリを作成中…" : "Slack アプリを作る"}</PrimaryButton></div>
        <ResultLine result={result} />
        <p className={noteClass}>トークンはアプリを作り終えたらすぐ消します（作るのに失敗したときだけ、やり直し用に残します）。Slack との接続が済んだあとに名前やアイコンを変えるときは、Slack のアプリ管理画面（Basic Information）で変えてください。使い終わった設定トークンは、上の「Your App Configuration Tokens」の欄で削除できます。</p>
      </GuideStep>
    </>
  )
}

function useInstalledPoll(active: boolean, since: number, bot?: string): boolean {
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    if (!active || installed) return
    const timer = setInterval(() => {
      if (Date.now() - since > POLL_LIMIT_MS) { clearInterval(timer); return }
      api.getSlackApp(bot).then((status) => { if (status.installed) setInstalled(true) }).catch(() => { /* keep polling */ })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [active, installed, since, bot])
  return installed
}

function InstallSteps({ app, bot, onDone }: { app: Created; bot?: string; onDone: () => void }) {
  const [installUrl, setInstallUrl] = useState(app.installUrl)
  const [linkIssuedAt, setLinkIssuedAt] = useState(() => Date.now())
  const [pasteBot, setPasteBot] = useState(!app.installUrl)
  const automatic = Boolean(installUrl) && !pasteBot
  const installed = useInstalledPoll(automatic, linkIssuedAt, bot)
  const [botToken, setBotToken] = useState("")
  const [appToken, setAppToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const haveBot = automatic ? installed : botToken.startsWith("xoxb-")
  const canConnect = haveBot && appToken.startsWith("xapp-")

  const reissue = async () => {
    setResult(null)
    try {
      const outcome = await api.reissueSlackInstallUrl(bot)
      if (outcome.ok) { setInstallUrl(outcome.installUrl); setLinkIssuedAt(Date.now()) }
      else setResult({ ok: false, message: describeProvisionError(outcome.error) })
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const connect = async () => {
    setBusy(true)
    setResult(null)
    try {
      const outcome = await api.finishSlack(appToken, automatic ? undefined : botToken, bot)
      const described = outcome.stage || outcome.ok ? describeConnectOutcome(outcome) : { ok: false, message: describeProvisionError(outcome.error ?? "") }
      setResult(described)
      if (described.ok) onDone()
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <GuideStep n={3} title="Slack で「許可する」を押す" state={haveBot ? "done" : "active"} summary="Slack への追加が済みました。">
        {automatic ? (
          <>
            <p className="m-0 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">新しいタブで Slack が開きます。「<b>許可する</b>」を押すと、この画面に自動で戻ってきます。</p>
            <LinkButton href={installUrl!} primary>Slack で許可する</LinkButton>
            <GuideShot src={`${SHOTS}/install-allow.png`} alt="Slack の許可画面" caption="開く画面（右下の「許可する」を押す）" />
            <div className={noteClass}>
              <Loader2 size={12} className="animate-spin inline mr-1" />許可を待っています…
              <button type="button" className={linkishClass} onClick={reissue}>リンクを作り直す</button>
              <button type="button" className={linkishClass} onClick={() => setPasteBot(true)}>自動で戻らないときは Bot Token を貼る</button>
            </div>
          </>
        ) : (
          <>
            <GuideList items={[
              <>下のボタンで開くページの「<b>Install to Workspace</b>」を押し、続く画面で「<b>許可する</b>」を押す</>,
              <>戻った画面の <b>Bot User OAuth Token</b>（xoxb- で始まる）の「Copy」を押して下に貼る（<a href={app.pages.oauth} target="_blank" rel="noopener noreferrer">OAuth &amp; Permissions</a> でも確認できます）</>,
            ]} />
            <LinkButton href={app.pages.install}>Slack にインストールする</LinkButton>
            <SecretInput label="Bot User OAuth Token" prefix="xoxb-" value={botToken} onChange={setBotToken} />
          </>
        )}
      </GuideStep>

      <GuideStep n={4} title="接続用のトークン（App-Level Token）を作って貼る" state={haveBot ? "active" : "todo"}>
        <p className="m-0 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">OpenRyoko が Slack とつながり続けるためのトークンです。Slack にはこれを自動で作る仕組みがないので、ここだけ手で作ります。</p>
        <LinkButton href={app.pages.appToken}>アプリの設定ページを開く</LinkButton>
        <GuideList items={[
          <>「App-Level Tokens」の「<b>Generate Token and Scopes</b>」を押す</>,
          <>名前を入れる（何でも構いません。例: ryoko）</>,
          <>「Add Scope」で <b>connections:write</b> を選ぶ</>,
          <>「<b>Generate</b>」を押し、表示された xapp- で始まるトークンの「Copy」を押して下に貼る</>,
        ]} />
        <div className="grid gap-[var(--space-2)] sm:grid-cols-2">
          <GuideShot src={`${SHOTS}/app-token-section.png`} alt="App-Level Tokens の欄" caption="ページの中ほど" />
          <GuideShot src={`${SHOTS}/app-token-generate.png`} alt="App-Level Token を作る画面" caption="名前・connections:write・Generate" />
        </div>
        <SecretInput label="App-Level Token" prefix="xapp-" value={appToken} onChange={setAppToken} />
        <div><PrimaryButton busy={busy} disabled={!canConnect} onClick={connect}>{busy ? "確認して接続中…" : "接続する"}</PrimaryButton></div>
        <ResultLine result={result} />
      </GuideStep>
      {!haveBot && <ResultLine result={result} />}
    </>
  )
}

function createdSummary(app: Created): ReactNode {
  return (
    <>
      Slack アプリを{app.created ? "作成" : "更新"}しました（{app.appId}）。
      {typeof app.icon === "object" ? <> アイコンは設定できませんでした（{app.icon.error}）。<a href={app.pages.settings} target="_blank" rel="noopener noreferrer">アプリの設定ページ</a>から変更できます。</> : null}
    </>
  )
}

/** `bot` = which Ryoko's Slack app (omitted = the main one); `behaviorHref` =
 *  where "decide when it talks" leads once connected. */
export function SlackAutoSetup({ defaultName, bot, behaviorHref = "/settings" }: { defaultName: string; bot?: string; behaviorHref?: string }) {
  const [status, setStatus] = useState<SlackAppStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [app, setApp] = useState<Created | null>(null)
  const [done, setDone] = useState(false)

  const refresh = () => {
    api.getSlackApp(bot).then(setStatus).catch(() => { /* keep the last answer */ }).finally(() => setLoaded(true))
  }
  useEffect(refresh, [])

  if (!loaded) return <div className={noteClass}><Loader2 size={14} className="animate-spin inline" /> 確認中…</div>
  if (done) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--system-green)] p-[var(--space-4)] flex items-start gap-[var(--space-2)]">
        <Check size={18} className="text-[var(--system-green)] shrink-0 mt-0.5" />
        <div className="flex flex-col gap-1 text-[length:var(--text-subheadline)] text-[var(--text-primary)]">
          <span>つながりました。Slack で bot に DM を送るか、チャンネルに招待してメンションしてみてください。</span>
          <a href={behaviorHref} className="text-[length:var(--text-footnote)]">次に、チャンネルでいつ話すか（メンションだけ・空気読みなど）を決める →</a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[var(--space-3)]">
      {app ? (
        <>
          <GuideStep n={1} title="Slack での名前とアイコンを決める" state="done" summary={app.appId ? "設定しました。" : null} />
          <GuideStep n={2} title="Slack の「設定トークン」を貼る" state="done" summary={createdSummary(app)} />
          <InstallSteps app={app} bot={bot} onDone={() => setDone(true)} />
        </>
      ) : (
        <>
          <CreateSteps bot={bot} defaultName={defaultName} status={status} onCreated={setApp} onRefresh={refresh} />
          <GuideStep n={3} title="Slack で「許可する」を押す" state="todo" />
          <GuideStep n={4} title="接続用のトークン（App-Level Token）を作って貼る" state="todo" />
        </>
      )}
    </div>
  )
}
