import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getRequestHeaders: vi.fn(async () => ({ authorization: 'Bearer provider-token' })) }))

vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: vi.fn(async () => ({ getRequestHeaders: h.getRequestHeaders })),
}))

import { streamGoogleFile } from './stream-google-file.js'

class FakeResponse extends PassThrough {
  statusCode = 200
  writableEnded = false
  readonly headers = new Map<string, string>()

  status(code: number) {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }

  json() {
    return this
  }

  override end(chunk?: unknown, encoding?: BufferEncoding, callback?: () => void): this {
    this.writableEnded = true
    return super.end(chunk as never, encoding, callback)
  }
}

const file = {
  providerFileId: 'provider-file',
  mimeType: 'video/mp4',
  name: 'movie.mp4',
  connectedAccount: { id: 'account-1' },
} as never

afterEach(() => {
  vi.restoreAllMocks()
})

describe('streamGoogleFile', () => {
  it('passes the downstream abort signal to the Google media fetch', async () => {
    const response = new FakeResponse()
    const abort = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bytes', {
      status: 206,
      headers: {
        'content-length': '5',
        'content-range': 'bytes 0-4/5',
      },
    }))

    await streamGoogleFile(file, 'bytes=0-4', response as never, { disposition: 'attachment' }, abort.signal)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('provider-file?alt=media'),
      expect.objectContaining({
        signal: abort.signal,
        headers: expect.objectContaining({ Range: 'bytes=0-4' }),
      }),
    )
    expect(response.statusCode).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-4/5')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="movie.mp4"')
  })

  it('keeps Google Workspace exports on their supported export endpoint', async () => {
    const response = new FakeResponse()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('pdf', {
      status: 200,
      headers: { 'content-length': '3' },
    }))

    await streamGoogleFile({ ...file, mimeType: 'application/vnd.google-apps.document', name: 'proposal' }, 'bytes=0-2', response as never, { disposition: 'attachment' })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/export?mimeType=application%2Fpdf'),
      expect.objectContaining({
        headers: expect.not.objectContaining({ Range: expect.anything() }),
      }),
    )
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="proposal.pdf"')
  })
})
