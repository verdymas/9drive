import type { ConnectedAccount } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { selectAccount } from '../uploads/storage-routing.service.js'
import { ensureFolderStorageLocation, type MaterializationResult } from './folder-materialization.service.js'

/**
 * Central placement resolution shared by normal uploads and Remote Import.
 *
 * Decides WHERE a file's bytes go (which connected account, and which
 * physical folder on that account) and guarantees the destination physical
 * folder tree exists there (lazy materialization).
 *
 * Semantics (multi-storage spec §9-§15, §38):
 * - `requestedConnectedAccountId` (manual selection) is AUTHORITATIVE: the
 *   upload uses it or fails with a clear quota error. Never silently switches
 *   providers.
 * - Automatic routing considers every eligible connected account; the
 *   destination folder's existing physical locations are only a soft
 *   preference, never a hard constraint, and never override quota.
 * - When the chosen account's quota turns out insufficient mid-flight in
 *   automatic mode, `reroute` performs a bounded number of re-selections
 *   (excluding previously tried accounts) before giving up.
 */

export type UploadPlacement = {
  connectedAccount: ConnectedAccount
  folderStorageLocation: MaterializationResult['location']
}

export type PlacementMode = 'multipart' | 'resumable' | 'remote-import'

const MAX_REROUTE_ATTEMPTS = 2

/**
 * Resolve the storage placement for one upload.
 *
 * @param userId             owning user
 * @param virtualFolderId    destination virtual folder (may be null = root)
 * @param requestedAccountId manual pin from the user (null = Automatic)
 * @param sizeBytes          file size; for unknown-size uploads pass the best
 *                           known estimate — the final size is re-checked at
 *                           upload time by the caller via `reroute`.
 * @param reservedBytesByAccount in-flight reservations from batch planning
 * @param mode               which caller is using this service (for logging)
 * @param excludeAccountIds  accounts already tried during a reroute loop
 */
export async function resolveUploadPlacement(
  userId: string,
  virtualFolderId: string | null | undefined,
  requestedAccountId: string | null | undefined,
  sizeBytes: bigint,
  reservedBytesByAccount = new Map<string, bigint>(),
  mode: PlacementMode = 'resumable',
  excludeAccountIds: string[] = [],
): Promise<UploadPlacement> {
  // ── Manual selection: authoritative. ────────────────────────────────────
  if (requestedAccountId) {
    if (excludeAccountIds.includes(requestedAccountId)) {
      throw new AppError('AUTOMATIC_STORAGE_REROUTE_EXHAUSTED', 'The selected storage account was already tried and failed.', 409)
    }
    const account = await prisma.connectedAccount.findFirst({
      where: { id: requestedAccountId, userId, status: { in: ['connected', 'reauth_required'] } },
      include: { storageAccount: true },
    })
    if (!account) throw new AppError('STORAGE_ACCOUNT_NOT_ELIGIBLE', 'The selected storage account is not connected.', 400)
    // A manual pin may bypass Auto Allocation OFF but never broken
    // authentication — reauth accounts fail fast with a reconnect action.
    if (account.status === 'reauth_required') {
      throw new AppError('GOOGLE_REAUTH_REQUIRED', 'This Google Drive account needs to be reconnected before it can be used.', 401)
    }
    await assertSufficientQuota(account, sizeBytes, reservedBytesByAccount)
    const placement = await materializeFor(userId, virtualFolderId, account, mode, 'manual')
    return placement
  }

  // ── Automatic: route among all eligible accounts. ───────────────────────
  // Auto Allocation OFF is a pre-routing exclusion, BEFORE any routing strategy
  // or existing-folder-location preference applies. Zero allocation-enabled
  // accounts (regardless of quota) is a distinct failure from "enabled but all
  // full" — the latter still surfaces as AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT
  // from `selectAccount` below.
  const anyAllocationEnabled = await prisma.connectedAccount.findFirst({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: { in: ['connected', 'reauth_required'] }, autoAllocationEnabled: true },
    select: { id: true },
  })
  if (!anyAllocationEnabled) {
    throw new AppError('AUTOMATIC_STORAGE_NO_ALLOCATION_ENABLED_ACCOUNT', 'No storage account is enabled for Automatic allocation. Enable Auto Allocation for at least one account in Quota Tracker, or select a storage account manually.', 400)
  }

  const preferredAccountIds = await preferredLocationAccountIds(userId, virtualFolderId)
  const account = await selectAccount(userId, sizeBytes, reservedBytesByAccount, undefined, true, preferredAccountIds.filter((id) => !excludeAccountIds.includes(id)))
  if (!account) {
    throw new AppError('AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT', 'No connected storage account has enough space for this upload.', 400)
  }
  const placement = await materializeFor(userId, virtualFolderId, account, mode, 'automatic')
  return placement
}

