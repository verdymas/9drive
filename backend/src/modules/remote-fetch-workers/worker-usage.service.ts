import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { getDriver } from './driver-registry.js'
import { PROVIDER_SAFETY_BUDGETS } from './provider-capabilities.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from './errors.js'

/** UTC month bucket `YYYY-MM` for usage rows. */
export function currentPeriodMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export type WorkerBudgetStatus = {
  workerId: string
  driver: string
  periodMonth: string
  requests: bigint
  egressBytes: bigint
  failures: bigint
  maxRequests: bigint | null
  maxEgressBytes: bigint | null
  exhausted: boolean
  approaching: boolean
}

function toBigintOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null
  try {
    const n = BigInt(value as string | number | bigint)
    return n >= 0n ? n : null
  } catch {
    return null
  }
}

/** Resolve effective safety budgets: worker override → driver default. */
export function resolveSafetyBudgets(worker: { driver: string; reqBudgetMonthly?: unknown; egressBudgetBytesMonthly?: unknown }): {
  maxRequests: bigint | null
  maxEgressBytes: bigint | null
} {
  const overrideReq = toBigintOrNull((worker as { reqBudgetMonthly?: unknown }).reqBudgetMonthly)
  const overrideEgress = toBigintOrNull((worker as { egressBudgetBytesMonthly?: unknown }).egressBudgetBytesMonthly)
  const defaults = PROVIDER_SAFETY_BUDGETS[worker.driver]
  return {
    maxRequests: overrideReq ?? (defaults?.maxRequestsPerMonth != null ? BigInt(defaults.maxRequestsPerMonth) : null),
    maxEgressBytes: overrideEgress ?? (defaults?.maxEgressBytesPerMonth != null ? BigInt(defaults.maxEgressBytesPerMonth) : null),
  }
}

export async function getWorkerBudgetStatus(workerId: string): Promise<WorkerBudgetStatus> {
  const worker = await prisma.remoteFetchWorker.findFirst({ where: { id: workerId, deletedAt: null } })
  if (!worker) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_NOT_FOUND, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_NOT_FOUND, 404)
  }
  const periodMonth = currentPeriodMonth()
  const usage = await Promise.race([
    (prisma as unknown as { remoteFetchWorkerUsage: { findUnique(args: unknown): Promise<{ requests: bigint; egressBytes: bigint; failures: bigint } | null> } }).remoteFetchWorkerUsage
      .findUnique({ where: { workerId_periodMonth: { workerId, periodMonth } } })
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ])
  const { maxRequests, maxEgressBytes } = resolveSafetyBudgets(worker as unknown as { driver: string; reqBudgetMonthly?: unknown; egressBudgetBytesMonthly?: unknown })
  const requests = usage?.requests ?? 0n
  const egressBytes = usage?.egressBytes ?? 0n
  const failures = usage?.failures ?? 0n
  const exhausted =
    (maxRequests !== null && requests >= maxRequests) || (maxEgressBytes !== null && egressBytes >= maxEgressBytes)
  const approaching =
    !exhausted &&
    ((maxRequests !== null && requests * 10n >= maxRequests * 8n) ||
      (maxEgressBytes !== null && egressBytes * 10n >= maxEgressBytes * 8n))
  return { workerId, driver: worker.driver, periodMonth, requests, egressBytes, failures, maxRequests, maxEgressBytes, exhausted, approaching }
}

/**
 * Pre-start gate: reject the selection before any relay request when the
 * configured safety budget is already exhausted. Throws WORKER_BUDGET_EXHAUSTED
 * (job stays on its worker route — never Direct, never another provider).
 */
export async function assertWorkerBudgetAvailable(workerId: string): Promise<WorkerBudgetStatus> {
  const status = await getWorkerBudgetStatus(workerId)
  if (status.exhausted) {
    throw new AppError(
      REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_BUDGET_EXHAUSTED,
      `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_BUDGET_EXHAUSTED} (worker ${workerId}, period ${status.periodMonth})`,
      409,
    )
  }
  if (status.approaching) {
    console.log(
      `[worker:budget] workerId=${workerId} driver=${status.driver} period=${status.periodMonth} requests=${status.requests} egressBytes=${status.egressBytes} status=approaching`,
    )
  }
  return status
}

/**
 * Record one relay request (success or failure). Retries and unsuccessful
 * requests count so they cannot bypass the request budget.
 */
export async function recordWorkerRequest(workerId: string, outcome: { egressBytes?: bigint; failed: boolean }): Promise<void> {
  const periodMonth = currentPeriodMonth()
  const egress = outcome.egressBytes ?? 0n
  try {
    await Promise.race([
      (prisma as unknown as { remoteFetchWorkerUsage: { upsert(args: unknown): Promise<unknown> } }).remoteFetchWorkerUsage.upsert({
        where: { workerId_periodMonth: { workerId, periodMonth } },
        create: { workerId, periodMonth, requests: 1n, egressBytes: egress, failures: outcome.failed ? 1n : 0n },
        update: {
          requests: { increment: 1n },
          egressBytes: { increment: egress },
          ...(outcome.failed ? { failures: { increment: 1n } } : {}),
        },
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ])
  } catch {
    // Usage accounting must never fail the import itself.
  }
}

/**
 * Capability gate: reject before starting when the provider lacks a required
 * capability (streaming/range/size/duration). Throws WORKER_CAPABILITY_UNSUPPORTED.
 */
export function assertWorkerCapabilities(driverKey: string, required: { streaming?: boolean; rangeRequests?: boolean; maxResponseBytes?: bigint | null }): void {
  const driver = getDriver(driverKey)
  if (!driver) return
  const caps = driver.getCapabilities?.()
  if (!caps) return
  if (required.streaming && !caps.streaming) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CAPABILITY_UNSUPPORTED, `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CAPABILITY_UNSUPPORTED} (streaming not supported by ${driverKey})`, 400)
  }
  if (required.rangeRequests && !caps.rangeRequests) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CAPABILITY_UNSUPPORTED, `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CAPABILITY_UNSUPPORTED} (range not supported by ${driverKey})`, 400)
  }
  if (required.maxResponseBytes != null && caps.maxResponseBytes != null && required.maxResponseBytes > BigInt(caps.maxResponseBytes)) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CAPABILITY_UNSUPPORTED, `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CAPABILITY_UNSUPPORTED} (size exceeds ${driverKey} cap of ${caps.maxResponseBytes} bytes)`, 400)
  }
}
