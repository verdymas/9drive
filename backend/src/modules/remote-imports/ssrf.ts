import ipaddr from 'ipaddr.js'
import dns from 'node:dns'
import { AppError } from '../../utils/app-error.js'

/**
 * SSRF protection for the Remote Import feature.
 *
 * An attacker-supplied URL must never let the worker fetch from:
 *  - private / loopback / link-local / documentation / reserved address space
 *    (metadata endpoints like 169.254.169.254 and 127.0.0.1 are inside it),
 *  - hostnames that resolve to any blocked address (including DNS rebinding:
 *    we re-resolve immediately before connecting and connect to the validated
 *    IP, not a re-resolved hostname),
 *  - URLs with embedded credentials (they leak into logs / history).
 *
 * ipaddr.js is used for all parsing/ranges because it is battle-tested and
 * handles IPv4-mapped IPv6 (::ffff:127.0.0.1) correctly.
 */

/** IPv4 ranges that must never be reachable. */
const IPV4_BLOCKLIST: Array<[ipaddr.IPv4, number]> = [
  [ipaddr.parse('0.0.0.0') as ipaddr.IPv4, 8], // "this" network
  [ipaddr.parse('10.0.0.0') as ipaddr.IPv4, 8], // private
  [ipaddr.parse('100.64.0.0') as ipaddr.IPv4, 10], // CGNAT / carrier NAT
  [ipaddr.parse('127.0.0.0') as ipaddr.IPv4, 8], // loopback
  [ipaddr.parse('169.254.0.0') as ipaddr.IPv4, 16], // link-local (metadata)
  [ipaddr.parse('172.16.0.0') as ipaddr.IPv4, 12], // private
  [ipaddr.parse('192.0.0.0') as ipaddr.IPv4, 24], // IETF protocol assignments
  [ipaddr.parse('192.0.2.0') as ipaddr.IPv4, 24], // documentation (TEST-NET-1)
  [ipaddr.parse('192.168.0.0') as ipaddr.IPv4, 16], // private
  [ipaddr.parse('198.18.0.0') as ipaddr.IPv4, 15], // benchmark
  [ipaddr.parse('198.51.100.0') as ipaddr.IPv4, 24], // documentation (TEST-NET-2)
  [ipaddr.parse('203.0.113.0') as ipaddr.IPv4, 24], // documentation (TEST-NET-3)
  [ipaddr.parse('224.0.0.0') as ipaddr.IPv4, 4], // multicast
  [ipaddr.parse('240.0.0.0') as ipaddr.IPv4, 4], // reserved / broadcast
]

/** IPv6 ranges that must never be reachable. */
const IPV6_BLOCKLIST: Array<[ipaddr.IPv6, number]> = [
  [ipaddr.parse('::') as ipaddr.IPv6, 128], // unspecified
  [ipaddr.parse('::1') as ipaddr.IPv6, 128], // loopback
  [ipaddr.parse('fc00::') as ipaddr.IPv6, 7], // unique local (ULA)
  [ipaddr.parse('fe80::') as ipaddr.IPv6, 10], // link-local
  [ipaddr.parse('ff00::') as ipaddr.IPv6, 8], // multicast
  [ipaddr.parse('::ffff:0:0') as ipaddr.IPv6, 96], // IPv4-mapped (checked via IPv4)
]

export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    addr = ipaddr.parse(ip)
  } catch {
    return true // unparseable address is not allowed
  }
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    const v4 = (addr as ipaddr.IPv6).toIPv4Address()
    return isBlockedIp(v4.toNormalizedString())
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6
    return IPV6_BLOCKLIST.some(([range, prefix]) => v6.match(range, prefix))
  }
  const v4 = addr as ipaddr.IPv4
  return IPV4_BLOCKLIST.some(([range, prefix]) => v4.match(range, prefix))
}

/**
 * Resolve `host` to all A/AAAA addresses and reject if any of them (or the
 * host itself, when it is already an IP literal) is blocked. Returns the
 * normalized validated address. Throws AppError with a stable code when the
 * host cannot be used.
 */
export async function resolveAndValidateHost(host: string): Promise<string> {
  // Host may already be an IP literal — validate directly.
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) {
      throw new AppError('SSRF_BLOCKED_ADDRESS', `Address '${host}' is not allowed.`, 400)
    }
    return ipaddr.process(host).toNormalizedString()
  }

  let records: string[]
  try {
    records = await new Promise<string[]>((resolve, reject) => {
      dns.lookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses.map((a) => a.address))))
    })
  } catch {
    throw new AppError('SSRF_DNS_FAILED', `Could not resolve host '${host}'.`, 400)
  }
  if (records.length === 0) {
    throw new AppError('SSRF_DNS_FAILED', `Could not resolve host '${host}'.`, 400)
  }

  for (const record of records) {
    if (isBlockedIp(record)) {
      throw new AppError('SSRF_BLOCKED_ADDRESS', `Address '${record}' for host '${host}' is not allowed.`, 400)
    }
  }
  return records[0]
}

/** True when a URL carries `user:pass@host` credentials. */
export function urlHasCredentials(url: URL): boolean {
  return Boolean(url.username) || Boolean(url.password)
}

/**
 * Validate a user-supplied remote import URL at creation time:
 *  - only http/https schemes,
 *  - no embedded credentials,
 *  - DNS resolves to a public, non-blocked address.
 *
 * Returns the URL object. This is a first gate; the downloader re-validates
 * every hop (including redirect targets) with resolveAndValidateHost.
 */
export async function validateRemoteUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError('INVALID_URL', 'The URL is not valid.', 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('UNSUPPORTED_URL_SCHEME', 'Only http:// and https:// URLs are supported.', 400)
  }
  if (urlHasCredentials(url)) {
    throw new AppError('URL_CREDENTIALS_NOT_ALLOWED', 'URLs containing credentials are not supported.', 400)
  }
  if (!url.hostname) {
    throw new AppError('INVALID_URL', 'The URL is missing a host.', 400)
  }
  await resolveAndValidateHost(url.hostname)
  return url
}
