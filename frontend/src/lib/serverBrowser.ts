import { API_URL, apiFetch } from '@/lib/api'

export type ServerBrowserStatus = 'starting' | 'ready' | 'stopped' | 'expired' | 'failed'

export type ServerBrowserSession = {
  id: string
  status: ServerBrowserStatus
  createdAt: string
  expiresAt: string
  endedAt: string | null
  lastSeenAt: string | null
}

export function statusLabel(status: ServerBrowserStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting'
    case 'ready':
      return 'Ready'
    case 'stopped':
      return 'Stopped'
    case 'expired':
      return 'Expired'
    case 'failed':
      return 'Failed'
  }
}

export function isActiveSession(status: ServerBrowserStatus): boolean {
  return status === 'starting' || status === 'ready'
}

export async function listServerBrowserSessions(): Promise<ServerBrowserSession[]> {
  const data = await apiFetch<{ sessions: ServerBrowserSession[] }>('/server-browser/sessions')
  return data.sessions ?? []
}

export async function createServerBrowserSession(): Promise<{ session: ServerBrowserSession; vncPassword: string }> {
  return apiFetch<{ session: ServerBrowserSession; vncPassword: string }>('/server-browser/sessions', { method: 'POST' })
}

export async function getServerBrowserSession(id: string): Promise<ServerBrowserSession> {
  const data = await apiFetch<{ session: ServerBrowserSession }>(`/server-browser/sessions/${id}`)
  return data.session
}

export async function stopServerBrowserSession(id: string): Promise<ServerBrowserSession> {
  const data = await apiFetch<{ session: ServerBrowserSession }>(`/server-browser/sessions/${id}`, { method: 'DELETE' })
  return data.session
}

export async function mintServerBrowserViewToken(id: string): Promise<{ token: string; expiresAt: string }> {
  return apiFetch<{ token: string; expiresAt: string }>(`/server-browser/sessions/${id}/view-token`, { method: 'POST' })
}

/**
 * Iframe URL for the embedded remote browser. Carries ONLY the short-lived
 * one-time display token — never the app access token.
 */
export function displayUrl(sessionId: string, token: string): string {
  return `${API_URL}/server-browser/sessions/${sessionId}/display/?token=${encodeURIComponent(token)}`
}
