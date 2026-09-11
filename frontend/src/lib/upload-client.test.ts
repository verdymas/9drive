import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ API_URL: 'https://api.test', apiFetch: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getAccessToken: vi.fn(() => 'access-token') }))

import { uploadResumableChunk } from '@/lib/upload-client'

describe('upload client transport', () => {
  it('preserves the server error contract and maps Google reauth failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ code: 'GOOGLE_REAUTH_REQUIRED', message: 'expired' }),
    }))

    await expect(uploadResumableChunk({
      sessionId: 'session-1',
      chunk: new Blob(['abc']),
      startOffset: 0,
      endOffset: 3,
      totalBytes: 3,
    })).rejects.toThrow('Google Drive connection expired. Reconnect this account to continue uploading files.')
  })
})
