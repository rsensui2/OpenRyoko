import { describe, expect, it, vi } from 'vitest'
import { getAuthState, pairBrowser } from '../auth'

describe('browser auth client', () => {
  it('reads public auth state with same-origin credentials', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ authRequired: true, authenticated: false, networkExposed: true }), { status: 200 }))
    await expect(getAuthState(fetchImpl as typeof fetch)).resolves.toMatchObject({ authRequired: true, authenticated: false })
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/state', { credentials: 'same-origin' })
  })

  it('submits a pairing code without storing it in browser storage', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    await pairBrowser('ABCD-EFGH-JKLM', fetchImpl as typeof fetch)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(String(fetchImpl.mock.calls[0][1]?.body)).toContain('ABCD-EFGH-JKLM')
  })
})
