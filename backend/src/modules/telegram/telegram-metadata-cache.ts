import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import {
  calculateMetadataFingerprint,
  decryptRecoveryMetadata,
  generatePhysicalFilename,
  serializeTelegramMetaLine,
  telegramCryptoEnabled,
  telegramObfuscateFilenameEnabled,
  TELEGRAM_CRYPTO_ERROR_CODES,
  TELEGRAM_CRYPTO_VERSION,
  type RecoveryMetadata,
} from './telegram-crypto.service.js'
import { normalizeTelegramMetaValue, parseCaption } from './telegram-metadata.js'

/**
 * Telegram metadata cache persistence (Phase 2).
 *
 * One helper for writing the protected-metadata cache block on a `File` row:
 * `physicalFilename`, raw `encryptedMetadata` (`v1:...`),
 * `metadataFingerprint`, and `cryptoVersion`. Canonical logical state lives
 * in the normal File columns; these are the cached recovery representation,
 * refreshed only when the canonical recovery metadata changes
 * (rename/move/upload).
 *
 * Behavior matrix:
 *   - Encryption disabled → NO cached ciphertext; columns left untouched
 *     (legacy behavior preserved; callers keep plaintext captions).
 *   - Obfuscation disabled → physicalFilename stays NULL (logical name used).
 *   - Enabled → ciphertext + fingerprint + version persisted so normal reads
 *     and sync never decrypt.
 */
/**
 * Build the protected-metadata cache block ({ physicalFilename,
 * encryptedMetadata, metadataFingerprint, cryptoVersion }) for a `File`
 * row. Pure — no DB I/O — so callers can merge it into an atomic
 * `prisma.file.update` alongside `providerFileId`/`status`.
 *
 * Behavior matrix:
 *   - Encryption disabled → no ciphertext fields (legacy plaintext captions
 *     preserved).
 *   - Obfuscation disabled → `physicalFilename` untouched (logical name is
 *     the Telegram filename).
 *   - Enabled → ciphertext + fingerprint + version.
 */
export function buildTelegramMetadataCache(input: RecoveryMetadata & { fileId: string }): Record<string, unknown> {
  const data: Record<string, unknown> = {}

  if (telegramCryptoEnabled()) {
    const fingerprint = calculateMetadataFingerprint(input)
    const metaLine = serializeTelegramMetaLine(input)
    const metaValue = normalizeTelegramMetaValue(metaLine)
    data.metadataFingerprint = fingerprint
    data.encryptedMetadata = metaValue
    data.cryptoVersion = 'v1'
  }

  if (telegramObfuscateFilenameEnabled()) {
    data.physicalFilename = generatePhysicalFilename(input.fileId, input.name)
  }

  return data
}

/** Persist the protected-metadata cache block on a `File` row (no-op when empty). */
export async function persistTelegramMetadataCache(
  userId: string,
  fileId: string,
  input: RecoveryMetadata & { fileId: string },
): Promise<void> {
  const data = buildTelegramMetadataCache(input)
  if (Object.keys(data).length === 0) return
  await prisma.file.update({ where: { id: fileId, userId }, data })
}

/**
 * Recompute + persist the cache after a canonical metadata change (rename/
 * move). Returns `true` when the fingerprint changed (crypto work was needed),
 * `false` when the cache is untouched. Encryption disabled → `false`, no-op.
 */
export async function refreshTelegramMetadataCache(
  userId: string,
  fileId: string,
  input: RecoveryMetadata & { fileId: string },
  previousFingerprint: string | null,
): Promise<boolean> {
  if (!telegramCryptoEnabled()) return false
  const fingerprint = calculateMetadataFingerprint(input)
  if (previousFingerprint === fingerprint) return false
  await persistTelegramMetadataCache(userId, fileId, input)
  return true
}

export { telegramCryptoEnabled, telegramObfuscateFilenameEnabled }

/**
 * Result of comparing a caption's `9drive:meta` line against the cached
 * ciphertext on the `File` row (spec §35 — the sync fast path).
 *
 *   - `none`    → the caption carries no encrypted metadata (legacy caption).
 *   - `cached`  → byte-identical to the cache; NOTHING is decrypted.
 *   - `changed` → differs; decrypted + validated recovery metadata.
 *   - `failed`  → wrong key, tampered, malformed, or unsupported version.
 *                 Never guessed at, never applied, never silently accepted.
 */
export type CaptionMetaResolution =
  | { status: 'none' }
  | { status: 'cached' }
  | { status: 'changed'; meta: RecoveryMetadata }
  | { status: 'failed'; code: string; message: string }

export function resolveCaptionMeta(captionMeta: string | null, cached: string | null): CaptionMetaResolution {
  if (!captionMeta) return { status: 'none' }
  const normalizedCaptionMeta = normalizeTelegramMetaValue(captionMeta)
  if (normalizedCaptionMeta === null) {
    return { status: 'failed', code: TELEGRAM_CRYPTO_ERROR_CODES.MALFORMED, message: 'The encrypted Telegram metadata payload is malformed.' }
  }
  const normalizedCached = normalizeTelegramMetaValue(cached)
  // Fast path: identical ciphertext means the canonical metadata behind it is
  // unchanged, so there is nothing to reconcile and no reason to decrypt.
  if (normalizedCached !== null && normalizedCached === normalizedCaptionMeta) return { status: 'cached' }
  if (!telegramCryptoEnabled()) {
    return { status: 'failed', code: TELEGRAM_CRYPTO_ERROR_CODES.KEY_NOT_CONFIGURED, message: 'Encrypted Telegram metadata was found but encryption is not enabled.' }
  }
  try {
    return { status: 'changed', meta: decryptRecoveryMetadata(normalizedCaptionMeta) }
  } catch (error) {
    return {
      status: 'failed',
      code: error instanceof AppError ? error.code : TELEGRAM_CRYPTO_ERROR_CODES.DECRYPT_FAILED,
      message: error instanceof Error ? error.message.slice(0, 200) : 'Telegram metadata could not be decrypted.',
    }
  }
}

/**
 * Classify a caption's encrypted metadata without reconciling anything.
 * Returns the failure when the payload is unreadable (wrong key, tampered,
 * malformed, unsupported version), else `null`. Pure — no DB I/O.
 */
export function inspectCaptionMeta(caption: string | null, cached: string | null): { code: string; message: string } | null {
  const parsed = parseCaption(caption)
  if (!parsed.encryptedMeta) return null
  const resolution = resolveCaptionMeta(parsed.encryptedMeta, cached)
  return resolution.status === 'failed' ? { code: resolution.code, message: resolution.message } : null
}

/**
 * Cache the caption's own ciphertext after it has been reconciled into the
 * DB, normalized to the raw value so the next sync hits the `cached` fast
 * path. Re-encrypting here would mint a fresh IV and force a decrypt on every
 * run.
 */
export async function storeCaptionCiphertext(
  userId: string,
  fileId: string,
  metaLine: string,
  fingerprintInput: RecoveryMetadata & { fileId: string },
): Promise<void> {
  const metaValue = normalizeTelegramMetaValue(metaLine)
  if (metaValue === null) return
  await prisma.file.update({
    where: { id: fileId, userId },
    data: {
      encryptedMetadata: metaValue,
      metadataFingerprint: calculateMetadataFingerprint(fingerprintInput),
      cryptoVersion: TELEGRAM_CRYPTO_VERSION,
    },
  })
}
