import crypto from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { encryptText, decryptText, randomToken } from '../../utils/crypto.js'
import { resolveDriver } from './driver-registry.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from './errors.js'
import type { RemoteFetchWorkerAuthType } from './types.js'
import type { RemoteFetchWorker, Prisma } from '@prisma/client'

// Re-export for routes that need to map errors
export { AppError }

/**
 * Safe wire shape: never the encrypted blobs, never a decrypted SECRET value.
 * The safe provider `config` sub-object (e.g. accountId / workerName) is
 * readable server-side and surfaced for the edit form — the `credentials`
 * (apiToken) never leave the encrypted blob.
 */
export function serializeWorker(row: any) {
  const { secretEncrypted: _s, configEncrypted: _c, ...rest } = row
  let providerConfig: Record<string, string> | null = null
  if (row.configEncrypted) {
    try {
      const parsed = JSON.parse(decryptText(row.configEncrypted)) as { config?: Record<string, string>; credentials?: object } | null
      providerConfig = parsed?.config ?? null
    } catch {
      providerConfig = null
    }
  }
  return { ...rest, credentialConfigured: Boolean(row.secretEncrypted), providerConfig }
}

export type CreateWorkerInput = {
  name?: string | null
  slug?: string | null
  driver: string
  /** Managed drivers: provider registration payload (e.g. {accountId, apiToken, workerName}). */
  config?: Record<string, string> | null
  /** Manual drivers only. */
  endpointUrl?: string | null
  authType?: RemoteFetchWorkerAuthType
  secret?: string | null
  region?: string | null
  description?: string | null
  priority?: number | null
  isEnabled?: boolean
  isDefault?: boolean
}

export type UpdateWorkerInput = Partial<CreateWorkerInput> & { secret?: string | null }

const WORKER_SELECT: Prisma.RemoteFetchWorkerSelect = {
  id: true, name: true, slug: true, driver: true, endpointUrl: true,
  isEnabled: true, isDefault: true, priority: true, region: true, description: true,
  authType: true, secretEncrypted: true, configEncrypted: true,
  capabilitiesJson: true, metadataJson: true, status: true,
  lastHealthCheckAt: true, lastHealthyAt: true, lastFailedAt: true, lastErrorCode: true,
  deletedAt: true, createdAt: true, updatedAt: true,
}

function workerNotFound(): AppError {
  return new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_NOT_FOUND, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_NOT_FOUND, 404)
}

async function findWorker(id: string): Promise<RemoteFetchWorker> {
  const worker = await prisma.remoteFetchWorker.findFirst({
    where: { id, deletedAt: null },
    select: WORKER_SELECT,
  })
  if (!worker) throw workerNotFound()
  return worker as unknown as RemoteFetchWorker
}

/** Validate driver-config against the driver BEFORE persisting. */
async function validateDriverConfig(input: CreateWorkerInput) {
  const driver = resolveDriver(input.driver)
  return driver.validateConfig({
    endpointUrl: input.endpointUrl ?? null,
    authType: input.authType ?? 'hmac',
    secret: input.secret ?? null,
    config: input.config ?? null,
  })
}

function decryptConfig(worker: RemoteFetchWorker): { config: Record<string, string>; apiToken: string } {
  if (!worker.configEncrypted) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_NOT_FOUND, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_NOT_FOUND, 404)
  }
  let parsed: { config?: Record<string, string>; credentials?: { apiToken?: string } }
  try {
    parsed = JSON.parse(decryptText(worker.configEncrypted)) as typeof parsed
  } catch {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DRIVER_CONFIG_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DRIVER_CONFIG_INVALID, 400)
  }
  const config = parsed.config ?? {}
  const apiToken = parsed.credentials?.apiToken ?? ''
  return { config, apiToken }
}

/** Decrypt the stored relay secret (managed workers always have one). */
function decryptSecret(worker: RemoteFetchWorker): string {
  return worker.secretEncrypted ? decryptText(worker.secretEncrypted) : ''
}

export async function listWorkers(): Promise<RemoteFetchWorker[]> {
  return prisma.remoteFetchWorker.findMany({
    where: { deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { priority: 'desc' }, { name: 'asc' }],
    select: WORKER_SELECT,
  }) as unknown as RemoteFetchWorker[]
}

export async function getWorker(id: string): Promise<RemoteFetchWorker> {
  return findWorker(id)
}

