/**
 * The repack must be byte-exact or Telethon rejects the session (or worse,
 * silently reads a wrong auth key). Cross-checked against Telethon's own
 * parser in the container; this test locks the layout in CI.
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { gramjsToTelethonSession } from './telethon-session.js'

function gramjsSession(dcId: number, addr: string, port: number, authKey: Buffer): string {
  const a = Buffer.from(addr, 'utf8')
  const buf = Buffer.concat([
    Buffer.from([dcId]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(a.length); return b })(),
    a,
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b })(),
    authKey,
  ])
  return '1' + buf.toString('base64')
}

describe('gramjsToTelethonSession', () => {
  const authKey = crypto.randomBytes(256)

  it('produces Telethon\'s 352-char payload with the fields preserved', () => {
    const out = gramjsToTelethonSession(gramjsSession(5, '91.108.56.161', 443, authKey))
    expect(out[0]).toBe('1')
    // Telethon picks a 4-byte IP iff the payload is exactly 352 chars.
    expect(out.length - 1).toBe(352)
    const buf = Buffer.from(out.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    expect(buf[0]).toBe(5)
    expect([...buf.subarray(1, 5)]).toEqual([91, 108, 56, 161])
    expect(buf.readUInt16BE(5)).toBe(443)
    expect(buf.subarray(7).equals(authKey)).toBe(true)
  })

  it('rejects sessions it cannot faithfully convert', () => {
    expect(() => gramjsToTelethonSession('2abc')).toThrow(/version/)
    expect(() => gramjsToTelethonSession(gramjsSession(2, '91.108.56.161', 443, Buffer.alloc(128)))).toThrow(/auth key length/)
    expect(() => gramjsToTelethonSession(gramjsSession(2, '2001:db8::1', 443, authKey))).toThrow(/IPv4/)
  })
})
