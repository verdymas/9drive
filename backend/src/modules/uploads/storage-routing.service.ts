import { prisma } from '../../config/prisma.js'
import { syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota } from '../s3/s3.service.js'

/**
 * Automatic storage routing shared by direct uploads (upload.routes.ts) and
 * Remote Import (remote-imports/processor.ts). Chooses the best connected
 * storage account for a file of `sizeBytes`, honoring an optional pinned
 * `targetAccountId` (from the destination folder's binding or an explicit
 * user pick).
 *
 * Quota freshness: accounts whose `lastSyncedAt` is stale are re-synced
 * (best-effort) before selection, so Remote Import sees near-real-time
 * availability — the same behavior direct uploads rely on.
 *
 * A pinned `targetAccountId` is normally a soft preference: if that account
 * cannot hold the file (not enough free space), routing falls back to the
 * best eligible account so a nearly-full pinned account never hard-blocks an
 * upload that another connected account could take. Folder-ownership pins
 * (subfolder uploads must land on the account that owns the folder to avoid
 * Google Drive 404s) pass `allowFallback: false` to keep the pin strict.
 */
type RoutingMode = 'most_available' | 'round_robin' | 'priority'

/** One file of a multi-file upload batch, as sent to the preflight planner. */
export type PreflightFile = { fileName: string; mimeType: string; sizeBytes: bigint }

export type PreflightReason = 'insufficient' | 'no_accounts' | 's3_only' | 'duplicate'

/**
 * Per-file plan produced by `planBatchUploads`. `accountId` is set (with
 * `reason: null`) when the file can be uploaded right now; otherwise the file
 * is unroutable and `reason` explains why.
 */
export type PreflightPlan = {
  fileName: string
  accountId: string | null
  provider: 'google_drive' | null
  reason: PreflightReason | null
}

export type PreflightResult = {
  plans: PreflightPlan[]
  totalBytes: bigint
  totalRoutedBytes: bigint
  unroutedBytes: bigint
}

function normalizePriorityAccountIds(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function byPriority<T extends { account: { id: string; createdAt: Date } }>(items: T[], priorityAccountIds: string[]) {
  const order = new Map(priorityAccountIds.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.account.id)
    const bOrder = order.get(b.account.id)
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1
    return a.account.createdAt.getTime() - b.account.createdAt.getTime()
  })
}