export async function createWorker(userId: string, input: CreateWorkerInput) {
  const driver = resolveDriver(input.driver)
  const managed = driver.getMetadata().managed

  // Manual registration (future self-hosted relays): legacy path unchanged.
  if (!managed) {
    const validated = await driver.validateConfig({
      endpointUrl: input.endpointUrl ?? null,
      authType: input.authType ?? 'hmac',
      secret: input.secret ?? null,
      config: input.config ?? null,
    })
    const authType = input.authType ?? 'hmac'
    const isDefault = input.isDefault ?? false
    const created = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.remoteFetchWorker.updateMany({ where: { isDefault: true, deletedAt: null }, data: { isDefault: false } })
      }
      return tx.remoteFetchWorker.create({
        data: {
          name: input.name ?? 'Worker',
          slug: input.slug ?? null,
          driver: input.driver,
          endpointUrl: validated.endpointUrl ?? '',
          isEnabled: input.isEnabled ?? true,
          isDefault,
          priority: input.priority ?? null,
          region: input.region ?? null,
          description: input.description ?? null,
          authType,
          secretEncrypted: input.secret ? encryptText(input.secret) : null,
          configEncrypted: validated.configEncryptedInput
            ? encryptText(JSON.stringify(validated.configEncryptedInput))
            : input.config
              ? encryptText(JSON.stringify(input.config))
              : null,
          status: 'unknown',
        },
        select: WORKER_SELECT,
      })
    })
    await createAuditLog(userId, 'worker.created', 'remote_fetch_worker', created.id, { name: created.name, driver: created.driver })
    return created as unknown as RemoteFetchWorker
  }

  // Managed registration: validate credentials → generate relay secret →
  // encrypt → persist provisioning → provision → health test → healthy.
  const correlationId = crypto.randomUUID().slice(0, 8)
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=validate_credentials started`)
  const validated = await driver.validateConfig({
    endpointUrl: null,
    config: input.config ?? null,
    correlationId,
  })
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=validate_credentials success`)
  const relaySecret = randomToken(32)
  const isDefault = input.isDefault ?? false
  const workerName = input.config?.workerName ?? 'Worker'
  const name = input.name?.trim() || workerName

  console.log(`[worker:cloudflare] correlationId=${correlationId} step=persist_worker started`)
  const created = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.remoteFetchWorker.updateMany({ where: { isDefault: true, deletedAt: null }, data: { isDefault: false } })
    }
    return tx.remoteFetchWorker.create({
      data: {
        name,
        slug: input.slug ?? null,
        driver: input.driver,
        endpointUrl: null,
        isEnabled: input.isEnabled ?? true,
        isDefault,
        priority: null,
        region: null,
        description: null,
        authType: 'hmac',
        secretEncrypted: encryptText(relaySecret),
        configEncrypted: validated.configEncryptedInput
          ? encryptText(JSON.stringify(validated.configEncryptedInput))
          : null,
        status: 'provisioning',
      },
      select: WORKER_SELECT,
    })
  })
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=persist_worker success workerId=${created.id}`)
  await createAuditLog(userId, 'worker.provisioning_started', 'remote_fetch_worker', created.id, { name: created.name, driver: created.driver, correlationId })

  try {
    if (!driver.provision) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED, 400)
    }
    // Pass correlationId through to driver for end-to-end tracing.
    const result = await (driver.provision as (inp: any) => Promise<any>)({
      config: input.config ?? {},
      secret: relaySecret,
      correlationId,
    })
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=health_check started endpoint=${result.endpointUrl}`)
    const probe = await driver.testConnection({
      endpointUrl: result.endpointUrl,
      authType: 'hmac',
      secret: relaySecret,
      correlationId,
    })
    console.log(`[worker:cloudflare] correlationId=${correlationId} step=health_check success protocol=${probe.protocolVersion ?? 'unknown'}`)
    const healthy = await prisma.remoteFetchWorker.update({
      where: { id: created.id },
      data: {
        status: 'healthy',
        endpointUrl: result.endpointUrl,
        lastHealthCheckAt: new Date(),
        lastHealthyAt: new Date(),
        lastFailedAt: null,
        lastErrorCode: null,
        capabilitiesJson: probe.capabilities as Prisma.InputJsonValue,
        metadataJson: { provider: driver.displayName, protocolVersion: probe.protocolVersion ?? result.protocolVersion ?? null, correlationId } as Prisma.InputJsonValue,
        configEncrypted: result.configEncryptedInput
          ? encryptText(JSON.stringify(result.configEncryptedInput))
          : undefined,
      },
      select: WORKER_SELECT,
    })
    await createAuditLog(userId, 'worker.provisioned', 'remote_fetch_worker', created.id, { name: healthy.name, driver: healthy.driver, correlationId })
    console.log(`[worker:cloudflare] correlationId=${correlationId} provision success workerId=${created.id} endpoint=${result.endpointUrl}`)
    return healthy as unknown as RemoteFetchWorker
  } catch (error) {
    const code = error instanceof AppError ? (error as any).code : REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED
    // Preserve correlationId and provider diagnostics in logs even though public response is generic.
    const provErr: any = error
    const step = provErr?.step ?? 'provision'
    const providerStatus = provErr?.providerStatus ?? provErr?.httpStatus ?? null
    const providerCode = provErr?.providerCode ?? provErr?.cfCode ?? null
    const providerMessage = provErr?.providerMessage ?? provErr?.reason ?? null
    console.error(`[worker:cloudflare] correlationId=${correlationId} provision failed step=${step} httpStatus=${providerStatus ?? 'null'} providerCode=${providerCode ?? 'null'} providerMessage="${providerMessage ?? String((error as Error)?.message ?? '')}" correlationId=${correlationId}`)
    await prisma.remoteFetchWorker.update({
      where: { id: created.id },
      data: { status: 'provision_failed', lastFailedAt: new Date(), lastErrorCode: code },
      select: WORKER_SELECT,
    })
    // Best-effort cleanup — the remote script may be partially deployed. Never
    // let cleanup failure mask the original provisioning error.
    try {
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=cleanup started`)
      if (driver.deprovision && input.config) {
        await driver.deprovision({ config: input.config, correlationId })
      }
      console.log(`[worker:cloudflare] correlationId=${correlationId} step=cleanup success`)
    } catch (cleanupErr) {
      console.error(`[worker:cloudflare] correlationId=${correlationId} step=cleanup failure ${String((cleanupErr as Error)?.message ?? cleanupErr)}`)
      // Swallow: the row already records provision_failed for retry/cleanup.
    }
    await createAuditLog(userId, 'worker.provision_failed', 'remote_fetch_worker', created.id, {
      name: created.name, driver: created.driver, code, correlationId, step,
    })
    // Enrich public error with correlationId but keep original code/message.
    if (error instanceof AppError) {
      const enriched: any = error
      enriched.correlationId = correlationId
      // Ensure message contains correlationId for tracing without leaking secrets.
      if (!String(enriched.message).includes('correlationId')) {
        enriched.message = `${enriched.message} (correlationId=${correlationId})`
      }
      throw enriched
    }
    // For non-AppError, wrap as WorkerProvisionError-like AppError with correlationId
    const wrapped = new AppError(code, `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED} (correlationId=${correlationId})`, 400)
    ;(wrapped as any).correlationId = correlationId
    ;(wrapped as any).cause = error
    throw wrapped
  }
}

export async function updateWorker(userId: string, id: string, input: UpdateWorkerInput) {
  const worker = await findWorker(id)
  const driver = resolveDriver(worker.driver)
  const managed = driver.getMetadata().managed

  if (!managed) {
    // Legacy manual update path — unchanged semantics.
    await driver.validateConfig({
      endpointUrl: input.endpointUrl ?? worker.endpointUrl,
      authType: input.authType ?? (worker.authType as RemoteFetchWorkerAuthType),
      secret: input.secret !== undefined ? input.secret : worker.secretEncrypted ? '<existing>' : null,
      config: input.config ?? null,
    })
    const isDefault = input.isDefault
    return prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.remoteFetchWorker.updateMany({ where: { isDefault: true, deletedAt: null, id: { not: id } }, data: { isDefault: false } })
      }
      const updated = await tx.remoteFetchWorker.update({
        where: { id },
        data: {
          name: input.name != null ? input.name : undefined,
          slug: input.slug !== undefined ? input.slug : undefined,
          driver: input.driver,
          endpointUrl: input.endpointUrl !== undefined ? input.endpointUrl : undefined,
          isEnabled: input.isEnabled,
          isDefault: input.isDefault,
          priority: input.priority !== undefined ? input.priority : undefined,
          region: input.region !== undefined ? input.region : undefined,
          description: input.description !== undefined ? input.description : undefined,
          authType: input.authType,
          // Blank/absent secret → keep existing; non-blank → replace.
          secretEncrypted: input.secret ? encryptText(input.secret) : input.secret === null ? null : undefined,
          configEncrypted: input.config ? encryptText(JSON.stringify(input.config)) : undefined,
        },
        select: WORKER_SELECT,
      })
      await createAuditLog(userId, 'worker.updated', 'remote_fetch_worker', updated.id, {
        credentialUpdated: input.secret !== undefined && Boolean(input.secret),
      })
      return updated
    }) as unknown as RemoteFetchWorker
  }

  // Managed update: driver diffs and re-deploys only what changed. The relay
  // secret is system-managed — never user-editable.
  const { config: storedConfig, apiToken } = decryptConfig(worker)
  const relaySecret = decryptSecret(worker)
  const newConfig = {
    ...storedConfig,
    ...Object.fromEntries(Object.entries(input.config ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)),
  }
  // Blank apiToken on edit → keep the stored token.
  if (!newConfig.apiToken) newConfig.apiToken = apiToken
  if (!newConfig.apiToken) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_CREDENTIAL_INVALID, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_CREDENTIAL_INVALID, 400)
  }

  if (!driver.update) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED, 400)
  }
  const correlationId = crypto.randomUUID().slice(0, 8)
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=update started workerId=${id}`)
  const result = await (driver.update as (inp: any) => Promise<any>)({
    config: newConfig,
    storedConfig,
    secret: relaySecret,
    correlationId,
  })

  const isDefault = input.isDefault
  return prisma.$transaction(async (tx) => {
    if (isDefault === true) {
      await tx.remoteFetchWorker.updateMany({ where: { isDefault: true, deletedAt: null, id: { not: id } }, data: { isDefault: false } })
    }
    const updated = await tx.remoteFetchWorker.update({
      where: { id },
      data: {
        name: (input.name && input.name.trim()) || newConfig.workerName || worker.name || '',
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
        endpointUrl: result?.endpointUrl ?? undefined,
        // Re-test needed after any change; healthy rows return to unknown.
        status: result?.endpointUrl ? 'unknown' : undefined,
        lastErrorCode: null,
        configEncrypted: result?.configEncryptedInput
          ? encryptText(JSON.stringify(result.configEncryptedInput))
          : undefined,
      },
      select: WORKER_SELECT,
    })
    await createAuditLog(userId, 'worker.updated', 'remote_fetch_worker', updated.id, {
      credentialUpdated: input.config?.apiToken ? Boolean(input.config.apiToken) : false,
      provisioned: true,
      correlationId,
    })
    return updated
  }) as unknown as RemoteFetchWorker
}

