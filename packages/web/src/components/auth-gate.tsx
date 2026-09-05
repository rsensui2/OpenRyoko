"use client"

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { getAuthState, pairBrowser, type AuthState } from '@/lib/auth'

type Status = 'checking' | 'ready' | 'pairing-required' | 'pairing' | 'failed'

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking')
  const [authState, setAuthState] = useState<AuthState | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const state = await getAuthState()
      setAuthState(state)
      setStatus(!state.authRequired || state.authenticated ? 'ready' : 'pairing-required')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to check gateway access')
      setStatus('failed')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = code.trim()
    if (!trimmed) return
    setStatus('pairing')
    setError(null)
    try {
      await pairBrowser(trimmed)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid or expired pairing code')
      setStatus('pairing-required')
    }
  }

  if (status === 'ready') return <>{children}</>
  if (status === 'checking') {
    return <div className="flex min-h-dvh items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-tertiary)]">Checking gateway access…</div>
  }
  if (status === 'failed') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[var(--bg)] p-6 text-center text-[var(--text-primary)]">
        <p role="alert" className="text-sm text-[var(--system-red)]">{error}</p>
        <button type="button" onClick={() => { setStatus('checking'); void refresh() }} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)]">Retry</button>
      </div>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg)] p-4 text-[var(--text-primary)]">
      <section className="w-full max-w-md rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-6 shadow-[var(--shadow-card)]">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-full bg-[var(--accent-fill)] text-[var(--accent)]"><ShieldCheck size={22} /></span>
          <div>
            <h1 className="text-lg font-semibold">Pair This Browser</h1>
            <p className="text-xs text-[var(--text-tertiary)]">{authState?.networkExposed ? 'Network gateway' : 'Protected local gateway'}</p>
          </div>
        </div>
        <p className="mb-4 text-sm leading-relaxed text-[var(--text-secondary)]">
          On the computer running OpenRyoko, run <code className="rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5">ryoko pair</code>, then enter the single-use code below.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor="ryoko-pair-code" className="block text-xs font-semibold text-[var(--text-tertiary)]">Pairing code</label>
          <div className="flex h-11 items-center gap-2 rounded-md border border-[var(--separator)] bg-[var(--fill-tertiary)] px-3 focus-within:ring-2 focus-within:ring-[var(--accent)]">
            <KeyRound size={16} className="text-[var(--text-tertiary)]" />
            <input
              id="ryoko-pair-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              autoComplete="one-time-code"
              spellCheck={false}
              disabled={status === 'pairing'}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'ryoko-pair-error' : undefined}
              placeholder="ABCD-EFGH-JKLM"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm tracking-wider outline-none"
            />
          </div>
          {error ? <p id="ryoko-pair-error" role="alert" className="text-sm text-[var(--system-red)]">{error}</p> : null}
          <button type="submit" disabled={!code.trim() || status === 'pairing'} className="h-11 w-full rounded-md bg-[var(--accent)] text-sm font-semibold text-[var(--accent-contrast)] disabled:opacity-50">
            {status === 'pairing' ? 'Pairing…' : 'Pair Browser'}
          </button>
        </form>
      </section>
    </main>
  )
}
