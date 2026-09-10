import { once } from 'events'
import { mkdtemp, rm, stat } from 'fs/promises'
import type { Server } from 'http'
import os from 'os'
import path from 'path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  let nextSession = 1
  const driveCreate = vi.fn()
  const driveDelete = vi.fn(async () => undefined)
  const permissionCreate = vi.fn(async () => ({}))
  const resolvePlacement = vi.fn()
  const env = { MAX_UPLOAD_BYTES: 5, UPLOAD_TEMP_DIR: '' }
  const getTelegramConfig = vi.fn(async () => ({}))
  const uploadTelegramDocumentWithCrypto = vi.fn(async () => ({ remoteId: 'telegram-remote' }))
  const getS3ConfigForAccount = vi.fn(async () => ({ prefix: '9drive' }))
  const uploadS3Object = vi.fn()
  const deleteS3ObjectByKey = vi.fn(async () => undefined)
  const deleteTelegramDocuments = vi.fn(async () => [])
  const prismaMock = {
    uploadSession: {
      create: vi.fn(async () => ({ id: `session-${nextSession++}` })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, name: 'telegram.txt', sizeBytes: 3n, ...data })),
    },
    file: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `file-${nextSession}`, ...data })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, name: 'stored.txt', sizeBytes: 3n, ...data })),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: 'stored.txt', sizeBytes: 3n })),
    },
  }
  return { driveCreate, driveDelete, permissionCreate, prismaMock, resolvePlacement, env, getTelegramConfig, uploadTelegramDocumentWithCrypto, getS3ConfigForAccount, uploadS3Object, deleteS3ObjectByKey, deleteTelegramDocuments, resetSession: () => { nextSession = 1 } }
})

vi.mock('../../config/env.js', () => ({ env: h.env }))
vi.mock('../../config/prisma.js', () => ({ prisma: h.prismaMock }))
vi.mock('../google/google.service.js', () => ({ getAuthedGoogleClient: vi.fn(async () => ({})), syncGoogleQuota: vi.fn(async () => undefined) }))
vi.mock('../s3/s3.service.js', () => ({ buildS3ObjectKey: vi.fn(() => '9drive/object'), deleteS3ObjectByKey: h.deleteS3ObjectByKey, getS3ConfigForAccount: h.getS3ConfigForAccount, syncS3Quota: vi.fn(async () => undefined), uploadS3Object: h.uploadS3Object }))
vi.mock('../telegram/telegram.service.js', () => ({ deleteTelegramDocuments: h.deleteTelegramDocuments, getTelegramConfig: h.getTelegramConfig, uploadTelegramDocument: vi.fn() }))
vi.mock('../telegram/telegram-usage.service.js', () => ({ syncTelegramUsage: vi.fn(async () => undefined) }))
vi.mock('../telegram/telegram-caption.service.js', () => ({ uploadTelegramDocumentWithCrypto: h.uploadTelegramDocumentWithCrypto }))
vi.mock('../telegram/telegram-metadata-cache.js', () => ({ buildTelegramMetadataCache: vi.fn(() => ({})) }))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: vi.fn() }))
vi.mock('./storage-routing.service.js', () => ({ planBatchUploads: vi.fn() }))
vi.mock('../storage/upload-placement.service.js', () => ({ resolveUploadPlacement: h.resolvePlacement }))
vi.mock('../storage/provider-folder.service.js', () => ({
  ensureProviderRoot: vi.fn(async () => 'provider-root'),
  resolveUploadParent: vi.fn(() => 'provider-root'),
}))
vi.mock('../files/file-logical-path.js', () => ({ logicalPathForFileId: vi.fn() }))
vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({
      files: { create: h.driveCreate, delete: h.driveDelete },
      permissions: { create: h.permissionCreate },
    })),
  },
}))

import { handleUpload } from './upload.routes.js'
import { multipartTempUploadPath } from './upload-temp-files.js'

const placement = {
  connectedAccount: { id: 'account-1', provider: 'google_drive' },
  folderStorageLocation: { providerFolderId: 'provider-root' },
}

let server: Server | undefined
let uploadTempDir = ''

