/**
 * StorageProtocol — the abstraction every storage protocol integration (SMB,
 * FTP, SFTP, NFS, S3, ...) can implement so the REST API and the UI speak to
 * the same interface.
 *
 * 9Drive never implements a file protocol itself. Implementations wrap an
 * external daemon/service (e.g. Samba's smbd) and manage its configuration.
 */

/** State of the underlying server service. */
export type ProtocolStatus = 'running' | 'stopped' | 'reload_required' | 'config_error' | 'unavailable'

export type ProtocolHealth = {
  available: boolean
  status: ProtocolStatus
  version?: string | null
  service?: string | null
  configPath?: string | null
  message?: string
  connectedUsers?: number
}

export type ProtocolShare = {
  id: string
  name: string
  path: string
  description: string
  readOnly: boolean
  guestAccess: boolean
  browsable: boolean
  validUsers: string[]
  validGroups: string[]
  hideFiles: string
}

export type ProtocolUser = {
  id: string
  name: string
  enabled: boolean
}

/** Options shared by every protocol implementation. */
export type ProtocolContext = {
  /** Absolute path to the protocol's own configuration file. */
  configPath: string
}

export interface StorageProtocol {
  /** Whether the protocol is usable in this environment (e.g. daemon installed). */
  detect(): Promise<ProtocolHealth>
  status(): Promise<ProtocolHealth>
  listShares(): Promise<ProtocolShare[]>
  createShare(share: Omit<ProtocolShare, 'id'>): Promise<ProtocolShare>
  updateShare(id: string, patch: Partial<ProtocolShare>): Promise<ProtocolShare>
  deleteShare(id: string): Promise<void>
  listUsers(): Promise<ProtocolUser[]>
  createUser(name: string, password: string): Promise<ProtocolUser>
  updateUser(id: string, patch: { password?: string; enabled?: boolean }): Promise<ProtocolUser>
  deleteUser(id: string): Promise<void>
  /** Validate + apply configuration, reloading the daemon; rolls back on failure. */
  reload(): Promise<{ ok: true; message: string } | { ok: false; message: string }>
}
