/**
 * Connected-account status helpers shared by the account surfaces
 * (Settings, Quota Tracker, Remote Imports). `reauth_required` means the
 * Google auth was rejected (invalid_grant) and the account needs a reconnect.
 */

export type ConnectedAccountStatus = string

export function isReauthRequired(account: { status: ConnectedAccountStatus }): boolean {
  return account.status === 'reauth_required'
}

/**
 * A Telegram account is only usable for storage once a private storage
 * channel is configured. Channel-less Telegram accounts are hidden from
 * quota/storage surfaces (Settings is where the channel gets set up).
 */
export function isStorageReady(account: { provider?: string; telegram?: { channelId?: string | null } | null }): boolean {
  return account.provider !== 'telegram' || Boolean(account.telegram?.channelId)
}

export function accountStatusLabel(status: ConnectedAccountStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'reauth_required':
      return 'Reconnection Required'
    case 'disconnected':
      return 'Disconnected'
    default:
      return status
  }
}

export const REAUTH_MESSAGE = 'Google authorization is no longer valid. Reconnect this account to resume uploads and synchronization.'

export const TELEGRAM_REAUTH_MESSAGE = 'The Telegram session is no longer valid. Reconnect this account to resume uploads and synchronization.'

/** Reauth guidance copy per provider — Telegram sessions and Google OAuth
 * grants expire differently and must not show each other's message. */
export function reauthMessage(account: { provider?: string }): string {
  return account.provider === 'telegram' ? TELEGRAM_REAUTH_MESSAGE : REAUTH_MESSAGE
}