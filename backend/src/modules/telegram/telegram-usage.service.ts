import { prisma } from '../../config/prisma.js'

/**
 * Telegram usage is indexed-only: the "Total Stored Size" is the sum of bytes
 * of active Files on the account, not a provider-reported quota. Telegram has
 * no reliable quota API, so `totalBytes`/`availableBytes` stay `null` and only
 * `usedBytes` + `fileCount` are written — the UI must never render fake quota.
 */
export async function syncTelegramUsage(accountId: string) {
  const aggregate = await prisma.file.aggregate({
    where: { connectedAccountId: accountId, status: 'active' },
    _sum: { sizeBytes: true },
    _count: true,
  })
  const usedBytes = aggregate._sum.sizeBytes ?? 0n
  const fileCount = aggregate._count
  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      usedBytes,
      fileCount,
      totalBytes: null,
      availableBytes: null,
      lastSyncedAt: new Date(),
    },
    update: {
      usedBytes,
      fileCount,
      lastSyncedAt: new Date(),
    },
  })
}