import { describe, expect, it } from 'vitest'
import {
  canonicalWarmupBody,
  displayPageUrl,
  pageUrlFingerprint,
  parseWarmupMode,
  sanitizeSourcePageUrl,
  signWarmupRequest,
  warmupIdempotencyKey,
  workerSupportsWarmup,
} from './browser-warmup.js'
import { RelayWarmupRequestSchema, RelayWarmupResponseSchema, urlFingerprintForLog } from './relay-protocol.js'

describe('vps browser warmup helpers', () => {
  it('sanitizes page URLs (http/https only, no creds, fragment stripped)', () => {
    expect(sanitizeSourcePageUrl(null)).toBeNull()
    expect(sanitizeSourcePageUrl('  ')).toBeNull()
    expect(sanitizeSourcePageUrl('https://watch.example/page#frag')).toBe('https://watch.example/page')
    expect(() => sanitizeSourcePageUrl('javascript:alert(1)')).toThrow()
    expect(() => sanitizeSourcePageUrl('data:text/plain,hi')).toThrow()
    expect(() => sanitizeSourcePageUrl('https://user:pass@host/')).toThrow()
    expect(() => sanitizeSourcePageUrl('nota-url')).toThrow()
  })

  it('displays only host+path (never query values)', () => {
    expect(displayPageUrl('https://watch.example/watch/123?token=secret&x=1')).toBe('watch.example/watch/123')
    expect(displayPageUrl(null)).toBeNull()
    expect(displayPageUrl('nota-url')).toBeNull()
  })

  it('fingerprints canonically (matches relay helper)', () => {
    expect(pageUrlFingerprint('https://a.example/x')).toBe(urlFingerprintForLog('https://a.example/x'))
  })

  it('builds stable idempotency keys per import attempt', () => {
    const a = warmupIdempotencyKey('import-1', 1, 'https://watch.example/p')
    const b = warmupIdempotencyKey('import-1', 1, 'https://watch.example/p')
    const c = warmupIdempotencyKey('import-1', 2, 'https://watch.example/p')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.length).toBeLessThanOrEqual(128)
  })

  it('parses warmup modes (default auto)', () => {
    expect(parseWarmupMode(undefined)).toBe('auto')
    expect(parseWarmupMode('')).toBe('auto')
    expect(parseWarmupMode('off')).toBe('off')
    expect(parseWarmupMode('required')).toBe('required')
    expect(() => parseWarmupMode('sometimes')).toThrow()
  })

  it('signs warmup requests payload-bound (body+timestamp+nonce)', () => {
    const body = JSON.stringify({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://watch.example/p' })
    const s1 = signWarmupRequest('secret', body, '1700000000', 'abcdef1234567890')
    const s2 = signWarmupRequest('secret', body, '1700000000', 'abcdef1234567890')
    const s3 = signWarmupRequest('secret', `${body} `, '1700000000', 'abcdef1234567890')
    expect(s1).toBe(s2)
    expect(s1).not.toBe(s3)
    expect(canonicalWarmupBody(body)).toHaveLength(64)
  })

  it('gates on relay capability advertisement', () => {
    expect(workerSupportsWarmup(null)).toBe(false)
    expect(workerSupportsWarmup({})).toBe(false)
    expect(workerSupportsWarmup({ browserWarmup: { supported: false } })).toBe(false)
    expect(workerSupportsWarmup({ browserWarmup: { supported: true } })).toBe(true)
  })

  it('validates warmup wire schemas', () => {
    expect(RelayWarmupRequestSchema.safeParse({ protocolVersion: '9drive-relay-v1', pageUrl: 'https://watch.example/p' }).success).toBe(true)
    expect(RelayWarmupRequestSchema.safeParse({ protocolVersion: '9drive-relay-v1', pageUrl: 'nota-url' }).success).toBe(false)
    expect(
      RelayWarmupResponseSchema.safeParse({ protocolVersion: '9drive-relay-v1', status: 'warmed', navigationStatus: 200, mediaObserved: 2, browserMedia206: false }).success,
    ).toBe(true)
  })
})
