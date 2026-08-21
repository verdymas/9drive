import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { remoteFetchWorkerRouter } from './workers.routes.js'
import { AppError } from '../../utils/app-error.js'

/**
 * Worker deletion routes — the idempotent DELETE flow and the explicitly
 * confirmed force-local-admin fallback. The service layer is mocked; the
 * routes are mounted on a real Express app (sync.routes.test.ts pattern).
 */
const h = vi.hoisted(() => {
  const deleteWorker = vi.fn()
  const forceDeleteWorkerLocal = vi.fn()
  return { deleteWorker, forceDeleteWorkerLocal }
})

vi.mock('./workers.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workers.service.js')>()
  return {
    ...original,
    deleteWorker: (...args: unknown[]) => h.deleteWorker(...args),
    forceDeleteWorkerLocal: (...args: unknown[]) => h.forceDeleteWorkerLocal(...args),
  }
})

vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', sessionId: 'sess-1' }
    next()
  },
}))

const app = express()
app.use(express.json())
app.use('/workers', remoteFetchWorkerRouter)

let server: http.Server
let baseUrl: string

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/workers${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

beforeAll(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  vi.clearAllMocks()
  h.deleteWorker.mockResolvedValue({ result: 'deleted' })
  h.forceDeleteWorkerLocal.mockResolvedValue({ result: 'forced_local' })
})

describe('DELETE /workers/:id', () => {
  it('204 + delegates to the service delete', async () => {
    const res = await api('DELETE', '/worker-1')
    expect(res.status).toBe(204)
    expect(h.deleteWorker).toHaveBeenCalledWith('user-1', 'worker-1')
  })

  it('propagates WORKER_DEPROVISION_FAILED with the message (row preserved at service level)', async () => {
    h.deleteWorker.mockRejectedValue(
      new AppError('WORKER_DEPROVISION_FAILED', 'The remote relay could not be removed. The worker was not deleted — retry or clean it up at the provider. (correlationId=abc12345)', 400),
    )
    const res = await api('DELETE', '/worker-1')
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ code: 'WORKER_DEPROVISION_FAILED' })
    expect(String(res.json.message)).toContain('correlationId=abc12345')
  })
})

describe('POST /workers/:id/force-delete (admin local-only fallback)', () => {
  it('rejects without an explicit confirm:true (never automatic)', async () => {
    const res = await api('POST', '/worker-1/force-delete', {})
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(h.forceDeleteWorkerLocal).not.toHaveBeenCalled()
  })

  it('rejects a confirm:false body', async () => {
    const res = await api('POST', '/worker-1/force-delete', { confirm: false })
    expect(res.status).toBe(400)
    expect(h.forceDeleteWorkerLocal).not.toHaveBeenCalled()
  })

  it('deletes the local record only with an explicit warning in the response', async () => {
    const res = await api('POST', '/worker-1/force-delete', { confirm: true })
    expect(res.status).toBe(200)
    expect(h.forceDeleteWorkerLocal).toHaveBeenCalledWith('user-1', 'worker-1')
    expect(res.json).toMatchObject({
      message: expect.stringContaining('remote provider resource may still exist'),
    })
  })
})