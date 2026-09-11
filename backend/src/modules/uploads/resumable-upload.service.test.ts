import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  env: { MAX_UPLOAD_BYTES: 100, TOKEN_ENCRYPTION_KEY: 'test-encryption-key' },
  placement: vi.fn(),
  prisma: {
    uploadSession: { create: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn() },
    connectedAccount: { findFirstOrThrow: vi.fn() },
    file: { findFirst: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('../../config/env.js', () => ({ env: h.env }))
vi.mock('../../config/prisma.js', () => ({ prisma: h.prisma }))
vi.mock('../storage/upload-placement.service.js', () => ({ resolveUploadPlacement: h.placement }))

import { initResumableUpload } from './resumable-upload.service.js'

describe('initResumableUpload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the current validation contract for a non-positive size', async () => {
    await expect(initResumableUpload({
      body: { fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '0', folderId: null, targetAccountId: null },
      user: { id: 'user-1' },
    } as any)).resolves.toEqual({
      status: 400,
      body: { code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' },
    })
    expect(h.placement).not.toHaveBeenCalled()
  })
})

