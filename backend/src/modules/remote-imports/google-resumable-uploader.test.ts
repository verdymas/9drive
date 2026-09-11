import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  findAccount: vi.fn(async () => ({ id: 'account-1' })),
  getAuth: vi.fn(async () => ({ getAccessToken: vi.fn(async () => ({ token: 'access-token' })) })),
  createPermission: vi.fn(async () => undefined),
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: { connectedAccount: { findUniqueOrThrow: (...args: unknown[]) => h.findAccount(...args) } },
}))
vi.mock('../google/google.service.js', () => ({ getAuthedGoogleClient: (...args: unknown[]) => h.getAuth(...args) }))
vi.mock('googleapis', () => ({ google: { drive: () => ({ permissions: { create: (...args: unknown[]) => h.createPermission(...args) } }) } }))

import { uploadGoogleResumableStream } from './google-resumable-uploader.js'

describe('uploadGoogleResumableStream', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('queries the persisted session then resumes from the provider-acknowledged offset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', size: '8' }), { status: 200 }))
    const readChunk = vi.fn(async () => Buffer.from([5, 6, 7, 8]))
    const saveState = vi.fn(async () => undefined)

    const result = await uploadGoogleResumableStream({
      accountId: 'account-1', fileName: 'movie.mkv', mimeType: 'video/x-matroska', parentProviderFolderId: 'folder-1',
      totalBytes: 8n, chunkBytes: 8n,
      state: { provider: 'google_drive', sessionUri: 'https://upload.example/session', nextOffset: '0' },
      readChunk, saveState,
    })

    expect(readChunk).toHaveBeenCalledWith(4n, 4n)
    expect(saveState).toHaveBeenCalledWith({ provider: 'google_drive', sessionUri: 'https://upload.example/session', nextOffset: '4' })
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: 'PUT', headers: expect.anything() })
    expect(result).toMatchObject({ providerFileId: 'drive-file-1', sizeBytes: 8n })
  })
})
