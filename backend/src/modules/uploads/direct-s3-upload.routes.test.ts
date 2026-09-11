import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { once } from 'node:events'

const h = vi.hoisted(() => ({
  init: vi.fn(), sign: vi.fn(), complete: vi.fn(), abort: vi.fn(),
  env: { MAX_UPLOAD_BYTES: 1000, S3_DIRECT_UPLOAD_ENABLED: true, S3_DIRECT_UPLOAD_SESSION_TTL_SECONDS: 900, S3_DIRECT_UPLOAD_PART_SIZE_BYTES: 5, S3_DIRECT_UPLOAD_PART_URL_TTL_SECONDS: 300 },
}))

vi.mock('../../config/env.js', () => ({ env: h.env }))
vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ;(req as express.Request & { user?: { id: string } }).user = { id: 'user-1' }
    next()
  },
}))
vi.mock('./direct-s3-upload.service.js', () => ({
  initDirectS3Upload: h.init,
  signDirectS3UploadPart: h.sign,
  completeDirectS3Upload: h.complete,
  abortDirectS3Upload: h.abort,
}))

import { directS3UploadRouter } from './direct-s3-upload.routes.js'

let server: Server | undefined

async function request(path: string, body?: unknown) {
  const app = express()
  app.use(express.json())
  app.use('/', directS3UploadRouter)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  server = undefined
})

describe('direct S3 upload routes', () => {
  it('initializes only through the authenticated server-owned service', async () => {
    h.init.mockResolvedValueOnce({ mode: 'direct-s3', sessionId: 'session-1', partSizeBytes: 5 })
    const { response, body } = await request('/init', { fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '10', folderId: null, targetAccountId: null })

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ mode: 'direct-s3', sessionId: 'session-1' })
    expect(h.init).toHaveBeenCalledWith('user-1', {
      fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 10n, folderId: null, targetAccountId: null,
    }, expect.objectContaining({ enabled: true }))
  })

  it('delegates part signing, completion, and abort to the owned-session service', async () => {
    h.sign.mockResolvedValueOnce({ partNumber: 1, url: 'https://s3.example.test/part', expiresInSeconds: 300 })
    h.complete.mockResolvedValueOnce({ status: 'completed', file: { id: 'file-1', sizeBytes: 10n } })
    h.abort.mockResolvedValueOnce({ status: 'aborted' })

    const signed = await request('/session-1/parts/1')
    const complete = await request('/session-1/complete', { parts: [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 },
    ] })
    const aborted = await request('/session-1/abort')

    expect(signed.body).toMatchObject({ partNumber: 1, url: expect.stringContaining('s3.example') })
    expect(complete.body).toMatchObject({ status: 'completed', file: { id: 'file-1', sizeBytes: '10' } })
    expect(aborted.body).toEqual({ status: 'aborted' })
    expect(h.sign).toHaveBeenCalledWith('user-1', 'session-1', 1, expect.anything())
    // Reported part sizes must survive route validation for server-side checks.
    expect(h.complete).toHaveBeenCalledWith('user-1', 'session-1', [
      { partNumber: 1, etag: 'etag-1', sizeBytes: 5 }, { partNumber: 2, etag: 'etag-2', sizeBytes: 5 },
    ], expect.anything())
    expect(h.abort).toHaveBeenCalledWith('user-1', 'session-1')
  })
})