/**
 * Re-check quota and, in automatic mode, re-select another account when the
 * previously selected one can no longer hold the file (its quota may have
 * changed between routing and upload). Manual pins never reroute — the error
 * surfaces as-is. Bounded: after `MAX_REROUTE_ATTEMPTS` re-selections the
 * caller receives `AUTOMATIC_STORAGE_REROUTE_EXHAUSTED`.
 */
export async function rerouteOrFail(
  userId: string,
  virtualFolderId: string | null | undefined,
  requestedAccountId: string | null | undefined,
  finalSizeBytes: bigint,
  reservedBytesByAccount = new Map<string, bigint>(),
  mode: PlacementMode = 'resumable',
  triedAccountIds: string[] = [],
): Promise<UploadPlacement> {
  if (requestedAccountId) {
    throw new AppError('STORAGE_ACCOUNT_INSUFFICIENT_QUOTA', 'The selected storage account does not have enough available space.', 400)
  }
  const excluded = [...triedAccountIds]
  if (excluded.length >= MAX_REROUTE_ATTEMPTS) {
    throw new AppError('AUTOMATIC_STORAGE_REROUTE_EXHAUSTED', 'Could not find another storage account with enough space after retrying.', 409)
  }
  return resolveUploadPlacement(userId, virtualFolderId, undefined, finalSizeBytes, reservedBytesByAccount, mode, excluded)
}

async function assertSufficientQuota(
  account: ConnectedAccount & { storageAccount?: { availableBytes: bigint | null } | null },
  sizeBytes: bigint,
  reservedBytesByAccount: Map<string, bigint>,
) {
  const availableBytes = account.storageAccount?.availableBytes
  if (availableBytes === null || availableBytes === undefined) return // unknown quota = treat as eligible (existing routing convention)
  const reserved = reservedBytesByAccount.get(account.id) ?? 0n
  if (availableBytes - reserved < sizeBytes) {
    throw new AppError('STORAGE_ACCOUNT_INSUFFICIENT_QUOTA', 'The selected storage account does not have enough available space.', 400)
  }
}

async function preferredLocationAccountIds(userId: string, virtualFolderId: string | null | undefined): Promise<string[]> {
  if (!virtualFolderId) return []
  const locations = await prisma.folderStorageLocation.findMany({
    where: { folderId: virtualFolderId },
    select: { connectedAccountId: true },
  })
  return locations.map((l) => l.connectedAccountId)
}

async function materializeFor(
  userId: string,
  virtualFolderId: string | null | undefined,
  account: ConnectedAccount,
  mode: PlacementMode,
  automaticOrManual: 'automatic' | 'manual',
): Promise<UploadPlacement> {
  if (!virtualFolderId) {
    // Root-level upload: the provider root is the physical destination, with
    // no location row (the root is per-account and not part of the virtual
    // tree). Resolve the root id directly.
    const { ensureProviderRoot } = await import('./provider-folder.service.js')
    const providerFolderId = await ensureProviderRoot(account)
    logPlacement(virtualFolderId ?? null, account, mode, automaticOrManual, 0, true)
    return {
      connectedAccount: account,
      folderStorageLocation: {
        id: '',
        folderId: '',
        connectedAccountId: account.id,
        provider: account.provider,
        providerFolderId,
      },
    }
  }

  const result = await ensureFolderStorageLocation(userId, virtualFolderId, account.id)
  logPlacement(virtualFolderId, account, mode, automaticOrManual, result.createdCount, result.createdCount === 0)
  return { connectedAccount: account, folderStorageLocation: result.location }
}

function logPlacement(
  virtualFolderId: string | null,
  account: ConnectedAccount,
  mode: PlacementMode,
  automaticOrManual: 'automatic' | 'manual',
  createdLocationCount: number,
  reusedExistingLocation: boolean,
) {
  console.info('[upload-placement]', JSON.stringify({
    virtualFolderId,
    connectedAccountId: account.id,
    provider: account.provider,
    createdLocationCount,
    reusedExistingLocation,
    routingStrategy: automaticOrManual,
    automaticOrManual,
    mode,
  }))
}
