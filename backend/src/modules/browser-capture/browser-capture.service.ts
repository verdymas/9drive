import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { encryptText, decryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { validateRemoteUrl } from '../remote-imports/ssrf.js'
import {
  validateRequestContext,
  encryptRequestContext,
  decryptRequestContext,
  serializeRequestContext,
  type RemoteImportRequestContext,
} from '../remote-imports/request-context.js'
import { createRemoteImport, type CreateRemoteImportHlsOptions } from '../remote-imports/remote-import.service.js'
import { probeRemoteUrl } from '../remote-imports/probe.js'
import { CAPTURED_RESOURCE_TTL_MS, RESOURCE_TYPES, type CapturedResourceType } from './capture-types.js'

/**
 * Browser Capture service — device pairing/registration + captured-resource
 * lifecycle. The extension authenticates with a hashed device token (same
 * pattern as refresh/API-key tokens); captured URLs are untrusted input,
 * validated here (syntax/policy/literal-IP) AND again at import time by the
 * full Remote Import URL gate.
 */

const PAIRING_TTL_MS = 10 * 60_000
export const DEVICE_TOKEN_PREFIX = 'bd_'
const FILENAME_MAX = 255

// ── Pairing (dashboard → extension handshake) ───────────────────────────────

function assertCaptureEnabled() {
  if (!env.BROWSER_CAPTURE_ENABLED) throw new AppError('BROWSER_CAPTURE_DISABLED', 'Browser capture is disabled.', 403)
}

/** Create a one-time pairing code for a logged-in user (shown in the dashboard UI). */
export async function createDevicePairing(userId: string) {
  assertCaptureEnabled()
  const code = randomToken(24)
  const row = await prisma.browserDevicePairing.create({
    data: { userId, codeHash: hashToken(code), expiresAt: new Date(Date.now() + PAIRING_TTL_MS) },
  })
  return { id: row.id, code, expiresAt: row.expiresAt.toISOString() }
}

export type DeviceRegistrationInput = {
  pairingCode: string
  name: string
  browser: string
  platform: string
  extensionVersion?: string | null
}

/** Exchange a valid pairing code for a device + one-time-shown device token. */
export async function registerBrowserDevice(input: DeviceRegistrationInput) {
  assertCaptureEnabled()
  const pairing = await prisma.browserDevicePairing.findUnique({ where: { codeHash: hashToken(input.pairingCode) } })
  if (!pairing || pairing.usedAt || pairing.expiresAt < new Date()) {
    throw new AppError('BROWSER_PAIRING_INVALID', 'The pairing code is invalid or expired.', 400)
  }

  // One CAS winner: concurrent registrations of the same code → conflict.
  const claimed = await prisma.browserDevicePairing.updateMany({
    where: { id: pairing.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (claimed.count !== 1) throw new AppError('BROWSER_PAIRING_INVALID', 'The pairing code is invalid or expired.', 400)

  const deviceToken = DEVICE_TOKEN_PREFIX + randomToken(32)
  const device = await prisma.browserDevice.create({
    data: {
      userId: pairing.userId,
      name: input.name.slice(0, 191),
      browser: input.browser.slice(0, 64),
      platform: input.platform.slice(0, 64),
      extensionVersion: input.extensionVersion?.slice(0, 32) ?? null,
      deviceTokenHash: hashToken(deviceToken),
    },
  })
  await createAuditLog(pairing.userId, 'browser_device.registered', 'browser_device', device.id, { name: device.name, browser: device.browser })
  return { device: serializeDevice(device), deviceToken }
}

// ── Dashboard-side device management ────────────────────────────────────────

function serializeDevice(device: {
  id: string
  name: string
  browser: string
  platform: string
  extensionVersion: string | null
  status: string
  lastSeenAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}) {
  return {
    id: device.id,
    name: device.name,
    browser: device.browser,
    platform: device.platform,
    extensionVersion: device.extensionVersion,
    status: device.status,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    revokedAt: device.revokedAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
  }
}

export async function listDevices(userId: string) {
  const devices = await prisma.browserDevice.findMany({
    where: { userId, status: { not: 'revoked' } },
    orderBy: { createdAt: 'desc' },
  })
  return devices.map(serializeDevice)
}

export async function renameDevice(userId: string, deviceId: string, name: string) {
  const updated = await prisma.browserDevice.updateMany({
    where: { id: deviceId, userId, status: { not: 'revoked' } },
    data: { name: name.slice(0, 191) },
  })
  if (updated.count === 0) throw new AppError('BROWSER_DEVICE_NOT_FOUND', 'Browser device not found.', 404)
}

export async function revokeDevice(userId: string, deviceId: string) {
  const updated = await prisma.browserDevice.updateMany({
    where: { id: deviceId, userId, status: { not: 'revoked' } },
    data: { status: 'revoked', revokedAt: new Date() },
  })
  if (updated.count === 0) throw new AppError('BROWSER_DEVICE_NOT_FOUND', 'Browser device not found.', 404)
  await createAuditLog(userId, 'browser_device.revoked', 'browser_device', deviceId)
}

/** Rotate the credential: the old token stops working, the new one returns once. */
export async function rotateDeviceCredential(userId: string, deviceId: string) {
  const device = await prisma.browserDevice.findFirst({ where: { id: deviceId, userId, status: { not: 'revoked' } } })
  if (!device) throw new AppError('BROWSER_DEVICE_NOT_FOUND', 'Browser device not found.', 404)
  const deviceToken = DEVICE_TOKEN_PREFIX + randomToken(32)
  await prisma.browserDevice.update({ where: { id: device.id }, data: { deviceTokenHash: hashToken(deviceToken) } })
  await createAuditLog(userId, 'browser_device.rotated', 'browser_device', device.id)
  return { deviceToken }
}

// ── Extension-facing operations (device-token authenticated) ─────────────────

export async function heartbeatDevice(deviceId: string, extensionVersion?: string | null) {
  await prisma.browserDevice.update({
    where: { id: deviceId },
    data: { lastSeenAt: new Date(), ...(extensionVersion ? { extensionVersion: extensionVersion.slice(0, 32) } : {}) },
  }).catch(() => undefined)
}

export type SubmitResourceInput = {
  deviceId: string
  userId: string
  url: string
  type: CapturedResourceType
  mimeType?: string | null
  filename?: string | null
  pageUrl?: string | null
  pageTitle?: string | null
  requestContext?: Partial<RemoteImportRequestContext> | null
}

/**
 * Submit a detected resource. Dedupes on (user, displayUrl, type) among
 * pending rows — a re-detected manifest refreshes its TTL instead of piling up
 * duplicates. Ceiling: signed-query variants share the display path, which is
 * exactly the dedupe we want (one logical capture per resource).
 */
export async function submitCapturedResource(input: SubmitResourceInput) {
  assertCaptureEnabled()
  if (!RESOURCE_TYPES.includes(input.type)) {
    throw new AppError('CAPTURE_TYPE_INVALID', `Resource type must be one of: ${RESOURCE_TYPES.join(', ')}.`, 400)
  }

  // Policy validation without DNS resolution — the import path re-validates
  // fully (Direct mode resolves there; relay mode defers to the worker edge).
  let parsedUrl: URL
  try {
    parsedUrl = await validateRemoteUrl(input.url, { resolveDns: false })
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_URL') {
      throw new AppError('CAPTURE_URL_INVALID', 'The captured URL is not valid.', 400)
    }
    throw error
  }

  // Safe display URL: strip query + hash (signed params never reach the UI).
  const u = new URL(parsedUrl.href)
  u.search = ''
  u.hash = ''
  const displayUrl = u.href

  const filename = sanitizeCapturedFilename(input.filename ?? deriveFilenameFromUrl(parsedUrl))
  const pageTitle = input.pageTitle ? input.pageTitle.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 512) : null

  // Cookie never crosses the capture boundary — strip before validation.
  const requestContext = validateRequestContext(stripSensitiveContext(input.requestContext))

  const existing = await prisma.capturedResource.findFirst({
    where: { userId: input.userId, displayUrl, type: input.type, status: 'pending' },
    orderBy: { detectedAt: 'desc' },
  })
  if (existing) {
    const refreshed = await prisma.capturedResource.update({
      where: { id: existing.id },
      data: {
        detectedAt: new Date(),
        expiresAt: new Date(Date.now() + CAPTURED_RESOURCE_TTL_MS),
        // A re-detection may carry a fresher page title / context.
        pageTitle: pageTitle ?? existing.pageTitle,
        requestContextEncrypted: requestContext ? encryptRequestContext(requestContext) : existing.requestContextEncrypted,
      },
    })
    return serializeCapturedResource(refreshed)
  }

  const row = await prisma.capturedResource.create({
    data: {
      browserDeviceId: input.deviceId,
      userId: input.userId,
      urlEncrypted: encryptText(parsedUrl.href),
      displayUrl,
      type: input.type,
      mimeType: input.mimeType ? input.mimeType.slice(0, 191) : null,
      filename,
      pageUrl: input.pageUrl ? input.pageUrl.slice(0, 4096) : null,
      pageTitle,
      requestContextEncrypted: requestContext ? encryptRequestContext(requestContext) : null,
      status: 'pending',
      expiresAt: new Date(Date.now() + CAPTURED_RESOURCE_TTL_MS),
    },
  })
  return serializeCapturedResource(row)
}

function stripSensitiveContext(ctx: Partial<RemoteImportRequestContext> | null | undefined): Partial<RemoteImportRequestContext> | null {
  if (!ctx || typeof ctx !== 'object') return null
  const safe: Partial<RemoteImportRequestContext> = {}
  if (ctx.referer != null) safe.referer = ctx.referer
  if (ctx.origin != null) safe.origin = ctx.origin
  if (ctx.userAgent != null) safe.userAgent = ctx.userAgent
  return Object.keys(safe).length > 0 ? safe : null
}

/** Strip path separators/control chars; cap length; keep a non-empty fallback. */
function sanitizeCapturedFilename(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]+/g, '-')
    .replace(/[ -]+/g, '')
    .trim()
  return (cleaned || 'captured-file').slice(0, FILENAME_MAX)
}