export async function selectAccount(
  userId: string,
  sizeBytes: bigint,
  reservedBytesByAccount = new Map<string, bigint>(),
  targetAccountId?: string | null,
  allowFallback = false,
  preferredAccountIds: string[] = [],
) {
  // Reauth-required accounts are fetched for the stale-quota pass (the sync
  // attempt naturally marks them) but are NOT eligible for selection.
  const visibleStatuses = { in: ['connected', 'reauth_required'] }
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: visibleStatuses, autoAllocationEnabled: true, ...(targetAccountId ? { id: targetAccountId } : {}) },
    include: { storageAccount: true },
  })

  const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  await Promise.allSettled(stale.map(async (account) => {
    try {
      if (account.provider === 's3') await syncS3Quota(account.id)
      else await syncGoogleQuota(account.id)
    } catch (err: any) {
      console.error(`[storage-routing] failed to sync quota for account ${account.email} (${account.id}):`, err.message || err)
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { lastError: err.message || 'Quota sync failed' },
      }).catch(() => undefined)
    }
  }))

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: visibleStatuses, autoAllocationEnabled: true },
    include: { storageAccount: true },
  })

  const eligible = fresh
    // Auth is a hard eligibility filter for Automatic routing (unlike the
    // saved Auto Allocation preference, which stays intact): reauth accounts
    // are excluded even when a FolderStorageLocation exists for them.
    .filter((account) => account.status !== 'reauth_required')
    .map((account) => ({
      account,
      availableBytes:
        account.storageAccount?.availableBytes === null || account.storageAccount?.availableBytes === undefined
          ? null
          : account.storageAccount.availableBytes - (reservedBytesByAccount.get(account.id) ?? 0n),
    }))
    .filter(({ availableBytes }) => availableBytes === null || availableBytes >= sizeBytes)

  if (eligible.length === 0) return null

  if (targetAccountId) {
    const target = eligible.find((e) => e.account.id === targetAccountId)
    if (target) return target.account
    // A soft (user-chosen) pin falls back to automatic routing when the pinned
    // account lacks space; a strict (folder-ownership) pin does not.
    if (!allowFallback) return null
  }

  const policy = await prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: { userId, mode: 'most_available', priorityAccountIds: [] },
    update: {},
  })
  const mode = (['most_available', 'round_robin', 'priority'].includes(policy.mode) ? policy.mode : 'most_available') as RoutingMode
  const priorityAccountIds = normalizePriorityAccountIds(policy.priorityAccountIds)

  // Accounts that already hold a physical location for the destination folder.
  // A soft preference ONLY — quota remains the hard filter (see #11 in the
  // multi-storage spec), so a nearly-full account never wins over an eligible
  // account that would need lazy folder materialization.
  const preferred = new Set(preferredAccountIds)

  if (mode === 'priority') return byPriority(eligible, priorityAccountIds)[0]?.account ?? null

  if (mode === 'round_robin') {
    const ordered = byPriority(eligible, priorityAccountIds)
    const selected = ordered[policy.roundRobinCursor % ordered.length]?.account ?? ordered[0]?.account ?? null
    await prisma.uploadRoutingPolicy.update({ where: { userId }, data: { roundRobinCursor: policy.roundRobinCursor + 1 } })
    return selected
  }

  return eligible
    .sort((a, b) => {
      // 1. Quota (descending) stays the primary ordering.
      if (a.availableBytes !== null && b.availableBytes !== null && a.availableBytes !== b.availableBytes) {
        return Number(b.availableBytes - a.availableBytes)
      }
      if (a.availableBytes === null && b.availableBytes !== null) return a.account.provider === 's3' ? -1 : 1
      if (b.availableBytes === null && a.availableBytes !== null) return b.account.provider === 's3' ? 1 : -1
      if (a.availableBytes === null && b.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      // 2. Tie-breaker: existing physical location for the destination folder.
      if (preferred.has(a.account.id) && !preferred.has(b.account.id)) return -1
      if (preferred.has(b.account.id) && !preferred.has(a.account.id)) return 1
      // 3. Stable order by creation time.
      return a.account.createdAt.getTime() - b.account.createdAt.getTime()
    })[0]?.account
}

/**
 * Plan a multi-file upload batch BEFORE any bytes are sent, so the whole
 * batch can be checked against the combined free space of the user's
 * connected Google Drive accounts up-front. Files are assigned to accounts
 * with a growing reservation map (the same reserve-per-file pattern as the
 * legacy multipart `handleUpload`), so two large files in one batch land on
 * different accounts instead of both being routed to the first one with
 * space and failing mid-batch when its real quota runs out.
 *
 * Only Google Drive accounts are planned: the resumable chunk path rejects
 * S3 (`UNSUPPORTED_PROVIDER`), so a plan pointing at S3 would be a dead end.
 * Files that cannot be routed get `reason` set and are excluded from
 * `totalRoutedBytes` — the caller may still upload them via the normal
 * per-file path, which re-validates space at init time.
 *
 * Reservations are returned to the caller, not persisted: each file is
 * re-validated by init (via `selectAccount`) before uploading, so a stale
 * plan degrades to automatic routing rather than failing. Cross-request
 * overcommit (two uploads racing the same quota) is a pre-existing
 * limitation of quota-based routing, unchanged here.
 */
