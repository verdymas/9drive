import { describe, expect, it } from 'vitest'
import {
  assertChildAccessible,
  computeHopHeaders,
  contextOriginKey,
  decryptRequestContext,
  encryptRequestContext,
  hopHeaderResolver,
  isSameOrigin,
  normalizeOrigin,
  serializeRequestContext,
  validateRequestContext,
} from './request-context.js'
import { AppError } from '../../utils/app-error.js'

/**
 * Mandatory spec §31: forwarding-policy unit tests. The table below is the
 * cookie-scope contract: UA/Referer/Origin go everywhere, Cookie ONLY to the
 * exact source origin (scheme + host + effective port).
 */

function url(u: string): URL {
  return new URL(u)
}

describe('validateRequestContext', () => {
  it('returns null for empty input', () => {
    expect(validateRequestContext(undefined)).toBeNull()
    expect(validateRequestContext(null)).toBeNull()
    expect(validateRequestContext({})).toBeNull()
  })

  it('trims values and returns a clean copy (never the caller object)', () => {
    const raw = { referer: '  https://site.example/  ', userAgent: ' Mozilla/5.0 ' }
    const out = validateRequestContext(raw)
    expect(out).toEqual({ referer: 'https://site.example/', userAgent: 'Mozilla/5.0' })
    expect(out).not.toBe(raw)
  })

  it('rejects CR/LF in every field', () => {
    for (const key of ['referer', 'userAgent', 'cookie'] as const) {
      expect(() => validateRequestContext({ [key]: `https://x.example/\r\nX-Evil: 1` })).toThrowError(
        expect.objectContaining({ code: 'REMOTE_IMPORT_REQUEST_CONTEXT_INVALID' }),
      )
      expect(() => validateRequestContext({ [key]: `a\nb` })).toThrowError(
        expect.objectContaining({ code: 'REMOTE_IMPORT_REQUEST_CONTEXT_INVALID' }),
      )
    }
    // Origin goes through normalizeOrigin, which owns its own code.
    expect(() => validateRequestContext({ origin: `https://x.example/\r\nX-Evil: 1` })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
  })

  it('rejects non-http(s) referer schemes', () => {
    expect(() => validateRequestContext({ referer: 'file:///etc/passwd' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => validateRequestContext({ referer: 'javascript:alert(1)' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => validateRequestContext({ referer: 'not a url' })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
  })

  it('rejects unknown keys (no arbitrary header injection)', () => {
    expect(() => validateRequestContext({ 'X-Evil': '1' } as never)).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
  })

  it('enforces per-field byte caps', () => {
    const big = 'x'.repeat(5000)
    expect(() => validateRequestContext({ referer: `https://a.example/${big}` })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_REQUEST_CONTEXT_INVALID' }),
    )
    expect(() => validateRequestContext({ userAgent: big })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_REQUEST_CONTEXT_INVALID' }),
    )
    // Cookie cap is env-driven (16 KiB default).
    expect(() => validateRequestContext({ cookie: 'c=' + 'x'.repeat(20000) })).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_REQUEST_CONTEXT_INVALID' }),
    )
  })
})

describe('normalizeOrigin (spec §12)', () => {
  it('drops pathname/query/fragment and lowercases scheme+host', () => {
    expect(normalizeOrigin('https://Site.Example/watch/1?x=1#frag')).toBe('https://site.example')
    expect(normalizeOrigin('http://example.com:8080/watch')).toBe('http://example.com:8080')
    expect(normalizeOrigin('https://example.com:8443/p')).toBe('https://example.com:8443')
  })

  it('rejects non-http(s) schemes and malformed values', () => {
    expect(() => normalizeOrigin('file:///etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => normalizeOrigin('ftp://example.com')).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
    expect(() => normalizeOrigin('not a url')).toThrowError(
      expect.objectContaining({ code: 'REMOTE_IMPORT_HEADER_VALUE_INVALID' }),
    )
  })
})

describe('encrypt / decrypt round-trip', () => {
  it('round-trips a context', () => {
    const ctx = { referer: 'https://site.example/1', cookie: 'session=valid' }
    const encrypted = encryptRequestContext(ctx)
    expect(encrypted).not.toContain('session=valid')
    expect(decryptRequestContext(encrypted)).toEqual(ctx)
  })

  it('returns null for tampered or unparseable payloads (never crashes)', () => {
    expect(decryptRequestContext(null)).toBeNull()
    expect(decryptRequestContext(undefined)).toBeNull()
    expect(decryptRequestContext('garbage')).toBeNull()
    // Valid ciphertext shape but wrong key/IV => decryptText throws => null.
    expect(decryptRequestContext('YWJj:YWJj:YWJj')).toBeNull()
  })
})

describe('serializeRequestContext (booleans only — spec §19)', () => {
  it('never serializes values, only attached booleans', () => {
    const out = serializeRequestContext({ referer: 'https://site.example/', cookie: 'session=valid' })
    expect(out).toEqual({ attached: true, referer: true, origin: false, userAgent: false, cookie: true })
    expect(JSON.stringify(out)).not.toContain('session=valid')
    expect(JSON.stringify(out)).not.toContain('https://site.example/')
  })

  it('returns the empty summary for null', () => {
    expect(serializeRequestContext(null)).toEqual({ attached: false, referer: false, origin: false, userAgent: false, cookie: false })
  })
})

describe('contextOriginKey / isSameOrigin (spec §13 — exact host scope)', () => {
  it('normalizes the effective port (portless https = :443)', () => {
    expect(contextOriginKey(url('https://example.com/a'))).toBe('https://example.com:')
    expect(contextOriginKey(url('https://example.com:443/a'))).toBe('https://example.com:')
    expect(isSameOrigin(url('https://example.com/a'), url('https://example.com:443/b'))).toBe(true)
  })

  it('is case-insensitive on host, never on anything else', () => {
    expect(isSameOrigin(url('https://Example.COM/a'), url('https://example.com/b'))).toBe(true)
  })

  it('treats different hosts as different origins (no endsWith)', () => {
    expect(isSameOrigin(url('https://video.example.test/a'), url('https://cdn.other.test/b'))).toBe(false)
    // A subdomain is a DIFFERENT origin — the exact-host scope must not sweep.
    expect(isSameOrigin(url('https://example.com/a'), url('https://cdn.example.com/b'))).toBe(false)
    expect(isSameOrigin(url('https://example.com/a'), url('https://example.org/b'))).toBe(false)
  })

  it('treats different ports as different origins', () => {
    expect(isSameOrigin(url('https://example.com/a'), url('https://example.com:8443/b'))).toBe(false)
    expect(isSameOrigin(url('http://example.com/a'), url('http://example.com:8080/b'))).toBe(false)
  })

  it('treats scheme mismatch as different origin', () => {
    expect(isSameOrigin(url('http://example.com/a'), url('https://example.com/b'))).toBe(false)
  })
})

describe('computeHopHeaders — the forwarding table (spec §31)', () => {
  const source = url('https://video.example.test/watch')
  const ctx = {
    referer: 'https://site.example/watch/1',
    origin: 'https://site.example',
    userAgent: 'Mozilla/5.0 Test',
    cookie: 'session=secret',
  }

  it('same source host → UA + Referer + Origin + Cookie all forwarded', () => {
    const headers = computeHopHeaders(source, url('https://video.example.test/seg-1.ts'), ctx)
    expect(headers).toEqual({
      'User-Agent': 'Mozilla/5.0 Test',
      Referer: 'https://site.example/watch/1',
      Origin: 'https://site.example',
      Cookie: 'session=secret',
    })
  })

  it('cross-host redirect → Cookie dropped, UA/Referer/Origin kept', () => {
    const headers = computeHopHeaders(source, url('https://cdn.other.test/seg-1.ts'), ctx)
    expect(headers).toEqual({
      'User-Agent': 'Mozilla/5.0 Test',
      Referer: 'https://site.example/watch/1',
      Origin: 'https://site.example',
    })
    expect(headers?.['Cookie']).toBeUndefined()
  })

  it('same-host redirect keeps the Cookie', () => {
    const headers = computeHopHeaders(source, url('https://video.example.test/redirected/master.m3u8'), ctx)
    expect(headers?.['Cookie']).toBe('session=secret')
  })

  it('port-sensitivity: same host, different port → Cookie dropped', () => {
    const headers = computeHopHeaders(source, url('https://video.example.test:8443/seg-1.ts'), ctx)
    expect(headers?.['Cookie']).toBeUndefined()
  })

  it('explicit :443 matches portless', () => {
    const headers = computeHopHeaders(source, url('https://video.example.test:443/seg-1.ts'), ctx)
    expect(headers?.['Cookie']).toBe('session=secret')
  })

  it('returns undefined when no context applies', () => {
    expect(computeHopHeaders(source, url('https://video.example.test/seg-1.ts'), null)).toBeUndefined()
    expect(computeHopHeaders(source, url('https://video.example.test/seg-1.ts'), undefined)).toBeUndefined()
  })

  it('partial context forwards only what was provided', () => {
    const headers = computeHopHeaders(source, url('https://video.example.test/x'), { cookie: 's=1' })
    expect(headers).toEqual({ Cookie: 's=1' })
  })
})

describe('hopHeaderResolver — anchor is always the original source URL', () => {
  it('anchors cookie scope to the source URL, never to a child URL', () => {
    const resolver = hopHeaderResolver('https://video.example.test/master.m3u8', { cookie: 'session=secret' })
    expect(resolver).toBeDefined()
    // Same host as the ORIGINAL source => cookie attached, even though the
    // hop URL passed in is a different path on that host.
    expect(resolver!(url('https://video.example.test/child.m3u8'))?.['Cookie']).toBe('session=secret')
    // A child on another host => cookie dropped.
    expect(resolver!(url('https://cdn.other.test/seg-1.ts'))?.['Cookie']).toBeUndefined()
  })

  it('returns undefined for an invalid source URL or empty context', () => {
    expect(hopHeaderResolver('not a url', { cookie: 's=1' })).toBeUndefined()
    expect(hopHeaderResolver('https://example.com/x', null)).toBeUndefined()
  })
})

describe('assertChildAccessible (spec §16 fail-safe)', () => {
  const source = url('https://video.example.test/master.m3u8')

  it('throws HLS_CHILD_AUTHENTICATION_REQUIRED when cookie set + child is cross-origin', () => {
    try {
      assertChildAccessible(source, url('https://cdn.other.test/seg-1.ts'), { cookie: 'session=secret' })
      throw new Error('expected rejection')
    } catch (err) {
      expect((err as AppError).code).toBe('HLS_CHILD_AUTHENTICATION_REQUIRED')
    }
  })

  it('allows same-origin children with a cookie', () => {
    expect(() => assertChildAccessible(source, url('https://video.example.test/seg-1.ts'), { cookie: 'session=secret' })).not.toThrow()
  })

  it('allows cross-origin children when no cookie is set', () => {
    expect(() => assertChildAccessible(source, url('https://cdn.other.test/seg-1.ts'), null)).not.toThrow()
    expect(() => assertChildAccessible(source, url('https://cdn.other.test/seg-1.ts'), { referer: 'https://x.example/' })).not.toThrow()
  })
})
