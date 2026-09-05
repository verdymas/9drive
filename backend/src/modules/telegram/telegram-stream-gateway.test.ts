import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { telegramStreamGateway } from './telegram-stream-gateway.js'
import { isTelegramStreamConfigured } from './telegram-stream-auth.js'

// Avoid pulling env.ts / prisma transitively. The gateway only needs
// env.TELEGRAM_STREAM_NODE_URL/INTERNAL_SECRET and parseTelegramRemoteId.
vi.mock('../../config/env.js', () => ({
  env: {
    TELEGRAM_STREAM_NODE_URL: 'http://upstream.test',
    TELEGRAM_STREAM_INTERNAL_SECRET: 'test-secret',
    TELEGRAM_STREAM_SIGNATURE_MAX_SKEW_SECONDS: 30,
  },
}))

vi.mock('./telegram.service.js', () => ({
  parseTelegramRemoteId: (id: string) => {
    // telegram://<channel>/<message>
    const [, channelId, messageId] = id.match(/^telegram:\/\/([^/]+)\/(\d+)$/) ?? []
    if (!channelId || !messageId) throw new Error('bad providerFileId')
    return { channelId, messageId: Number(messageId) }
  },
}))

class FakeResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  ended = false
  destroyed = false
  writableEnded = false
  private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

  status(code: number) {
    this.statusCode = code
    return this
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    this._listeners[event] ??= []
    this._listeners[event].push(fn)
    return this
  }
  once(event: string, fn: (...args: unknown[]) => void) {
    this._listeners[event] ??= []
    // node stream's `.once()` removes itself after one fire.
    const wrapped = (...args: unknown[]) => {
      this._listeners[event] = (this._listeners[event] ?? []).filter((f) => f !== wrapped)
      fn(...args)
    }
    this._listeners[event].push(wrapped)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this._listeners[event] ?? []) fn(...args)
  }
  write(_chunk: unknown) {
    return true
  }
  end() {
    this.ended = true
    this.writableEnded = true
  }
  destroy() {
    this.destroyed = true
  }
}

function makeReadable() {
  // A real WHATWG ReadableStream (what fetch() returns).
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hello'))
      controller.close()
    },
  })
}

function makeFetchResponse(parts: { status: number; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null }) {
  return {
    status: parts.status,
    headers: new Headers(parts.headers ?? {}),
    body: parts.body ?? null,
  } as unknown as Response
}

describe('telegramStreamGateway.streamFile', () => {
  const realFetch = global.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  it('returns 503 when stream service is not configured', async () => {
    // We must override the mocked env for this test only.
    const envModule = await import('../../config/env.js')
    const oldUrl = (envModule.env as Record<string, unknown>).TELEGRAM_STREAM_NODE_URL
    const oldSecret = (envModule.env as Record<string, unknown>).TELEGRAM_STREAM_INTERNAL_SECRET
    ;(envModule.env as Record<string, unknown>).TELEGRAM_STREAM_NODE_URL = ''
    ;(envModule.env as Record<string, unknown>).TELEGRAM_STREAM_INTERNAL_SECRET = ''
    try {
      const res = new FakeResponse()
      await telegramStreamGateway.streamFile(
        {
          providerFileId: 'telegram://-1001/42',
          connectedAccountId: 'acct-1',
          mimeType: 'video/mp4',
          name: 'movie.mp4',
          sizeBytes: 5,
        },
        'bytes=0-4',
        res as unknown as import('express').Response,
      )
      expect(res.statusCode).toBe(503)
    } finally {
      ;(envModule.env as Record<string, unknown>).TELEGRAM_STREAM_NODE_URL = oldUrl
      ;(envModule.env as Record<string, unknown>).TELEGRAM_STREAM_INTERNAL_SECRET = oldSecret
    }
  })

  it('forwards Range verbatim and proxies status + body', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse({
        status: 206,
        headers: {
          'content-range': 'bytes 0-4/10',
          'content-length': '5',
          'accept-ranges': 'bytes',
        },
        body: makeReadable() as unknown as ReadableStream<Uint8Array>,
      }),
    )
    const res = new FakeResponse()
    await telegramStreamGateway.streamFile(
      {
        providerFileId: 'telegram://-1001/42',
        connectedAccountId: 'acct-1',
        mimeType: 'video/mp4',
        name: 'movie.mp4',
        sizeBytes: 10,
      },
      'bytes=0-4',
      res as unknown as import('express').Response,
    )
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 0-4/10')
    expect(res.headers['content-length']).toBe('5')
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-disposition']).toBeUndefined()
    const [urlArg, initArg] = fetchMock.mock.calls[0]
    expect(String(urlArg)).toContain('/v1/stream')
    expect(String(urlArg)).toContain('providerId=acct-1')
    expect(String(urlArg)).toContain('channelId=-1001')
    expect(String(urlArg)).toContain('messageId=42')
    expect(String(urlArg)).toContain('knownSize=10')
    expect((initArg as RequestInit).method).toBe('GET')
    const h = (initArg as RequestInit).headers as Record<string, string>
    expect(h.Range).toBe('bytes=0-4')
    expect(h['X-Stream-Signature']).toMatch(/^[0-9a-f]{64}$/)
    expect(h['X-Stream-Timestamp']).toMatch(/^\d+$/)
  })

  it('attaches Content-Disposition when options.disposition is set', async () => {
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse({
        status: 200,
        headers: { 'content-length': '5' },
        body: makeReadable() as unknown as ReadableStream<Uint8Array>,
      }),
    )
    const res = new FakeResponse()
    await telegramStreamGateway.streamFile(
      {
        providerFileId: 'telegram://-1001/42',
        connectedAccountId: 'acct-1',
        mimeType: 'application/octet-stream',
        name: 'movie.mp4',
        sizeBytes: 5,
      },
      undefined,
      res as unknown as import('express').Response,
      { disposition: 'inline' },
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe('inline; filename="movie.mp4"')
  })

  it('returns 502 when the upstream is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = new FakeResponse()
    await telegramStreamGateway.streamFile(
      {
        providerFileId: 'telegram://-1001/42',
        connectedAccountId: 'acct-1',
        mimeType: 'video/mp4',
        sizeBytes: 5,
      },
      'bytes=0-4',
      res as unknown as import('express').Response,
    )
    expect(res.statusCode).toBe(502)
  })

  it('isTelegramStreamConfigured returns true when both env vars are set', () => {
    expect(isTelegramStreamConfigured()).toBe(true)
  })
})
