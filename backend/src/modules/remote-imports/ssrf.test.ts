import { describe, expect, it } from 'vitest'
import { isBlockedIp, urlHasCredentials, validateRemoteUrl, resolveAndValidateHost } from './ssrf.js'
import { AppError } from '../../utils/app-error.js'

describe('isBlockedIp', () => {
  it('blocks loopback addresses (IPv4 and IPv4-mapped IPv6)', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('127.255.255.254')).toBe(true)
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIp('::1')).toBe(true)
  })

  it('blocks private ranges', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true)
    expect(isBlockedIp('172.16.0.1')).toBe(true)
    expect(isBlockedIp('172.31.255.255')).toBe(true)
    expect(isBlockedIp('192.168.1.1')).toBe(true)
    expect(isBlockedIp('::ffff:10.0.0.5')).toBe(true)
  })

  it('blocks link-local and cloud metadata endpoints', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true)
    expect(isBlockedIp('169.254.0.1')).toBe(true)
    expect(isBlockedIp('fe80::1')).toBe(true)
  })

  it('blocks CGNAT, documentation, benchmark and multicast space', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true)
    expect(isBlockedIp('192.0.2.1')).toBe(true)
    expect(isBlockedIp('198.51.100.1')).toBe(true)
    expect(isBlockedIp('203.0.113.1')).toBe(true)
    expect(isBlockedIp('198.18.0.1')).toBe(true)
    expect(isBlockedIp('224.0.0.1')).toBe(true)
    expect(isBlockedIp('240.0.0.1')).toBe(true)
  })

  it('blocks IPv6 ULA', () => {
    expect(isBlockedIp('fc00::1')).toBe(true)
    expect(isBlockedIp('fd12:3456:789a::1')).toBe(true)
  })

  it('allows public addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('1.1.1.1')).toBe(false)
    expect(isBlockedIp('93.184.216.34')).toBe(false)
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
  })

  it('rejects unparseable input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true)
    expect(isBlockedIp('')).toBe(true)
  })
})

describe('urlHasCredentials', () => {
  it('detects embedded userinfo', () => {
    expect(urlHasCredentials(new URL('https://example.com/file'))).toBe(false)
    expect(urlHasCredentials(new URL('https://user@example.com/file'))).toBe(true)
    expect(urlHasCredentials(new URL('https://user:pass@example.com/file'))).toBe(true)
  })
})

describe('validateRemoteUrl / resolveAndValidateHost', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(validateRemoteUrl('ftp://example.com/file')).rejects.toMatchObject({ code: 'UNSUPPORTED_URL_SCHEME' })
    await expect(validateRemoteUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'UNSUPPORTED_URL_SCHEME' })
    await expect(validateRemoteUrl('gopher://example.com')).rejects.toMatchObject({ code: 'UNSUPPORTED_URL_SCHEME' })
  })

  it('rejects malformed URLs', async () => {
    await expect(validateRemoteUrl('not a url')).rejects.toMatchObject({ code: 'INVALID_URL' })
    await expect(validateRemoteUrl('https://')).rejects.toThrow(AppError)
  })

  it('rejects URLs with embedded credentials', async () => {
    await expect(validateRemoteUrl('https://user:secret@example.com/file')).rejects.toMatchObject({ code: 'URL_CREDENTIALS_NOT_ALLOWED' })
  })

  it('rejects hostnames resolving to private or loopback addresses', async () => {
    await expect(validateRemoteUrl('http://localhost/file')).rejects.toMatchObject({ code: 'SSRF_BLOCKED_ADDRESS' })
    await expect(validateRemoteUrl('http://127.0.0.1/file')).rejects.toMatchObject({ code: 'SSRF_BLOCKED_ADDRESS' })
    await expect(validateRemoteUrl('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED_ADDRESS' })
    await expect(validateRemoteUrl('http://10.0.0.5/file')).rejects.toMatchObject({ code: 'SSRF_BLOCKED_ADDRESS' })
  })

  it('resolves a public hostname to its address', async () => {
    const ip = await resolveAndValidateHost('example.com')
    expect(ip).toBeTruthy()
    expect(isBlockedIp(ip)).toBe(false)
  })

  it('throws a stable AppError for unresolvable hosts', async () => {
    await expect(resolveAndValidateHost('host-that-does-not-exist.invalid')).rejects.toMatchObject({ code: 'SSRF_DNS_FAILED' })
  })
})