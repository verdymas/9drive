/**
 * Repack the stored teleproto/GramJS `StringSession` into Telethon's
 * `StringSession` format.
 *
 * Both formats carry exactly the same four fields, so the conversion is
 * lossless (verified by round-tripping through Telethon's own parser):
 *
 *   GramJS:   "1" + base64   (dcId(1) | addrLen(2BE) | addr(utf8) | port(2BE) | authKey(256))
 *   Telethon: "1" + base64url(dcId(1) | ip(4 bytes)              | port(2BE) | authKey(256))
 *
 * This is why the streaming service needs no separate login and no second
 * stored session: the credential 9Drive already holds is sufficient.
 *
 * Telethon's parser selects the IP width by total length (352 chars => 4-byte
 * IP), and decodes with `urlsafe_b64decode`, which requires the `=` padding —
 * hence base64 with `+/` swapped for `-_` rather than Node's 'base64url'
 * (which strips padding).
 */
import net from 'node:net'

const AUTH_KEY_BYTES = 256

export function gramjsToTelethonSession(session: string): string {
  if (!session || session[0] !== '1') {
    throw new Error('unsupported GramJS session version')
  }
  const buf = Buffer.from(session.slice(1), 'base64')
  if (buf.length < 6) throw new Error('truncated GramJS session')
  const addrLen = buf.readUInt16BE(1)
  const addr = buf.subarray(3, 3 + addrLen).toString('utf8')
  const port = buf.readUInt16BE(3 + addrLen)
  const authKey = buf.subarray(5 + addrLen)
  if (authKey.length !== AUTH_KEY_BYTES) {
    throw new Error(`unexpected auth key length: ${authKey.length}`)
  }
  // ponytail: IPv4 only. Telegram hands out IPv4 DC addresses in the GramJS
  // session in practice. Add when a session carries IPv6: pack the 16-byte
  // form instead (Telethon reads it whenever the string is not 352 chars).
  if (!net.isIPv4(addr)) {
    throw new Error('unsupported non-IPv4 DC address in Telegram session')
  }
  const out = Buffer.alloc(1 + 4 + 2 + AUTH_KEY_BYTES)
  out[0] = buf[0]
  addr.split('.').forEach((octet, i) => {
    out[1 + i] = Number(octet)
  })
  out.writeUInt16BE(port, 5)
  authKey.copy(out, 7)
  return '1' + out.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}
