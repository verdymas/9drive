/**
 * Connected-account status helpers shared by the account surfaces
 * (Settings, Quota Tracker, Remote Imports). `reauth_required` means the
 * Google auth was rejected (invalid_grant) and the account needs a reconnect.
 */

export type ConnectedAccountStatus = string

export function isReauthRequired(account: { status: ConnectedAccountStatus }): boolean {
  return account.status === 'reauth_required'
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