export async function enableWorker(userId: string, id: string) {
  const worker = await findWorker(id)
  if (worker.isEnabled) return worker
  const updated = await prisma.remoteFetchWorker.update({
    where: { id },
    data: { isEnabled: true, status: worker.status === 'disabled' ? 'unknown' : worker.status },
    select: WORKER_SELECT,
  })
  await createAuditLog(userId, 'worker.enabled', 'remote_fetch_worker', worker.id, { name: worker.name })
  return updated as unknown as RemoteFetchWorker
}

export async function disableWorker(userId: string, id: string) {
  const worker = await findWorker(id)
  if (!worker.isEnabled) return worker
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.remoteFetchWorker.update({
      where: { id },
      data: { isEnabled: false, isDefault: false, status: 'disabled' },
      select: WORKER_SELECT,
    })
    return row
  })
  await createAuditLog(userId, 'worker.disabled', 'remote_fetch_worker', worker.id, { name: worker.name })
  return updated as unknown as RemoteFetchWorker
}

export async function setDefaultWorker(userId: string, id: string) {
  const worker = await findWorker(id)
  if (!worker.isEnabled) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DISABLED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DISABLED, 400)
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.remoteFetchWorker.updateMany({ where: { isDefault: true, deletedAt: null, id: { not: id } }, data: { isDefault: false } })
    return tx.remoteFetchWorker.update({ where: { id }, data: { isDefault: true }, select: WORKER_SELECT })
  }) as unknown as RemoteFetchWorker
  await createAuditLog(userId, 'worker.set_default', 'remote_fetch_worker', worker.id, { name: worker.name })
  return updated
}