async function startServer() {
  const app = express()
  app.post('/', (req, res, next) => {
    ;(req as any).user = { id: 'user-1' }
    return handleUpload(req as any, res, next)
  })
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  return `http://127.0.0.1:${address.port}`
}

async function postForm(form: FormData) {
  const url = await startServer()
  const response = await fetch(url, { method: 'POST', body: form })
  return { response, body: await response.json() }
}

async function postRaw(body: string, contentType: string) {
  const url = await startServer()
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body })
  return { response, body: await response.json() }
}

function appendFile(form: FormData, fieldName: string, name: string, bytes: string) {
  form.append(fieldName, new Blob([bytes], { type: 'text/plain' }), name)
}

describe('POST /uploads multipart compatibility contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    h.resetSession()
    uploadTempDir = await mkdtemp(path.join(os.tmpdir(), '9drive-multipart-route-'))
    h.env.UPLOAD_TEMP_DIR = uploadTempDir
    h.resolvePlacement.mockResolvedValue(placement)
    h.driveCreate.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => ({
      data: { id: `remote-${requestBody.name}`, name: requestBody.name, mimeType: 'text/plain' },
    }))
  })

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    server = undefined
    await rm(uploadTempDir, { recursive: true, force: true })
  })

  it('returns the legacy single-file response and routes to the declared folder', async () => {
    const form = new FormData()
    form.append('sizeBytes', '3')
    form.append('fileName', 'report.txt')
    form.append('mimeType', 'text/plain')
    form.append('folderId', 'folder-1')
    appendFile(form, 'file', 'ignored.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ file: { id: 'file-2', name: 'report.txt', sizeBytes: '3', folderId: 'folder-1' } })
    expect(h.resolvePlacement).toHaveBeenCalledWith('user-1', 'folder-1', undefined, 3n, expect.any(Map), 'multipart')
    expect(h.driveCreate.mock.calls[0]?.[0].media.body).toHaveProperty('pipe')
    expect(Buffer.isBuffer(h.driveCreate.mock.calls[0]?.[0].media.body)).toBe(false)
    expect(h.driveCreate.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it('rejects a non-multipart request before parsing or routing', async () => {
    const { response, body } = await postRaw('not multipart', 'text/plain')

    expect(response.status).toBe(400)
    expect(body).toEqual({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })
    expect(h.resolvePlacement).not.toHaveBeenCalled()
  })

  it('rejects a multipart request with no file part', async () => {
    const form = new FormData()
    form.append('sizeBytes', '3')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toEqual({ code: 'UPLOAD_FILE_REQUIRED', message: 'file field required.' })
    expect(h.resolvePlacement).not.toHaveBeenCalled()
  })

  it('uses filesMeta to retain batch response shape and per-file folder metadata', async () => {
    const form = new FormData()
    form.append('filesMeta', JSON.stringify([
      { fieldName: 'file-0', fileName: 'one.txt', mimeType: 'text/plain', sizeBytes: '3', folderId: 'folder-1' },
      { fieldName: 'file-1', fileName: 'two.txt', mimeType: 'text/plain', sizeBytes: 3, folderId: 'folder-2' },
    ]))
    appendFile(form, 'file-0', 'ignored-one.txt', 'one')
    appendFile(form, 'file-1', 'ignored-two.txt', 'two')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ failed: [] })
    expect(body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'one.txt', folderId: 'folder-1' }),
      expect.objectContaining({ name: 'two.txt', folderId: 'folder-2' }),
    ]))
  })

  it('rejects a file with no declared size before selecting an account', async () => {
    const form = new FormData()
    appendFile(form, 'file', 'report.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_SIZE_REQUIRED', failed: [{ fileName: 'report.txt', code: 'UPLOAD_SIZE_REQUIRED' }] })
    expect(h.resolvePlacement).not.toHaveBeenCalled()
  })

  it('rejects an over-limit declared size before selecting an account', async () => {
    const form = new FormData()
    form.append('sizeBytes', '6')
    appendFile(form, 'file', 'large.txt', '12345')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_TOO_LARGE', failed: [{ fileName: 'large.txt', code: 'UPLOAD_TOO_LARGE' }] })
    expect(h.resolvePlacement).not.toHaveBeenCalled()
  })

  it('rejects a stream that exceeds the maximum even when its declared size is at the limit', async () => {
    const form = new FormData()
    form.append('sizeBytes', '5')
    appendFile(form, 'file', 'truncated.txt', '123456')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_TOO_LARGE', failed: [{ fileName: 'truncated.txt', code: 'UPLOAD_TOO_LARGE' }] })
    expect(h.driveCreate).not.toHaveBeenCalled()
  })

  it('fails a declared/streamed byte mismatch before provider transfer or File registration', async () => {
    const form = new FormData()
    form.append('sizeBytes', '4')
    appendFile(form, 'file', 'short.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH', failed: [{ fileName: 'short.txt', code: 'UPLOAD_SIZE_MISMATCH' }] })
    expect(h.driveCreate).not.toHaveBeenCalled()
    expect(h.prismaMock.file.create).not.toHaveBeenCalled()
    expect(h.prismaMock.uploadSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }))
  })

  it('returns a provider failure when no file can be uploaded', async () => {
    h.driveCreate.mockRejectedValueOnce(new Error('provider unavailable'))
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'error.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_FAILED', message: 'provider unavailable', failed: [{ fileName: 'error.txt', code: 'UPLOAD_FAILED' }] })
  })

  it('does not return a completed file when finalizing its upload session fails', async () => {
    h.prismaMock.uploadSession.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.status === 'completed') throw new Error('session write failed')
      return {}
    })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'session-failure.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_FAILED', message: 'session write failed', failed: [{ fileName: 'session-failure.txt', code: 'UPLOAD_FAILED' }] })
    expect(body).not.toHaveProperty('files')
    expect(h.prismaMock.file.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'deleted' }) }))
  })

  it('maps no eligible account to the multipart compatibility error code', async () => {
    h.resolvePlacement.mockRejectedValueOnce({ code: 'AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT', message: 'No space.' })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'full.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No space.' })
  })

  it('keeps a successful batch file when another provider call fails', async () => {
    h.driveCreate.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => {
      if (requestBody.name === 'bad.txt') throw new Error('provider unavailable')
      return { data: { id: `remote-${requestBody.name}`, name: requestBody.name, mimeType: 'text/plain' } }
    })
    const form = new FormData()
    form.append('filesMeta', JSON.stringify([
      { fieldName: 'file-0', fileName: 'good.txt', mimeType: 'text/plain', sizeBytes: 3 },
      { fieldName: 'file-1', fileName: 'bad.txt', mimeType: 'text/plain', sizeBytes: 3 },
    ]))
    appendFile(form, 'file-0', 'good.txt', 'yes')
    appendFile(form, 'file-1', 'bad.txt', 'no!')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ files: [{ name: 'good.txt' }], failed: [{ fileName: 'bad.txt', code: 'UPLOAD_FAILED', message: 'provider unavailable' }] })
  })

  it('removes a multipart Telegram staging file after a provider failure', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: { id: 'telegram-account', provider: 'telegram' },
      folderStorageLocation: { providerFolderId: 'provider-root' },
    })
    h.uploadTelegramDocumentWithCrypto.mockRejectedValueOnce(new Error('Telegram unavailable'))
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'telegram.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_FAILED', message: 'Telegram unavailable' })
    await expect(stat(multipartTempUploadPath(uploadTempDir, 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes a session-scoped spool path through the Telegram success path', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: { id: 'telegram-account', provider: 'telegram' },
      folderStorageLocation: { providerFolderId: 'provider-root' },
    })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'telegram-success.txt', 'abc')

    const { response } = await postForm(form)

    expect(response.status).toBe(201)
    expect(h.uploadTelegramDocumentWithCrypto).toHaveBeenCalledWith(expect.objectContaining({
      filePath: multipartTempUploadPath(uploadTempDir, 'session-1'),
      fileName: 'telegram-success.txt',
    }))
  })

  it('streams the staged spool into S3 without a complete Buffer handoff', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: { id: 's3-account', provider: 's3' },
      folderStorageLocation: { providerFolderId: 'provider-root' },
    })
    let received = ''
    h.uploadS3Object.mockImplementationOnce(async (_config: unknown, _key: string, body: NodeJS.ReadableStream) => {
      for await (const chunk of body) received += Buffer.from(chunk).toString('utf8')
    })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 's3.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ file: { id: 'file-2', name: 'stored.txt', sizeBytes: '3' } })
    expect(received).toBe('abc')
    expect(h.uploadS3Object.mock.calls[0]?.[2]).toHaveProperty('pipe')
    expect(Buffer.isBuffer(h.uploadS3Object.mock.calls[0]?.[2])).toBe(false)
  })

  it('soft-deletes the provisional S3 row and fails the session after a partial provider read', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: { id: 's3-account', provider: 's3' },
      folderStorageLocation: { providerFolderId: 'provider-root' },
    })
    h.uploadS3Object.mockImplementationOnce(async (_config: unknown, _key: string, body: NodeJS.ReadableStream) => {
      for await (const _chunk of body) break
      throw new Error('S3 interrupted')
    })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 's3-error.txt', 'abc')

    const { response, body } = await postForm(form)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code: 'UPLOAD_FAILED', message: 'S3 interrupted' })
    expect(h.prismaMock.file.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'deleted' }) }))
    expect(h.prismaMock.uploadSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }))
    await expect(stat(multipartTempUploadPath(uploadTempDir, 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates client cancellation to an active S3 provider upload and cleans the session spool', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: { id: 's3-account', provider: 's3' },
      folderStorageLocation: { providerFolderId: 'provider-root' },
    })
    let providerSignal: AbortSignal | undefined
    h.uploadS3Object.mockImplementationOnce(async (_config: unknown, _key: string, body: NodeJS.ReadableStream, _mime: string, options?: { signal?: AbortSignal }) => {
      providerSignal = options?.signal
      for await (const _chunk of body) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'abort.txt', 'abc')
    const controller = new AbortController()
    const url = await startServer()
    const request = fetch(url, { method: 'POST', body: form, signal: controller.signal }).then(() => null).catch((error) => error)

    await vi.waitFor(() => expect(h.uploadS3Object).toHaveBeenCalledOnce())
    controller.abort()
    await request

    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true))
    await vi.waitFor(() => expect(h.prismaMock.uploadSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })))
    expect(h.deleteS3ObjectByKey).toHaveBeenCalledWith(expect.anything(), '9drive/object')
    await expect(stat(multipartTempUploadPath(uploadTempDir, 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('compensates a Google file created immediately before client cancellation', async () => {
    h.driveCreate.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { data: { id: 'remote-aborted-google', name: 'abort-google.txt', mimeType: 'text/plain' } }
    })
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'abort-google.txt', 'abc')
    const controller = new AbortController()
    const url = await startServer()
    const request = fetch(url, { method: 'POST', body: form, signal: controller.signal }).catch(() => undefined)

    await vi.waitFor(() => expect(h.driveCreate).toHaveBeenCalledOnce())
    controller.abort()
    await request

    await vi.waitFor(() => expect(h.driveDelete).toHaveBeenCalledWith({ fileId: 'remote-aborted-google' }))
    await vi.waitFor(() => expect(h.prismaMock.uploadSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })))
    await expect(stat(multipartTempUploadPath(uploadTempDir, 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries Telegram remote cleanup when the provider returns deletion errors', async () => {
    h.resolvePlacement.mockResolvedValue({
      connectedAccount: { id: 'telegram-account', provider: 'telegram' },
      folderStorageLocation: { providerFolderId: 'provider-root' },
    })
    h.uploadTelegramDocumentWithCrypto.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { remoteId: 'telegram://channel/42' }
    })
    h.deleteTelegramDocuments.mockResolvedValueOnce(['delete failed']).mockResolvedValueOnce([])
    const form = new FormData()
    form.append('sizeBytes', '3')
    appendFile(form, 'file', 'abort-telegram.txt', 'abc')
    const controller = new AbortController()
    const url = await startServer()
    const request = fetch(url, { method: 'POST', body: form, signal: controller.signal }).catch(() => undefined)

    await vi.waitFor(() => expect(h.uploadTelegramDocumentWithCrypto).toHaveBeenCalledOnce())
    controller.abort()
    await request

    await vi.waitFor(() => expect(h.deleteTelegramDocuments).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(h.prismaMock.uploadSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })))
    await expect(stat(multipartTempUploadPath(uploadTempDir, 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
