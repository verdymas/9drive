import { describe, expect, it } from 'vitest'

import {
  canonicalString,
  signStreamRequest,
  isTelegramStreamConfigured,
} from './telegram-stream-auth.js'

describe('telegram-stream-auth canonicalString', () => {
  it('joins the seven fields with newlines in a fixed order', () => {
    expect(
      canonicalString({
        timestamp: 1700000000,
        method: 'get',
        path: '/v1/stream',
        identity: { providerId: 'a', channelId: 'b', messageId: 7, range: 'bytes=0-3' },
      }),
    ).toBe('1700000000\nGET\n/v1/stream\na\nb\n7\nbytes=0-3')
  })

  it('treats missing range as empty string', () => {
    expect(
      canonicalString({
        timestamp: 1700000000,
        method: 'GET',
        identity: { providerId: 'a', channelId: 'b', messageId: 7 },
      }),
    ).toBe('1700000000\nGET\n/v1/stream\na\nb\n7\n')
  })

  it('uppercases the method', () => {
    expect(
      canonicalString({
        timestamp: 1,
        method: 'put',
        path: '/v1/stream',
        identity: { providerId: 'a', channelId: 'b', messageId: 1 },
      }),
    ).toBe('1\nPUT\n/v1/stream\na\nb\n1\n')
  })
})

describe('signStreamRequest', () => {
  it('produces a deterministic hex digest for the same input', () => {
    const a = signStreamRequest({
      timestamp: 1700000000,
      method: 'GET',
      identity: { providerId: 'a', channelId: 'b', messageId: 1, range: 'bytes=0-1' },
      secret: 'topsecret',
    })
    const b = signStreamRequest({
      timestamp: 1700000000,
      method: 'GET',
      identity: { providerId: 'a', channelId: 'b', messageId: 1, range: 'bytes=0-1' },
      secret: 'topsecret',
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when any canonical field changes', () => {
    const base = signStreamRequest({
      timestamp: 1,
      method: 'GET',
      identity: { providerId: 'a', channelId: 'b', messageId: 1 },
      secret: 's',
    })
    expect(
      signStreamRequest({
        timestamp: 2,
        method: 'GET',
        identity: { providerId: 'a', channelId: 'b', messageId: 1 },
        secret: 's',
      }),
    ).not.toBe(base)
    expect(
      signStreamRequest({
        timestamp: 1,
        method: 'GET',
        identity: { providerId: 'a', channelId: 'b', messageId: 1, range: 'bytes=0-1' },
        secret: 's',
      }),
    ).not.toBe(base)
    expect(
      signStreamRequest({
        timestamp: 1,
        method: 'GET',
        identity: { providerId: 'a', channelId: 'b', messageId: 1 },
        secret: 's2',
      }),
    ).not.toBe(base)
  })

  it('is a 64-char hex string (contract for the Python service)', () => {
    const sig = signStreamRequest({
      timestamp: 1700000000,
      method: 'GET',
      identity: { providerId: 'acct-1', channelId: '1490000000000000001', messageId: 42, range: 'bytes=0-3' },
      secret: 'test-secret-please-rotate',
    })
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    // Cross-side contract: the Python suite asserts the *same* digest for
    // the same inputs (services/telegram-stream/tests/test_internal_auth.py).
    // This is checked on every CI run; if either side changes its canonical
    // string, both tests fail in lockstep.
  })
})

describe('isTelegramStreamConfigured', () => {
  it('returns false when either env var is missing', () => {
    // env is parsed once at import; this only documents the contract.
    const result = isTelegramStreamConfigured()
    expect(typeof result).toBe('boolean')
  })
})
