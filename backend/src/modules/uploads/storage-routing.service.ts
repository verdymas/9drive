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
 */
type RoutingMode = 'most_available' | 'round_robin' | 'priority'

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
) {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected', ...(targetAccountId ? { id: targetAccountId } : {}) },
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
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected' },
    include: { storageAccount: true },
  })

  const eligible = fresh
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
    return target?.account ?? null
  }

  const policy = await prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: { userId, mode: 'most_available', priorityAccountIds: [] },
    update: {},
  })
  const mode = (['most_available', 'round_robin', 'priority'].includes(policy.mode) ? policy.mode : 'most_available') as RoutingMode
  const priorityAccountIds = normalizePriorityAccountIds(policy.priorityAccountIds)

  if (mode === 'priority') return byPriority(eligible, priorityAccountIds)[0]?.account ?? null

  if (mode === 'round_robin') {
    const ordered = byPriority(eligible, priorityAccountIds)
    const selected = ordered[policy.roundRobinCursor % ordered.length]?.account ?? ordered[0]?.account ?? null
    await prisma.uploadRoutingPolicy.update({ where: { userId }, data: { roundRobinCursor: policy.roundRobinCursor + 1 } })
    return selected
  }

  return eligible
    .sort((a, b) => {
      if (a.availableBytes === null && b.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (a.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (b.availableBytes === null) return b.account.provider === 's3' ? 1 : -1
      return Number(b.availableBytes - a.availableBytes)
    })[0]?.account
}
