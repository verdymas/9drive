import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  proxyDeliveryDecision,
  setProxyHeaders,
  streamProxyResponse,
  writeProxyOpenError,
} from './file-delivery.js'

class FakeResponse extends PassThrough {
  statusCode = 200
  headersSent = false
  writableEnded = false
  readonly headers = new Map<string, string>()
  readonly json = vi.fn(() => this)

  status(code: number) {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }

  override end(chunk?: unknown, encoding?: BufferEncoding, callback?: () => void): this {
    this.writableEnded = true
    return super.end(chunk as never, encoding, callback)
  }
}

describe('file delivery boundary', () => {
  it('keeps Phase 1 delivery on the proxy path', () => {
    expect(proxyDeliveryDecision()).toEqual({ kind: 'proxy' })
  })

  it('normalizes a ranged attachment response from provider metadata', () => {
    const response = new FakeResponse()

    setProxyHeaders(response as never, {
      status: 206,
      contentType: 'video/mp4',
      contentLength: '512',
      contentRange: 'bytes 512-1023/4096',
      disposition: 'attachment',
      fileName: 'movie".mp4',
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers).toEqual(new Map([
      ['content-type', 'video/mp4'],
      ['accept-ranges', 'bytes'],
      ['content-length', '512'],
      ['content-range', 'bytes 512-1023/4096'],
      ['content-disposition', 'attachment; filename="movie.mp4"'],
    ]))
  })

  it('aborts and destroys the provider stream when the downstream client disconnects', async () => {
    const source = new PassThrough()
    const response = new FakeResponse()
    const abort = vi.fn()

    const delivery = streamProxyResponse(response as never, {
      body: source,
      status: 200,
      contentType: 'application/octet-stream',
      abort,
    })

    response.emit('close')
    await expect(delivery).resolves.toBeUndefined()
    expect(abort).toHaveBeenCalledOnce()
    expect(source.destroyed).toBe(true)
  })

  it('returns a structured gateway error when opening the upstream fails before headers', () => {
    const response = new FakeResponse()

    writeProxyOpenError(response as never)

    expect(response.statusCode).toBe(502)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.json).toHaveBeenCalledWith({
      code: 'FILE_STREAM_UNAVAILABLE',
      message: 'The file stream is temporarily unavailable.',
    })
  })
})