export async function planBatchUploads(
  userId: string,
  files: PreflightFile[],
  targetAccountId?: string | null,
): Promise<PreflightResult> {
  const plans: PreflightPlan[] = []
  let totalBytes = 0n
  let totalRoutedBytes = 0n

  for (const file of files) totalBytes += file.sizeBytes

  // Duplicate file names cannot be planned (the frontend keys sessions by
  // name); mark all occurrences and exclude them from routing.
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const file of files) {
    if (seen.has(file.fileName)) duplicates.add(file.fileName)
    seen.add(file.fileName)
  }

  // An explicit user-chosen pin is a SOFT preference, exactly like
  // `selectAccount`'s `allowFallback` path: the pinned account is preferred,
  // but if it cannot hold a file the planner falls back to the other connected
  // accounts. Only when the pin is not a connected Google Drive account at all
  // (missing, or an S3 pin — S3 is never planned) is every file unroutable.
  // Reauth-required accounts stay in the stale-sync pass but are never planned.
  const visibleStatuses = { in: ['connected', 'reauth_required'] }
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: 'google_drive', status: visibleStatuses },
    include: { storageAccount: true },
  })

  if (targetAccountId && !accounts.some((account) => account.id === targetAccountId)) {
    for (const file of files) {
      plans.push({
        fileName: file.fileName,
        accountId: null,
        provider: null,
        reason: duplicates.has(file.fileName) ? 'duplicate' : 'no_accounts',
      })
    }
    return { plans, totalBytes, totalRoutedBytes, unroutedBytes: totalBytes }
  }

  // Re-sync stale quota best-effort, exactly like `selectAccount`: keep the
  // account routable even when the sync fails (null quota = eligible).
  const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  await Promise.allSettled(stale.map(async (account) => {
    try {
      await syncGoogleQuota(account.id)
    } catch (err: any) {
      console.error(`[storage-routing] failed to sync quota for account ${account.email} (${account.id}):`, err.message || err)
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { lastError: err.message || 'Quota sync failed' },
      }).catch(() => undefined)
    }
  }))

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, provider: 'google_drive', status: visibleStatuses },
    include: { storageAccount: true },
  })

  // Auto Allocation OFF is a pre-routing exclusion: accounts opted out of
  // automatic placement are dropped from the pool before any strategy applies,
  // UNLESS the user explicitly pinned one (a manual pin stays authoritative).
  // Reauth-required accounts are excluded regardless of a pin — broken auth is
  // never bypassable by manual selection.
  const planningPool = targetAccountId
    ? fresh.filter((account) => account.id === targetAccountId || account.autoAllocationEnabled)
    : fresh.filter((account) => account.autoAllocationEnabled)
  const healthyPool = planningPool.filter((account) => account.status !== 'reauth_required')

  if (healthyPool.length === 0) {
    for (const file of files) {
      plans.push({
        fileName: file.fileName,
        accountId: null,
        provider: null,
        reason: duplicates.has(file.fileName) ? 'duplicate' : 'no_accounts',
      })
    }
    return { plans, totalBytes, totalRoutedBytes, unroutedBytes: totalBytes }
  }

  const available = healthyPool.map((account) => ({
    account,
    availableBytes:
      account.storageAccount?.availableBytes === null || account.storageAccount?.availableBytes === undefined
        ? null
        : account.storageAccount.availableBytes,
  }))

  // Deterministic account order per the routing policy, mirroring
  // `selectAccount` — including the round-robin cursor advance, so preflight
  // and per-file routing stay on the same rotation.
  const policy = await prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: { userId, mode: 'most_available', priorityAccountIds: [] },
    update: {},
  })
  const mode = (['most_available', 'round_robin', 'priority'].includes(policy.mode) ? policy.mode : 'most_available') as RoutingMode
  const priorityAccountIds = normalizePriorityAccountIds(policy.priorityAccountIds)

  let orderedAccounts: typeof available
  if (mode === 'priority') {
    orderedAccounts = byPriority(available, priorityAccountIds)
  } else if (mode === 'round_robin') {
    orderedAccounts = byPriority(available, priorityAccountIds)
    if (orderedAccounts.length > 0) {
      const start = policy.roundRobinCursor % orderedAccounts.length
      orderedAccounts = [...orderedAccounts.slice(start), ...orderedAccounts.slice(0, start)]
      // Advance the cursor by the number of routable files, matching the
      // one-account-per-file advance in `selectAccount`.
      const routableCount = files.filter((file) => !duplicates.has(file.fileName)).length
      await prisma.uploadRoutingPolicy.update({
        where: { userId },
        data: { roundRobinCursor: policy.roundRobinCursor + routableCount },
      })
    }
  } else {
    orderedAccounts = [...available].sort((a, b) => {
      if (a.availableBytes === null && b.availableBytes === null) return 0
      if (a.availableBytes === null) return -1
      if (b.availableBytes === null) return 1
      return Number(b.availableBytes - a.availableBytes)
    })
  }

  // Largest-first makes reservations pack tighter: a 500MB file cannot hide
  // behind a 300MB file that lands on the same account first. `most_available`
  // then assigns each file to the account with the most space left.
  const reservedBytesByAccount = new Map<string, bigint>()
  const routable = files
    .filter((file) => !duplicates.has(file.fileName))
    .sort((a, b) => Number(b.sizeBytes - a.sizeBytes))

  // Round-robin pointer: each assigned file advances the rotation (the global
  // cursor already advanced by the routable count, mirroring selectAccount's
  // one-per-call advance).
  let rrPointer = 0
  const fits = (entry: (typeof available)[number], sizeBytes: bigint) =>
    entry.availableBytes === null || entry.availableBytes - (reservedBytesByAccount.get(entry.account.id) ?? 0n) >= sizeBytes
  const pinned = targetAccountId ? available.find((entry) => entry.account.id === targetAccountId) ?? null : null
  for (const file of routable) {
    let selected: (typeof available)[number] | null = null
    // A soft pin is preferred when it can hold the file — it still consumes a
    // reservation like any routed file, so a later file of the batch may spill.
    if (pinned && fits(pinned, file.sizeBytes)) {
      selected = pinned
    } else if (mode === 'most_available') {
      const withReservations = orderedAccounts.map((entry) => ({
        ...entry,
        adjusted: entry.availableBytes === null ? null : entry.availableBytes - (reservedBytesByAccount.get(entry.account.id) ?? 0n),
      }))
      const eligible = withReservations.filter((entry) => entry.adjusted === null || entry.adjusted >= file.sizeBytes)
      selected = eligible.length > 0
        ? eligible.reduce((best, entry) => {
            if (best.adjusted === null) return best
            if (entry.adjusted === null) return entry
            return entry.adjusted > best.adjusted ? entry : best
          })
        : null
    } else if (mode === 'round_robin') {
      const eligibleNow = orderedAccounts.filter((entry) => entry.availableBytes === null || entry.availableBytes - (reservedBytesByAccount.get(entry.account.id) ?? 0n) >= file.sizeBytes)
      if (eligibleNow.length > 0) {
        selected = eligibleNow[rrPointer % eligibleNow.length] ?? null
        rrPointer++
      }
    } else {
      selected = orderedAccounts.find((entry) => entry.availableBytes === null || entry.availableBytes - (reservedBytesByAccount.get(entry.account.id) ?? 0n) >= file.sizeBytes) ?? null
    }

    if (selected) {
      reservedBytesByAccount.set(selected.account.id, (reservedBytesByAccount.get(selected.account.id) ?? 0n) + file.sizeBytes)
      totalRoutedBytes += file.sizeBytes
      plans.push({ fileName: file.fileName, accountId: selected.account.id, provider: 'google_drive', reason: null })
    } else {
      plans.push({ fileName: file.fileName, accountId: null, provider: null, reason: 'insufficient' })
    }
  }

  for (const file of files) {
    if (duplicates.has(file.fileName)) {
      plans.push({ fileName: file.fileName, accountId: null, provider: null, reason: 'duplicate' })
    }
  }

  // Emit plans in the caller's file order for predictable consumption
  // (routing itself ran largest-first for tighter packing).
  const inputOrder = new Map(files.map((file, index) => [file.fileName, index]))
  plans.sort((a, b) => inputOrder.get(a.fileName)! - inputOrder.get(b.fileName)!)

  return { plans, totalBytes, totalRoutedBytes, unroutedBytes: totalBytes - totalRoutedBytes }
}
