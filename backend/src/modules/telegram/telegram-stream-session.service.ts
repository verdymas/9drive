/**
 * PyroFork streaming session: store, read, invalidate.
 *
 * The PyroFork session is *different* from the existing GramJS teleproto
 * StringSession (see docs/audits/telegram-stream-architecture-audit.md §7).
 * It is provisioned by telegram-stream itself the first time a request
 * needs it (the streaming client manager runs a one-time PyroFork login
 * with the same apiId/apiHash, then `export_session_string()`), and the
 * resulting string is shipped back to the backend over the signed
 * internal control-plane and persisted here.
 *
 * This module is the **storage half** of that handshake. It does NOT
 * do PyroFork login itself (that would require a Python dep in the Node
 * backend). The streaming service is the single writer; the backend is
 * the single reader.
 *
 * Failure modes:
 * - column missing: telegram-stream receives 404 from the control plane,
 *   surfaces it as a 503, and Jellyfin sees a clear error.
 * - invalidation (on reauth_required): the next request from
 *   telegram-stream gets null and re-runs the login flow.
 */
import type { PrismaClient } from '@prisma/client'

import { encryptText, decryptText } from '../../utils/crypto.js'

export interface ProvisionedStreamSession {
  ciphertext: string
}

/**
 * Encrypt a PyroFork session string with the existing TOKEN_ENCRYPTION_KEY
 * (same scheme as `encryptText` for the teleproto session).
 */
export function packStreamSession(plaintext: string): ProvisionedStreamSession {
  return { ciphertext: encryptText(plaintext) }
}

export function unpackStreamSession(packed: ProvisionedStreamSession): string {
  return decryptText(packed.ciphertext)
}

/**
 * Read the streaming session ciphertext for a connected account. Returns
 * null if not yet provisioned.
 */
export async function readStreamSessionCiphertext(
  prisma: PrismaClient,
  connectedAccountId: string,
): Promise<string | null> {
  const row = await prisma.telegramStorageConfig.findFirst({
    where: { connectedAccountId },
    select: { streamSessionEncrypted: true },
  })
  return row?.streamSessionEncrypted ?? null
}

/**
 * Persist a PyroFork session string. Called by the control-plane endpoint
 * that telegram-stream hits after a successful PyroFork login.
 * Idempotent: writes overwrite. Stores ciphertext only; never logs plaintext.
 */
export async function writeStreamSession(
  prisma: PrismaClient,
  connectedAccountId: string,
  sessionPlaintext: string,
): Promise<void> {
  if (!sessionPlaintext) {
    throw new Error('cannot persist an empty streaming session')
  }
  await prisma.telegramStorageConfig.update({
    where: { connectedAccountId },
    data: { streamSessionEncrypted: encryptText(sessionPlaintext) },
  })
}

/**
 * Invalidate the streaming session for a connected account. Called from
 * markTelegramReauthRequired so a revoked or expired session cannot be
 * used by telegram-stream after a reauth.
 */
export async function invalidateStreamSession(
  prisma: PrismaClient,
  connectedAccountId: string,
): Promise<void> {
  try {
    await prisma.telegramStorageConfig.updateMany({
      where: { connectedAccountId, streamSessionEncrypted: { not: null } },
      data: { streamSessionEncrypted: null },
    })
  } catch {
    // best-effort: invalidation is allowed to be lazy.
  }
}