export type DeleteWorkerResult = {
  /**
   * deleted        — remote resource removed by the provider call
   * already_absent — remote resource was already gone (idempotent success)
   * skipped        — no remote identity stored (dummy/never-provisioned row),
   *                  so no provider call was made
   * forced_local   — admin fallback: local record only, remote may remain
   */
  result: 'deleted' | 'already_absent' | 'skipped' | 'forced_local'
}

/** Decrypt the stored managed registration with identity striping — NULL for
 * dummy/test/decorrupted rows so deletion can skip the provider call instead
 * of throwing (the old decryptConfig threw and trapped undeletable rows). */
function tryManagedIdentity(worker: RemoteFetchWorker): { accountId: string; workerName: string; apiToken: string } | null {
  if (!worker.configEncrypted) return null
  let parsed: { config?: Record<string, string>; credentials?: { apiToken?: string } }
  try {
    parsed = JSON.parse(decryptText(worker.configEncrypted)) as typeof parsed
  } catch {
    return null
  }
  const accountId = parsed.config?.accountId
  const workerName = parsed.config?.workerName
  const apiToken = parsed.credentials?.apiToken ?? ''
  if (!accountId || !workerName || !apiToken) return null
  return { accountId, workerName, apiToken }
}

async function softDeleteWorker(workerId: string) {
  return prisma.remoteFetchWorker.update({
    where: { id: workerId },
    data: { deletedAt: new Date(), isEnabled: false, isDefault: false, status: 'disabled' },
    select: WORKER_SELECT,
  }) as unknown as RemoteFetchWorker
}