/** Last URL path segment as fallback filename (never query strings). */
function deriveFilenameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop()
  if (!last) return 'captured-file'
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

// ── Listing / consumption ───────────────────────────────────────────────────

/**
 * List pending resources for a user. Rows past TTL are marked expired lazily
 * on read (the periodic sweep is Phase 07).
 */
export async function listCapturedResources(userId: string, opts: { limit?: number; cursor?: string } = {}) {
  const now = new Date()
  const rows = await prisma.capturedResource.findMany({
    where: { userId, status: 'pending', ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
    orderBy: [{ detectedAt: 'desc' }],
    take: Math.min(opts.limit ?? 100, 200),
  })
  const staleIds = rows.filter((r) => r.expiresAt < now).map((r) => r.id)
  if (staleIds.length > 0) {
    await prisma.capturedResource.updateMany({ where: { id: { in: staleIds }, status: 'pending' }, data: { status: 'expired' } })
    const staleSet = new Set(staleIds)
    return rows.filter((r) => !staleSet.has(r.id)).map(serializeCapturedResource)
  }
  return rows.map(serializeCapturedResource)
}

export async function countPendingResources(userId: string): Promise<number> {
  return prisma.capturedResource.count({
    where: { userId, status: 'pending', expiresAt: { gt: new Date() } },
  })
}

export async function markResourcesConsumed(userId: string, ids: string[]) {
  if (ids.length === 0) return
  await prisma.capturedResource.updateMany({
    where: { id: { in: ids }, userId, status: 'pending' },
    data: { status: 'consumed', importedAt: new Date() },
  })
}

export async function deleteCapturedResource(userId: string, resourceId: string) {
  const updated = await prisma.capturedResource.updateMany({
    where: { id: resourceId, userId, status: 'pending' },
    data: { status: 'deleted' },
  })
  if (updated.count === 0) throw new AppError('CAPTURED_RESOURCE_NOT_FOUND', 'Captured resource not found.', 404)
}

// ── Wire shape ──────────────────────────────────────────────────────────────

/**
 * Import a captured resource through the EXISTING Remote Import pipeline
 * (spec Phase 03: no second downloader, no client-supplied URL when an id
 * exists). Loads the row server-side, decrypts the stored URL, and re-uses
 * `createRemoteImport` — so SSRF validation, worker resolution, HLS handling,
 * filename sanitization, queueing and retries are all inherited unchanged.
 *
 * Filename priority (spec): explicit user filename → captured filename →
 * Remote Import's own Content-Disposition/URL/fallback logic.
 */
export async function importCapturedResource(
  userId: string,
  resourceId: string,
  input: { filename?: string | null; folderId?: string | null; connectedAccountId?: string | null; workerId?: string | null },
) {
  assertCaptureEnabled()
  const resource = await prisma.capturedResource.findFirst({ where: { id: resourceId, userId } })
  if (!resource) throw new AppError('CAPTURED_RESOURCE_NOT_FOUND', 'Captured resource not found.', 404)
  if (resource.status === 'expired' || (resource.status === 'pending' && resource.expiresAt < new Date())) {
    if (resource.status === 'pending') {
      await prisma.capturedResource.updateMany({ where: { id: resource.id, status: 'pending' }, data: { status: 'expired' } })
    }
    throw new AppError('CAPTURED_RESOURCE_EXPIRED', 'This captured resource has expired. Capture it again.', 410)
  }
  if (resource.status !== 'pending') {
    throw new AppError('CAPTURED_RESOURCE_NOT_IMPORTABLE', 'Only pending resources can be imported.', 409)
  }

  const sourceUrl = decryptText(resource.urlEncrypted)
  const requestContext = decryptRequestContext(resource.requestContextEncrypted)

  // HLS captures must enter the existing HLS pipeline, not the generic
  // direct-download path (which would save the manifest as a file). The probe
  // runs through the SAME selected worker transport and confirms/refutes HLS;
  // the create call below then persists `sourceType`, which is what
  // processor.ts's isHlsRecord() routes on.
  let hls: CreateRemoteImportHlsOptions | undefined
  let mimeType = resource.mimeType
  if (resource.type === 'hls') {
    const probed = await probeRemoteUrl(sourceUrl, resource.id, requestContext ?? undefined, { workerId: input.workerId ?? null })
    if (probed.sourceType !== 'hls_master' && probed.sourceType !== 'hls_media') {
      throw new AppError('CAPTURE_NOT_HLS', 'This captured resource is no longer a valid HLS stream.', 400)
    }
    if (!probed.hls?.isFinite) {
      // Live/event sources need a recording duration — that choice lives in the
      // dashboard's Remote Import modal; the extension popup has no such field.
      throw new AppError('CAPTURE_LIVE_HLS_UNSUPPORTED', 'Live streams cannot be imported from the extension. Use Remote Import in the 9Drive dashboard to set a recording duration.', 400)
    }
    // Default container honors REMOTE_IMPORT_HLS_DEFAULT_CONTAINER ('mp4'
    // selects MP4 explicitly; anything else → auto, which resolves to MKV).
    const envContainer = String(env.REMOTE_IMPORT_HLS_DEFAULT_CONTAINER).toLowerCase()
    hls = { sourceType: probed.sourceType, outputContainer: envContainer === 'mp4' ? 'mp4' : 'auto' }
    // The manifest MIME must not label the remuxed output — the processor
    // derives video/x-matroska|video/mp4 from the actual container when null.
    mimeType = null
  }

  // The import is created FIRST with its own worker guard + URL gate; the
  // capture row is consumed only after creation succeeds, so a failed create
  // never loses the capture.
  const remoteImport = await createRemoteImport({
    userId,
    sourceUrl,
    // Captured context (referer/origin/userAgent) flows to the same encrypted
    // request-context column Remote Import already manages.
    requestContext,
    folderId: input.folderId ?? null,
    connectedAccountId: input.connectedAccountId ?? null,
    workerId: input.workerId ?? null,
    // Priority chain: user override wins, else the captured filename (already
    // sanitized at submit; sanitized again inside createRemoteImport).
    fileName: input.filename?.trim() || resource.filename,
    mimeType,
    ...(hls ? { hls } : {}),
  })

  await prisma.capturedResource.updateMany({
    where: { id: resource.id, status: 'pending' },
    data: { status: 'consumed', importedAt: new Date() },
  })
  await createAuditLog(userId, 'capture.imported', 'captured_resource', resource.id, { remoteImportId: remoteImport.id })

  return { remoteImport, resource: serializeCapturedResource({ ...resource, status: 'consumed', importedAt: new Date() }) }
}

/**
 * Safe wire shape: never the encrypted blobs, never decrypted values. The
 * request context surfaces as booleans only (same convention as Remote Import).
 */
export function serializeCapturedResource(row: any) {
  const { urlEncrypted: _u, requestContextEncrypted: _c, ...rest } = row
  return {
    ...rest,
    url: rest.displayUrl,
    requestContext: serializeRequestContext(decryptRequestContext(row.requestContextEncrypted)),
    expiresAt: row.expiresAt.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    importedAt: row.importedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
