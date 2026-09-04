import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { AppError } from '../../utils/app-error.js'

/**
 * Telegram metadata protection — opaque physical filenames + recoverable
 * encrypted metadata.
 *
 * The 9Drive DB remains the canonical logical state. Telegram metadata is a
 * cached recovery representation, encrypted at rest on the message and
 * re-encrypted only when the canonical recovery metadata changes.
 *
 * Crypto primitives (no custom schemes):
 *   - Key derivation: HKDF-SHA256 from `TELEGRAM_METADATA_MASTER_KEY` with
 *     domain-separated labels for the filename HMAC key and the AES key.
 *   - Physical filename: HMAC-SHA256(filenameKey, fileId) → `tg_<hex>.bin`
 *     (stable across rename/move; exposes nothing about the logical name).
 *   - Metadata encryption: AES-256-GCM, random 12-byte IV per encryption,
 *     serialized `base64url(iv):base64url(tag):base64url(ciphertext)`,
 *     captioned as `9drive:meta=v1:<payload>`.
 *
 * Never log or expose the master key, derived keys, or IVs.
 */

export const TELEGRAM_CRYPTO_VERSION = 'v1'
export const NINE_DRIVE_META_KEY = '9drive:meta'
export const NINE_DRIVE_META_PREFIX = `${NINE_DRIVE_META_KEY}=`

/** Failure codes (spec §47). */
export const TELEGRAM_CRYPTO_ERROR_CODES = {
  KEY_NOT_CONFIGURED: 'TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED',
  KEY_INVALID: 'TELEGRAM_CRYPTO_KEY_INVALID',
  ENCRYPT_FAILED: 'TELEGRAM_METADATA_ENCRYPT_FAILED',
  DECRYPT_FAILED: 'TELEGRAM_METADATA_DECRYPT_FAILED',
  MALFORMED: 'TELEGRAM_METADATA_MALFORMED',
  UNSUPPORTED_VERSION: 'TELEGRAM_METADATA_UNSUPPORTED_VERSION',
} as const

/** Recovery-relevant canonical metadata encrypted into the caption. */
export type RecoveryMetadata = {
  name: string
  path: string | null
  mimeType?: string | null
  size?: bigint | number | string | null
}

export type TelegramCryptoStatus = {
  encryption: 'configured' | 'notConfigured' | 'invalid'
  filenameObfuscation: 'enabled' | 'disabled'
  extensionObfuscation: boolean
}

export function telegramCryptoEnabled(): boolean {
  return env.TELEGRAM_METADATA_ENCRYPTION_ENABLED
}

export function telegramObfuscateFilenameEnabled(): boolean {
  return env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED
}

export function telegramObfuscateExtensionEnabled(): boolean {
  return env.TELEGRAM_OBFUSCATE_FILE_EXTENSION
}

/**
 * Master-key validation. `TELEGRAM_METADATA_MASTER_KEY` must be present and
 * at least 32 characters when encryption is enabled — fail safely, never
 * auto-generate and never silently fall back to plaintext for protected
 * uploads (spec §33).
 */
export function telegramCryptoStatus(): TelegramCryptoStatus {
  const key = env.TELEGRAM_METADATA_MASTER_KEY
  const encryption = !env.TELEGRAM_METADATA_ENCRYPTION_ENABLED
    ? 'notConfigured' as const
    : !key
      ? 'notConfigured' as const
      : key.length < 32
        ? 'invalid' as const
        : 'configured' as const
  return {
    encryption,
    filenameObfuscation: env.TELEGRAM_OBFUSCATE_FILENAME_ENABLED ? 'enabled' : 'disabled',
    extensionObfuscation: env.TELEGRAM_OBFUSCATE_FILE_EXTENSION,
  }
}

/**
 * Assert the master key itself is usable. Filename obfuscation needs a valid
 * key but NOT `TELEGRAM_METADATA_ENCRYPTION_ENABLED` — the two toggles are
 * independent. Never auto-generate, never fall back to plaintext names.
 */
export function assertTelegramMasterKey(): void {
  const key = env.TELEGRAM_METADATA_MASTER_KEY
  if (!key) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.KEY_NOT_CONFIGURED, 'TELEGRAM_METADATA_MASTER_KEY is not configured.', 500)
  }
  if (key.length < 32) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.KEY_INVALID, 'TELEGRAM_METADATA_MASTER_KEY must be at least 32 characters.', 500)
  }
}

/** Assert crypto is usable for protected writes; throws typed AppError. */
export function assertTelegramCryptoReady(): void {
  if (!env.TELEGRAM_METADATA_ENCRYPTION_ENABLED) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.KEY_NOT_CONFIGURED, 'Telegram metadata encryption is not enabled.', 409)
  }
  assertTelegramMasterKey()
}

/** Domain-separated HKDF-SHA256 subkey from the master key. */
function deriveSubkey(info: string, length = 32): Buffer {
  assertTelegramMasterKey()
  const derived = crypto.hkdfSync('sha256', Buffer.from(env.TELEGRAM_METADATA_MASTER_KEY!, 'utf8'), Buffer.from(env.TELEGRAM_CRYPTO_SALT, 'utf8'), info, length)
  return Buffer.from(derived)
}

let filenameKeyCache: Buffer | null = null
function filenameKey(): Buffer {
  filenameKeyCache ??= deriveSubkey('9drive:telegram:filename:v1')
  return filenameKeyCache
}