/**
 * Delete a Worker. Idempotent: the remote deployment is removed FIRST, and the
 * local row is soft-deleted only once the remote resource is confirmed gone or
 * already absent. Genuine provider failures (auth, 5xx, network) preserve the
 * local row. Rows without a stored remote identity (dummy/test/provision_failed)
 * skip the provider call and delete cleanly. The account-level workers.dev
 * subdomain is shared and is never touched here.
 */
export async function deleteWorker(userId: string, id: string): Promise<DeleteWorkerResult> {
  const worker = await findWorker(id)
  const driver = resolveDriver(worker.driver)
  const managed = driver.getMetadata().managed

  if (!managed) {
    // Manual (self-hosted relay) — no provider deployment to remove.
    await softDeleteWorker(worker.id)
    await createAuditLog(userId, 'worker.deleted', 'remote_fetch_worker', worker.id, { name: worker.name, driver: worker.driver })
    return { result: 'deleted' }
  }

  const correlationId = crypto.randomUUID().slice(0, 8)
  const identity = tryManagedIdentity(worker)

  // Dummy / never-provisioned / already-cleaned rows: no remote identity → no
  // provider call → local delete succeeds (never trap the row).
  if (!identity) {
    console.log(`[worker:${worker.driver}] correlationId=${correlationId} step=deprovision workerId=${worker.id} driver=${worker.driver} remoteWorkerName=unknown status=skipped result=not_provisioned`)
    await softDeleteWorker(worker.id)
    await createAuditLog(userId, 'worker.deleted', 'remote_fetch_worker', worker.id, {
      name: worker.name, driver: worker.driver, result: 'skipped', reason: 'missing_remote_identity', correlationId,
    })
    return { result: 'skipped' }
  }

  if (!driver.deprovision) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DEPROVISION_FAILED, `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DEPROVISION_FAILED} (correlationId=${correlationId})`, 400)
  }

  console.log(`[worker:${worker.driver}] correlationId=${correlationId} step=deprovision workerId=${worker.id} driver=${worker.driver} remoteWorkerName=${identity.workerName} status=started`)
  let outcome: 'deleted' | 'already_absent'
  try {
    const dep = await driver.deprovision({ config: identity, correlationId })
    outcome = dep.result
  } catch (error) {
    const code = error instanceof AppError ? (error as AppError & { code: string }).code : 'WORKER_DEPROVISION_FAILED'
    const providerStatus = (error as any)?.providerStatus ?? (error as any)?.status ?? null
    console.error(`[worker:${worker.driver}] correlationId=${correlationId} step=deprovision workerId=${worker.id} driver=${worker.driver} remoteWorkerName=${identity.workerName} status=failed result=failed code=${code} providerStatus=${providerStatus ?? 'null'}`)
    await createAuditLog(userId, 'worker.deprovision_failed', 'remote_fetch_worker', worker.id, {
      name: worker.name, driver: worker.driver, remoteWorkerName: identity.workerName, code, providerStatus, correlationId,
    })
    throw new AppError(
      REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DEPROVISION_FAILED,
      `${REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DEPROVISION_FAILED} (correlationId=${correlationId})`,
      400,
    )
  }

  console.log(`[worker:${worker.driver}] correlationId=${correlationId} step=deprovision workerId=${worker.id} driver=${worker.driver} remoteWorkerName=${identity.workerName} status=success result=${outcome}`)
  await softDeleteWorker(worker.id)
  await createAuditLog(userId, 'worker.deprovisioned', 'remote_fetch_worker', worker.id, { name: worker.name, driver: worker.driver, result: outcome, correlationId })
  await createAuditLog(userId, 'worker.deleted', 'remote_fetch_worker', worker.id, { name: worker.name, driver: worker.driver, result: outcome, correlationId })
  return { result: outcome }
}

