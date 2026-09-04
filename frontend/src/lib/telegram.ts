import { apiFetch } from './api'

export type TelegramChannelStatus = 'storage_channel_required' | 'connected' | 'authentication_required' | 'ready' | 'error'

export type TelegramChannelInfo = {
  channelId: string
  channelTitle: string | null
  status: TelegramChannelStatus
}

export type TelegramChannelCandidate = {
  channelId: string
  title: string
}

export type TelegramConnectionTest = {
  ok: boolean
  status: TelegramChannelStatus
  checks?: {
    account: boolean
    channel: boolean | null
    read: boolean | null
    write: boolean | null
    delete: boolean | null
  }
  details?: string
}

export async function listTelegramChannels(accountId: string): Promise<{ channels: TelegramChannelCandidate[] }> {
  return apiFetch(`/telegram/accounts/${accountId}/channels`)
}

export async function createTelegramChannel(accountId: string, title?: string): Promise<{ account: { telegram: TelegramChannelInfo } }> {
  return apiFetch(`/telegram/accounts/${accountId}/channel`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', title }),
  })
}

export async function selectTelegramChannel(accountId: string, channelId: string): Promise<{ account: { telegram: TelegramChannelInfo } }> {
  return apiFetch(`/telegram/accounts/${accountId}/channel`, {
    method: 'POST',
    body: JSON.stringify({ action: 'select', channelId }),
  })
}

export async function testTelegramConnection(accountId: string): Promise<TelegramConnectionTest> {
  return apiFetch(`/telegram/accounts/${accountId}/test`, { method: 'POST' })
}

export function telegramChannelStatusLabel(status: TelegramChannelStatus): string {
  switch (status) {
    case 'storage_channel_required':
      return 'Storage Channel Required'
    case 'authentication_required':
      return 'Reconnection Required'
    case 'ready':
      return 'Ready'
    case 'error':
      return 'Connection Error'
    case 'connected':
      return 'Connected'
  }
}

// ── Metadata security ───────────────────────────────────────────────────
// The master key lives only on the backend; the UI never sends or receives
// it. `status` is the only thing surfaced about the key's configuration.

export type TelegramSecurityStatus = {
  encryption: 'configured' | 'notConfigured' | 'invalid'
  filenameObfuscation: 'enabled' | 'disabled'
  extensionObfuscation: boolean
}

export type TelegramEncryptedCaption = {
  caption: string
  metaLine: string
  physicalFilename: string | null
}

export async function getTelegramSecurityStatus(): Promise<TelegramSecurityStatus> {
  return apiFetch('/telegram/security/status')
}

/** Build the caption a user pastes into Telegram to repair lost metadata. */
export async function buildTelegramEncryptedCaption(fileId: string): Promise<TelegramEncryptedCaption> {
  return apiFetch('/telegram/security/encrypt', { method: 'POST', body: JSON.stringify({ fileId }) })
}

export async function decryptTelegramMetadata(payload: string): Promise<{ metadata: { name: string; path: string | null; mimeType?: string; size?: string } }> {
  return apiFetch('/telegram/security/decrypt', { method: 'POST', body: JSON.stringify({ payload }) })
}

/** Rewrite one file's plaintext caption as an encrypted caption (metadata only). */
export async function convertTelegramCaptionToEncrypted(fileId: string): Promise<{ changed: boolean; channelId: string; messageId: number }> {
  return apiFetch('/telegram/security/convert-legacy', { method: 'POST', body: JSON.stringify({ fileId }) })
}

export function telegramEncryptionLabel(status: TelegramSecurityStatus['encryption']): string {
  switch (status) {
    case 'configured':
      return 'Configured'
    case 'invalid':
      return 'Invalid Key'
    case 'notConfigured':
      return 'Not Configured'
  }
}