let metadataKeyCache: Buffer | null = null
function metadataKey(): Buffer {
  metadataKeyCache ??= deriveSubkey('9drive:telegram:metadata:v1')
  return metadataKeyCache
}

/**
 * Opaque physical filename for a Telegram document: `tg_<hex>.bin` (or
 * `tg_<hex>.<ext>` when extension obfuscation is disabled). Deterministic
 * per file id + key — stable across rename/move (spec §27-§28).
 */
export function generatePhysicalFilename(fileId: string, logicalName?: string | null): string {
  const hex = crypto.createHmac('sha256', filenameKey()).update(fileId, 'utf8').digest('hex').slice(0, 32)
  if (env.TELEGRAM_OBFUSCATE_FILE_EXTENSION) return `tg_${hex}.bin`
  const ext = logicalName ? logicalName.split('.').pop() : undefined
  return ext && /^[A-Za-z0-9]{1,16}$/.test(ext) ? `tg_${hex}.${ext}` : `tg_${hex}.bin`
}

/**
 * Deterministic fingerprint of the canonical recovery metadata. NOT a
 * security boundary — only cache invalidation / change detection
 * (spec §6). Rename/move change it; a changed fingerprint triggers
 * re-encryption once.
 */
export function calculateMetadataFingerprint(input: {
  fileId: string
  name: string
  path: string | null
  mimeType?: string | null
  size?: bigint | number | string | null
}): string {
  const size = input.size == null ? '' : String(input.size)
  const payload = `${TELEGRAM_CRYPTO_VERSION}|${input.fileId}|${input.path ?? ''}|${input.name}|${input.mimeType ?? ''}|${size}`
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** Serialize the canonical recovery metadata into a stable JSON string. */
export function buildRecoveryMetadata(meta: RecoveryMetadata): string {
  return JSON.stringify({
    name: meta.name,
    path: meta.path ?? null,
    ...(meta.mimeType != null ? { mimeType: meta.mimeType } : {}),
    ...(meta.size != null ? { size: String(meta.size) } : {}),
  })
}

/** AES-256-GCM encrypt (random 12-byte IV) → `base64url(iv):base64url(tag):base64url(cipher)`. */
export function encryptMetadata(plaintext: string): string {
  assertTelegramCryptoReady()
  try {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', metadataKey(), iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`
  } catch (error) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.ENCRYPT_FAILED, `Telegram metadata encryption failed. ${error instanceof Error ? error.message.slice(0, 100) : ''}`, 500)
  }
}

/** AES-256-GCM decrypt; auth-tag failure (tamper or wrong key) throws a typed error. */
export function decryptMetadata(payload: string): string {
  assertTelegramCryptoReady()
  const parts = payload.split(':')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.MALFORMED, 'The encrypted Telegram metadata payload is malformed.', 400)
  }
  const [ivRaw, tagRaw, encryptedRaw] = parts
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', metadataKey(), Buffer.from(ivRaw, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.DECRYPT_FAILED, 'Telegram metadata decryption failed. The payload is tampered with or the master key is wrong.', 400)
  }
}

/** Detect the version prefix of an encrypted payload (`v1:`). Returns null when absent. */
export function detectMetadataVersion(payload: string): string | null {
  const idx = payload.indexOf(':')
  if (idx <= 0) return null
  const version = payload.slice(0, idx)
  return /^v\d+$/.test(version) ? version : null
}

/** Parse an encrypted payload into canonical recovery metadata. Accepts a
 *  raw payload (`v1:<encrypted>`) or the full caption line
 *  (`9drive:meta=v1:<encrypted>`). Throws typed errors. */
export function decryptRecoveryMetadata(payload: string): RecoveryMetadata {
  const stripped = stripMetaKeyPrefix(payload)
  const version = detectMetadataVersion(stripped)
  if (version !== TELEGRAM_CRYPTO_VERSION) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.UNSUPPORTED_VERSION, `Unsupported Telegram metadata version "${version ?? 'unknown'}".`, 400)
  }
  const raw = stripped.slice(version.length + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(decryptMetadata(raw))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.MALFORMED, 'The decrypted Telegram metadata is not valid JSON.', 400)
  }
  const obj = parsed as { name?: unknown; path?: unknown; mimeType?: unknown; size?: unknown }
  if (typeof obj?.name !== 'string' || obj.name.length === 0 || obj.name.length > 255) {
    throw new AppError(TELEGRAM_CRYPTO_ERROR_CODES.MALFORMED, 'The decrypted Telegram metadata is missing a valid name.', 400)
  }
  return {
    name: obj.name,
    path: typeof obj.path === 'string' && obj.path.length > 0 ? obj.path : null,
    ...(obj.mimeType != null ? { mimeType: String(obj.mimeType) } : {}),
    ...(obj.size != null ? { size: String(obj.size) } : {}),
  }
}

/** Build a full `9drive:meta=v1:<payload>` line from canonical recovery metadata. */
export function serializeTelegramMetaLine(meta: RecoveryMetadata): string {
  return `${NINE_DRIVE_META_PREFIX}${TELEGRAM_CRYPTO_VERSION}:${encryptMetadata(buildRecoveryMetadata(meta))}`
}

/** Extract the raw encrypted payload from a `9drive:meta=...` caption line (or raw payload). */
export function stripMetaKeyPrefix(line: string): string {
  return line.startsWith(NINE_DRIVE_META_PREFIX) ? line.slice(NINE_DRIVE_META_PREFIX.length) : line
}
