import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { encryptText, decryptText, randomToken } from '../../utils/crypto.js'
import { resolveDriver } from './driver-registry.js'
import { REMOTE_FETCH_WORKER_ERROR_CODES, REMOTE_FETCH_WORKER_ERROR_MESSAGES } from './errors.js'
import type { RemoteFetchWorkerAuthType } from './types.js'
import type { RemoteFetchWorker, Prisma } from '@prisma/client'

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
  const validated = await driver.validateConfig({
    endpointUrl: null,
    config: input.config ?? null,
  })
  const relaySecret = randomToken(32)
  const isDefault = input.isDefault ?? false
  const workerName = input.config?.workerName ?? 'Worker'
  const name = input.name?.trim() || workerName

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
  await createAuditLog(userId, 'worker.provisioning_started', 'remote_fetch_worker', created.id, { name: created.name, driver: created.driver })

  try {
    if (!driver.provision) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_PROVISION_FAILED, 400)
    }
    const result = await driver.provision({
      config: input.config ?? {},
      secret: relaySecret,
    })
    const probe = await driver.testConnection({
      endpointUrl: result.endpointUrl,
      authType: 'hmac',
      secret: relaySecret,
    })
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
        metadataJson: { provider: driver.displayName, protocolVersion: probe.protocolVersion ?? result.protocolVersion ?? null } as Prisma.InputJsonValue,
        configEncrypted: result.configEncryptedInput
          ? encryptText(JSON.stringify(result.configEncryptedInput))
          : undefined,
      },
      select: WORKER_SELECT,
    })
    await createAuditLog(userId, 'worker.provisioned', 'remote_fetch_worker', created.id, { name: healthy.name, driver: healthy.driver })
    return healthy as unknown as RemoteFetchWorker
  } catch (error) {
    const code = error instanceof AppError ? error.code : REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_PROVISION_FAILED
    await prisma.remoteFetchWorker.update({
      where: { id: created.id },
      data: { status: 'provision_failed', lastFailedAt: new Date(), lastErrorCode: code },
      select: WORKER_SELECT,
    })
    // Best-effort cleanup — the remote script may be partially deployed. Never
    // let cleanup failure mask the original provisioning error.
    try {
      if (driver.deprovision && input.config) {
        await driver.deprovision({ config: input.config })
      }
    } catch {
      // Swallow: the row already records provision_failed for retry/cleanup.
    }
    await createAuditLog(userId, 'worker.provision_failed', 'remote_fetch_worker', created.id, {
      name: created.name, driver: created.driver, code,
    })
    throw error
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
  const result = await driver.update({
    config: newConfig,
    storedConfig,
    secret: relaySecret,
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

export async function deleteWorker(userId: string, id: string) {
  const worker = await findWorker(id)
  const driver = resolveDriver(worker.driver)
  const managed = driver.getMetadata().managed

  // Managed: remove the remote deployment FIRST. If the provider refuses, do
  // NOT soft-delete — the remote script would be orphaned (spec §22).
  if (managed) {
    const { config } = decryptConfig(worker)
    if (!driver.deprovision) {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DEPROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DEPROVISION_FAILED, 400)
    }
    try {
      await driver.deprovision({ config })
    } catch {
      throw new AppError(REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_DEPROVISION_FAILED, REMOTE_FETCH_WORKER_ERROR_MESSAGES.WORKER_DEPROVISION_FAILED, 400)
    }
    await createAuditLog(userId, 'worker.deprovisioned', 'remote_fetch_worker', worker.id, { name: worker.name, driver: worker.driver })
  }

  const updated = await prisma.remoteFetchWorker.update({
    where: { id },
    data: { deletedAt: new Date(), isEnabled: false, isDefault: false, status: 'disabled' },
    select: WORKER_SELECT,
  })
  await createAuditLog(userId, 'worker.deleted', 'remote_fetch_worker', worker.id, { name: worker.name })
  return updated as unknown as RemoteFetchWorker
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
  let probe
  try {
    probe = await driver.testConnection({
      endpointUrl: worker.endpointUrl,
      authType: worker.authType as RemoteFetchWorkerAuthType,
      secret,
    })
  } catch (error) {
    const code = error instanceof AppError ? error.code : REMOTE_FETCH_WORKER_ERROR_CODES.WORKER_UNHEALTHY
    await prisma.remoteFetchWorker.update({
      where: { id: worker.id },
      data: { status: 'unhealthy', lastHealthCheckAt: now, lastFailedAt: now, lastErrorCode: code },
      select: WORKER_SELECT,
    })
    await createAuditLog(userId, 'worker.test_failed', 'remote_fetch_worker', worker.id, { code })
    return { status: 'unhealthy', lastHealthCheckAt: now, lastErrorCode: code }
  }
  await prisma.remoteFetchWorker.update({
    where: { id: worker.id },
    data: {
      status: 'healthy',
      lastHealthCheckAt: now,
      lastHealthyAt: now,
      lastFailedAt: null,
      lastErrorCode: null,
      capabilitiesJson: probe.capabilities as Prisma.InputJsonValue,
      metadataJson: { protocolVersion: probe.protocolVersion ?? null } as Prisma.InputJsonValue,
    },
    select: WORKER_SELECT,
  })
  await createAuditLog(userId, 'worker.test_succeeded', 'remote_fetch_worker', worker.id, { protocolVersion: probe.protocolVersion ?? null })
  return { status: 'healthy', lastHealthCheckAt: now }
}