/**
 * Admin fallback: delete the local record WITHOUT touching the provider.
 * Never automatic — callers must explicitly confirm. The remote resource may
 * remain at the provider; this is recorded in the audit trail.
 */
export async function forceDeleteWorkerLocal(userId: string, id: string): Promise<DeleteWorkerResult> {
  const worker = await findWorker(id)
  const driver = resolveDriver(worker.driver)
  const identity = tryManagedIdentity(worker)
  const correlationId = crypto.randomUUID().slice(0, 8)
  console.warn(
    `[worker:${worker.driver}] correlationId=${correlationId} step=deprovision_forced_local workerId=${worker.id} driver=${worker.driver} remoteWorkerName=${identity?.workerName ?? 'unknown'} status=forced result=forced_local WARNING=remote_provider_resource_may_remain`,
  )
  await softDeleteWorker(worker.id)
  await createAuditLog(userId, 'worker.force_deleted_local', 'remote_fetch_worker', worker.id, {
    name: worker.name,
    driver: worker.driver,
    remoteWorkerName: identity?.workerName ?? null,
    warning: 'remote provider resource may remain',
    correlationId,
  })
  return { result: 'forced_local' }
}

export type WorkerTestResult = {
  status: 'healthy' | 'unhealthy'
  lastHealthCheckAt: Date
  lastErrorCode?: string | null
}

/** Drive a test connection: driver → endpoint, persist status + safe caps. */
export async function testWorkerConnection(userId: string, id: string): Promise<WorkerTestResult> {
  const worker = await findWorker(id)
  if (!worker.endpointUrl) {
    throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED, 400)
  }
  const driver = resolveDriver(worker.driver)
  const secret = worker.secretEncrypted ? decryptText(worker.secretEncrypted) : null
  const now = new Date()
  const correlationId = crypto.randomUUID().slice(0, 8)
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=test_connection started workerId=${id} endpoint=${worker.endpointUrl}`)
  let probe
  try {
    probe = await driver.testConnection({
      endpointUrl: worker.endpointUrl,
      authType: worker.authType as RemoteFetchWorkerAuthType,
      secret,
      correlationId,
    })
  } catch (error) {
    const code = error instanceof AppError ? error.code : REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY
    console.error(`[worker:cloudflare] correlationId=${correlationId} step=test_connection failed code=${code}`)
    await prisma.remoteFetchWorker.update({
      where: { id: worker.id },
      data: { status: 'unhealthy', lastHealthCheckAt: now, lastFailedAt: now, lastErrorCode: code },
      select: WORKER_SELECT,
    })
    await createAuditLog(userId, 'worker.test_failed', 'remote_fetch_worker', worker.id, { code, correlationId })
    return { status: 'unhealthy', lastHealthCheckAt: now, lastErrorCode: code }
  }
  console.log(`[worker:cloudflare] correlationId=${correlationId} step=test_connection success workerId=${id}`)
  await prisma.remoteFetchWorker.update({
    where: { id: worker.id },
    data: {
      status: 'healthy',
      lastHealthCheckAt: now,
      lastHealthyAt: now,
      lastFailedAt: null,
      lastErrorCode: null,
      capabilitiesJson: probe.capabilities as Prisma.InputJsonValue,
      metadataJson: { protocolVersion: probe.protocolVersion ?? null, correlationId } as Prisma.InputJsonValue,
    },
    select: WORKER_SELECT,
  })
  await createAuditLog(userId, 'worker.test_succeeded', 'remote_fetch_worker', worker.id, { protocolVersion: probe.protocolVersion ?? null, correlationId })
  return { status: 'healthy', lastHealthCheckAt: now }
}
