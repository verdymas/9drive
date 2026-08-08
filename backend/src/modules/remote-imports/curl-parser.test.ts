import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseCurl } from './curl-parser.js'
import { AppError } from '../../utils/app-error.js'

/**
 * Mandatory spec §30: pure-parser unit tests. The parser must never execute
 * anything — the import-graph assertion below proves the module cannot spawn a
 * process or evaluate code.
 */

/** Parse and return the extracted values, throwing on AppError. */
function parse(input: string) {
  return parseCurl(input)
}

/** Assert the parser rejects input with the given stable code. */
function expectReject(input: string, code: string) {
  try {
    parse(input)
  } catch (err) {
    expect((err as AppError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code} for: ${JSON.stringify(input.slice(0, 80))}`)
}

describe('curl-parser: accepted inputs (spec §30)', () => {
  it('parses a simple URL', () => {
    const out = parse("curl 'https://example.com/file.mkv'")
    expect(out.url).toBe('https://example.com/file.mkv')
    expect(out.requestContext).toEqual({})
  })

  it('accepts single-quoted, double-quoted and unquoted URLs', () => {
    expect(parse("curl 'https://example.com/a'").url).toBe('https://example.com/a')
    expect(parse('curl "https://example.com/b"').url).toBe('https://example.com/b')
    expect(parse('curl https://example.com/c').url).toBe('https://example.com/c')
  })

  it('supports multiline backslash continuation', () => {
    const out = parse(
      "curl 'https://example.com/file.mkv' \\\n" +
        "  -H 'Referer: https://site.example/watch/1' \\\n" +
        "  -H 'Cookie: session=valid'",
    )
    expect(out.url).toBe('https://example.com/file.mkv')
    expect(out.requestContext.referer).toBe('https://site.example/watch/1')
    expect(out.requestContext.cookie).toBe('session=valid')
  })

  it('extracts -H/--header Referer, Origin, User-Agent and Cookie (case-insensitive names)', () => {
    const out = parse(
      "curl 'https://example.com/x' " +
        "-H 'Referer: https://site.example/1' " +
        "--header 'origin: https://site.example' " +
        "-H 'User-Agent: Mozilla/5.0 Test' " +
        "--header 'COOKIE: session=abc'",
    )
    expect(out.requestContext).toEqual({
      referer: 'https://site.example/1',
      origin: 'https://site.example',
      userAgent: 'Mozilla/5.0 Test',
      cookie: 'session=abc',
    })
  })

  it('supports -A/--user-agent and -b/--cookie', () => {
    const out = parse("curl 'https://example.com/x' -A 'Mozilla/5.0' -b 'session=valid'")
    expect(out.requestContext.userAgent).toBe('Mozilla/5.0')
    expect(out.requestContext.cookie).toBe('session=valid')
  })

  it('accepts -L/--location (the fetcher follows redirects anyway)', () => {
    const out = parse("curl -L 'https://example.com/x' --location")
    expect(out.url).toBe('https://example.com/x')
  })

  it('preserves a signed query string verbatim', () => {
    const out = parse("curl 'https://example.com/video.m3u8?token=abc&sig=xyz'")
    expect(out.url).toBe('https://example.com/video.m3u8?token=abc&sig=xyz')
  })

  it('allows spaces and colons inside quoted header values', () => {
    const out = parse("curl 'https://example.com/x' -H 'Cookie: session=abc:def; path=/; secure'")
    expect(out.requestContext.cookie).toBe('session=abc:def; path=/; secure')
  })

  it('accepts -X GET explicitly', () => {
    const out = parse("curl -X GET 'https://example.com/x'")
    expect(out.url).toBe('https://example.com/x')
  })
})

describe('curl-parser: rejected inputs (spec §30)', () => {
  it('rejects multiple URLs', () => {
    expectReject("curl 'https://example.com/a' 'https://example.com/b'", 'REMOTE_IMPORT_CURL_MULTIPLE_URLS')
  })

  it('rejects non-http(s) schemes', () => {
    expectReject("curl 'file:///etc/passwd'", 'REMOTE_IMPORT_CURL_INVALID')
    expectReject("curl 'ftp://example.com/x'", 'REMOTE_IMPORT_CURL_INVALID')
  })

  it('rejects transport/tunnel options', () => {
    expectReject("curl 'https://example.com/x' --proxy http://proxy:8080", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' -x http://proxy:8080", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --socks5 127.0.0.1:9050", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --resolve example.com:443:1.2.3.4", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --connect-to example.com:443:1.2.3.4:443", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --interface eth0", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --unix-socket /tmp/sock", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects upload/data/form options', () => {
    expectReject("curl 'https://example.com/x' --upload-file local.bin", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' -T local.bin", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --form 'file=@local.bin'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' -F 'a=b'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --data 'a=b'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' -d 'a=b'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --data-binary @payload.bin", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects auth options', () => {
    expectReject("curl 'https://example.com/x' -u user:pass", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --oauth2-bearer token", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --basic", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --digest", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --anyauth", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --key key.pem", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --cacert ca.pem", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --cert cert.pem", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --capath /etc/certs", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' -k", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' --insecure", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects non-GET request methods', () => {
    expectReject("curl -X POST 'https://example.com/x'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl --request DELETE 'https://example.com/x'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects Authorization with the clear "not supported" message', () => {
    try {
      parse("curl 'https://example.com/x' -H 'Authorization: Bearer token123'")
    } catch (err) {
      expect((err as AppError).code).toBe('REMOTE_IMPORT_CURL_UNSAFE_OPTION')
      expect((err as AppError).message).toBe('Authorization credentials are not supported by this feature.')
      return
    }
    throw new Error('expected rejection')
  })

  it('rejects Proxy-Authorization too', () => {
    expectReject("curl 'https://example.com/x' -H 'Proxy-Authorization: Basic abc'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects unsupported header names (fail-closed, never silent)', () => {
    expectReject("curl 'https://example.com/x' -H 'X-Custom: value'", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects unknown options (fail-closed)', () => {
    expectReject("curl 'https://example.com/x' --totally-unknown", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects shell chaining in unquoted tokens', () => {
    expectReject("curl 'https://example.com/x' ; rm -rf /", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' && whoami", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' || echo hi", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects command substitution and pipes/redirections in unquoted tokens', () => {
    expectReject("curl 'https://example.com/x' $(id)", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject('curl https://example.com/x `id`', 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' | sh", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' > out.bin", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
    expectReject("curl 'https://example.com/x' < in.bin", 'REMOTE_IMPORT_CURL_UNSAFE_OPTION')
  })

  it('rejects malformed/unterminated quoting', () => {
    expectReject("curl 'https://example.com/x", 'REMOTE_IMPORT_CURL_INVALID')
    expectReject('curl "https://example.com/x', 'REMOTE_IMPORT_CURL_INVALID')
  })

  it('rejects CRLF injection inside a header value', () => {
    expectReject("curl 'https://example.com/x' -H 'Cookie: a=1\r\nX-Evil: 1'", 'REMOTE_IMPORT_REQUEST_CONTEXT_INVALID')
  })

  it('rejects a missing URL', () => {
    expectReject("curl -H 'Referer: https://example.com/'", 'REMOTE_IMPORT_CURL_INVALID')
  })

  it('rejects a control-character URL', () => {
    expectReject('curl https://example.com/\x1b', 'REMOTE_IMPORT_CURL_INVALID')
  })
})

describe('curl-parser: never executes (spec §30)', () => {
  it('imports only safe modules — no child_process, no eval, no shell', () => {
    const source = readFileSync(new URL('./curl-parser.ts', import.meta.url), 'utf8')
    // Only the import statements matter: a module that cannot reference a
    // process-spawning API cannot execute anything.
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n')
    expect(imports).not.toMatch(/child_process/)
    expect(imports).not.toMatch(/\beval\b/)
    expect(imports).not.toMatch(/\bexec(File|Sync)?\s*\(/)
    expect(imports).not.toMatch(/\bspawn\s*\(/)
    expect(imports).not.toMatch(/\bsh\b/)
    expect(imports).not.toMatch(/\bcurl\b/)
    expect(imports).not.toMatch(/node:fs/)
  })
})
