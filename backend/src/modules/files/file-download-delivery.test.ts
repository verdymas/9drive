import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getS3DownloadDecision: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({ prisma: { file: { findFirst: h.findFirst } } }))
vi.mock('../s3/s3.service.js', () => ({ getS3DownloadDecision: h.getS3DownloadDecision }))

import { resolveAuthenticatedDownload } from './file-download-delivery.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveAuthenticatedDownload', () => {
  it('authorizes an active owned file before requesting its S3 delivery decision', async () => {
    const file = { id: 'file-1', userId: 'owner-1', provider: 's3', status: 'active', connectedAccount: {} }
    h.findFirst.mockResolvedValueOnce(file)
    h.getS3DownloadDecision.mockResolvedValueOnce({ kind: 'redirect', url: 'https://s3.example.test/object?short-lived' })

    await expect(resolveAuthenticatedDownload({
      userId: 'owner-1', fileId: 'file-1', range: undefined, directS3Enabled: true, directS3TtlSeconds: 300,
    })).resolves.toEqual({ file, decision: { kind: 'redirect', url: 'https://s3.example.test/object?short-lived' } })

    expect(h.findFirst).toHaveBeenCalledWith({
      where: { id: 'file-1', userId: 'owner-1', status: 'active' },
      include: { connectedAccount: true },
    })
    expect(h.getS3DownloadDecision).toHaveBeenCalledWith(file, {
      enabled: true,
      ttlSeconds: 300,
      range: undefined,
      disposition: 'attachment',
    })
  })

  it('rejects an unauthorized or inactive file before requesting a signed URL', async () => {
    h.findFirst.mockResolvedValueOnce(null)

    await expect(resolveAuthenticatedDownload({
      userId: 'other-user', fileId: 'file-1', range: undefined, directS3Enabled: true, directS3TtlSeconds: 300,
    })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 })

    expect(h.getS3DownloadDecision).not.toHaveBeenCalled()
  })
})
