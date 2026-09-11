import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../utils/app-error.js'

const h = vi.hoisted(() => ({
  account: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  placement: vi.fn(),
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    connectedAccount: { findUniqueOrThrow: h.account },
    file: { findFirst: h.findFirst, create: h.create, update: h.update },
  },
}))
vi.mock('../../utils/audit.js', () => ({ createAuditLog: h.audit }))
vi.mock('../storage/upload-placement.service.js', () => ({ resolveUploadPlacement: h.placement }))

import { continueFromPart, registerImportedFile } from './processor-upload.js'

describe('registerImportedFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.account.mockResolvedValue({ provider: 's3' })
    h.findFirst.mockResolvedValue(null)
    h.create.mockResolvedValue({ id: 'file-1', name: 'report.txt', sizeBytes: 3n, status: 'active' })
    h.update.mockResolvedValue({ id: 'file-1', name: 'report.txt', sizeBytes: 3n, status: 'active' })
    h.audit.mockResolvedValue(undefined)
    h.placement.mockReset()
  })

  it('creates one active virtual file and records the import audit event', async () => {
    const context = {
      importId: 'import-1',
      record: { userId: 'user-1', folderId: null, connectedAccountId: 'account-1', fileName: 'report.txt', mimeType: 'text/plain' },
      updateStage: vi.fn(async () => undefined),
    }

    await expect(registerImportedFile({ context: context as any, providerFileId: 'object-1', sizeBytes: 3n })).resolves.toMatchObject({ id: 'file-1', status: 'active' })
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerFileId: 'object-1', sizeBytes: 3n, status: 'active' }) }))
    expect(h.audit).toHaveBeenCalledWith('user-1', 'IMPORT_FILE', 'file', 'file-1', expect.objectContaining({ size: '3' }))
  })

  it('finalizes a placement reauth failure with a retry marker', async () => {
    h.placement.mockRejectedValue(new AppError('GOOGLE_REAUTH_REQUIRED', 'Reconnect Google Drive.', 401))
    const markFailed = vi.fn().mockResolvedValue(undefined)
    const context = {
      importId: 'import-1',
      userId: 'user-1',
      folderId: null,
      fileName: 'report.txt',
      mimeType: 'text/plain',
      record: { connectedAccountId: 'account-1', fileName: 'report.txt', mimeType: 'text/plain' },
      updateStage: vi.fn().mockResolvedValue(undefined),
      markFailed,
    }

    await expect(continueFromPart({
      context: context as any,
      sourceUrl: 'https://source.test/report.txt',
      tempPartPath: 'C:/temp/report.part',
      contentLength: 3n,
    })).rejects.toMatchObject({ code: '__PLACEMENT_REAUTH__', placementFinalized: true })
    expect(markFailed).toHaveBeenCalledWith('GOOGLE_REAUTH_REQUIRED', expect.any(String))
  })
})
