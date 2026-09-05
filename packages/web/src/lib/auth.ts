export interface AuthState {
  authRequired: boolean
  authenticated: boolean
  networkExposed: boolean
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (body.error) return String(body.error)
  } catch { /* use status fallback */ }
  return `Authentication failed (${response.status})`
}

export async function getAuthState(fetchImpl: typeof fetch = fetch): Promise<AuthState> {
  const response = await fetchImpl('/api/auth/state', { credentials: 'same-origin' })
  if (!response.ok) throw new Error(await errorMessage(response))
  return response.json() as Promise<AuthState>
}

export async function pairBrowser(code: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl('/api/auth/pair', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) throw new Error(await errorMessage(response))
}
