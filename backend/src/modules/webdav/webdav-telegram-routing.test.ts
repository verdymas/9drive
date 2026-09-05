/**
 * Phase 07 regression: WebDAV GET routes Telegram-backed files through
 * the streaming gateway when the service is configured. Google + S3
 * paths are unchanged. PROPFIND/HEAD remain DB-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ cryptoLoaded: false }))

vi.mock('../telegram/telegram-crypto.service.js', () => {
  h.cryptoLoaded = true
  return {
    decryptMetadata: () => {
      throw new Error('WebDAV read paths must not decrypt Telegram metadata.')
    },
  }
})

const realFetch = global.fetch
const fetchMock = vi.fn()

vi.mock('../../config/env.js', () => ({
  env: {
    TELEGRAM_STREAM_NODE_URL: 'http://upstream.test',
    TELEGRAM_STREAM_INTERNAL_SECRET: 'test-secret',
    TELEGRAM_STREAM_SIGNATURE_MAX_SKEW_SECONDS: 30,
    TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
    DATABASE_URL: 'mysql://root@localhost:3306/9drive_test',
    FRONTEND_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'test-jwt-secret-that-is-long-enough-1234',
  },
}))

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  h.cryptoLoaded = false
})

afterEach(() => {
  global.fetch = realFetch
})

const fileRow = {
  id: 'file-1',
  provider: 'telegram',
  providerFileId: 'telegram://-1001/42',
  connectedAccountId: 'acct-1',
  mimeType: 'video/mp4',
  name: 'movie.mp4',
  sizeBytes: 100n,
  status: 'active',
  folderId: 'f1',
  userId: 'u1',
  physicalFilename: null,
  encryptedMetadata: null,
  metadataFingerprint: null,
  cryptoVersion: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe('streamProviderFileToReadable — Telegram routing', () => {
  it('routes a Telegram GET through the streaming gateway', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('hello'))
          c.close()
        },
      }), { status: 206, headers: { 'content-range': 'bytes 0-4/100' } }),
    )
    const { streamProviderFileToReadable } = await import('./webdav-virtual-fs.js')
    const result = await streamProviderFileToReadable(fileRow, 'bytes=0-4')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [urlArg, initArg] = fetchMock.mock.calls[0]
    expect(String(urlArg)).toContain('/v1/stream')
    const headers = (initArg as RequestInit).headers as Record<string, string>
    expect(headers.Range).toBe('bytes=0-4')
    expect(headers['X-Stream-Signature']).toMatch(/^[0-9a-f]{64}$/)
    // Telegram returns a ProviderStreamResult (object with body/status/headers),
    // not a bare Readable. The WebDAV routes layer distinguishes by
    // `file.provider === 'telegram'`.
    const r = result as { body: { pipe?: unknown }; status: number; headers: Record<string, string> }
    expect(r.status).toBe(206)
    expect(r.headers['content-range']).toBe('bytes 0-4/100')
    expect(typeof r.body.pipe).toBe('function')
  })

  it('the metadata crypto module is never loaded by the WebDAV read path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ start(c) { c.close() } })),
    )
    const { streamProviderFileToReadable } = await import('./webdav-virtual-fs.js')
    await streamProviderFileToReadable(fileRow, 'bytes=0-4')
    expect(h.cryptoLoaded).toBe(false)
  })

  // A suffix range is how ffprobe/rclone read a Matroska tail (Cues live at
  // the end). The WebDAV layer used to drop it — its own parseRange has no
  // suffix form — turning a 1 KiB tail read into a full-file download.
  it('forwards a suffix range verbatim instead of dropping it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ start(c) { c.close() } }), {
        status: 206,
        headers: { 'content-range': 'bytes 96-99/100' },
      }),
    )
    const { streamProviderFileToReadable } = await import('./webdav-virtual-fs.js')
    await streamProviderFileToReadable(fileRow, 'bytes=-4')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Range).toBe('bytes=-4')
  })

  // The abort wiring is what stops an abandoned seek from holding the
  // account's single sequential Telethon sender.
  it('destroying the body aborts the upstream request', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined
      return Promise.resolve(
        new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])) } }), { status: 206 }),
      )
    })
    const { streamProviderFileToReadable } = await import('./webdav-virtual-fs.js')
    const r = (await streamProviderFileToReadable(fileRow, 'bytes=0-0')) as {
      body: import('node:stream').Readable
    }
    expect(signal?.aborted).toBe(false)
    r.body.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    expect(signal?.aborted).toBe(true)
  })
})
