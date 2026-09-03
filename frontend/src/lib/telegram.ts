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
