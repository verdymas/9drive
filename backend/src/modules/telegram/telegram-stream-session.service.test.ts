import { describe, expect, it, vi, beforeEach } from 'vitest'

import { packStreamSession, unpackStreamSession } from './telegram-stream-session.service.js'

vi.mock('../../config/prisma.js', () => ({ prisma: {} }))

describe('packStreamSession / unpackStreamSession', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'x'.repeat(32)
  })

  it('roundtrips a session string through AES-256-GCM', () => {
    const plaintext = 'pyrofork-session-bytes-' + 'a'.repeat(200)
    const packed = packStreamSession(plaintext)
    expect(packed.ciphertext).not.toContain(plaintext)
    expect(packed.ciphertext.split(':')).toHaveLength(3)
    expect(unpackStreamSession(packed)).toBe(plaintext)
  })

  it('produces a fresh ciphertext each time (random IV)', () => {
    const plaintext = 'fixed-session-string'
    const a = packStreamSession(plaintext)
    const b = packStreamSession(plaintext)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(unpackStreamSession(a)).toBe(plaintext)
    expect(unpackStreamSession(b)).toBe(plaintext)
  })
})
