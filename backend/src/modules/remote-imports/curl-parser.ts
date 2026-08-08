/**
 * Pure cURL command parser for Remote Import ("Paste as cURL").
 *
 * SAFETY: this module NEVER executes anything — no child_process, no eval, no
 * shell, no request. It is a byte-level tokenizer that extracts exactly the 5
 * supported values (URL + Referer/Origin/User-Agent/Cookie) and rejects
 * everything else. The backend is authoritative: the frontend may preview, but
 * only this parser's output is ever used to fetch (spec §19).
 *
 * Support (spec §3):
 *   curl 'URL' | curl "URL" | curl URL
 *   -H/--header 'Name: value'   (only the 4 supported names)
 *   -A/--user-agent 'value'
 *   -b/--cookie 'value'
 *   -L/--location (accepted; the fetcher already follows redirects)
 *   multiline commands with backslash-newline continuation
 *
 * Rejected (spec §3-§4, §26, §30):
 *   - transport/tunnel/upload/data/form options (--proxy/-x/--socks4/5,
 *     --resolve, --connect-to, --interface, --unix-socket, --upload-file/-T,
 *     --form/-F, --data/-d/--data-binary), auth options (-u/--user,
 *     --oauth2-bearer, --basic, --digest, --anyauth, --key, --cacert, --cert,
 *     --capath, -k/--insecure), non-GET --request/-X,
 *   - shell composition in UNQUOTED tokens (`;`, `&&`, `||`, `$(`, backticks,
 *     pipes, redirections, braces),
 *   - multiple URLs or non-http(s) schemes,
 *   - `Authorization:` headers (explicit "not supported" message),
 *   - malformed quoting, CRLF injection, oversized values.
 */
import { AppError } from '../../utils/app-error.js'
import { validateRequestContext, type RemoteImportRequestContext } from './request-context.js'

export type ParsedCurlRemoteImport = {
  url: string
  requestContext: RemoteImportRequestContext
  unsupportedOptions: string[]
}

/**
 * A token plus whether it was quoted in the original command. Quoted spans may
 * legally contain shell metacharacters (a cookie like `session=abc;def` is a
 * quoted value, not a command); UNQUOTED tokens must never look like shell.
 */
type Arg = { value: string; quoted: boolean }

/** Shell-composition detection for UNQUOTED tokens (spec §3). */
const SHELL_COMPOSITION = /[;&|<>{}]|\$\(|`/

/** The 4 supported header names (case-insensitive). */
const SUPPORTED_HEADER_NAMES = new Set(['referer', 'origin', 'user-agent', 'cookie'])

/**
 * Tokenize a cURL command into logical argv entries, honoring single quotes,
 * double quotes, backslash-escapes inside double quotes, and backslash-newline
 * continuation. Unterminated quotes → null.
 */
function tokenize(input: string): Arg[] | null {
  const args: Arg[] = []
  let current = ''
  let quoted = false
  let inSingle = false
  let inDouble = false
  let i = 0
  const n = input.length

  const flush = () => {
    if (current) {
      args.push({ value: current, quoted })
      current = ''
      quoted = false
    }
  }

  while (i < n) {
    const ch = input[i]
    if (inSingle) {
      if (ch === "'") {
        inSingle = false
      } else {
        current += ch
        quoted = true
      }
      i += 1
      continue
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false
      } else if (ch === '\\' && i + 1 < n) {
        current += input[i + 1]
        quoted = true
        i += 2
        continue
      } else {
        current += ch
        quoted = true
      }
      i += 1
      continue
    }
    // Not inside a quote.
    if (ch === "'") {
      inSingle = true
      quoted = true
      i += 1
      continue
    }
    if (ch === '"') {
      inDouble = true
      quoted = true
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < n && input[i + 1] === '\n') {
      // Backslash-newline continuation — join lines.
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  flush()
  if (inSingle || inDouble) return null // unterminated quote
  return args
}

/** Options that are rejected up front — name only, never a value. */
const UNSAFE_OPTIONS = new Set([
  '--proxy', '-x', '--socks4', '--socks5', '--resolve', '--connect-to', '--interface',
  '--unix-socket', '--upload-file', '-T', '--form', '-F', '--data', '-d',
  '--data-binary', '-u', '--user', '--oauth2-bearer', '--basic', '--digest',
  '--anyauth', '--key', '--cacert', '--cert', '--capath', '-k', '--insecure',
  '-r', '--range', '-o', '--output', '-O', '--remote-name', '-I', '--head',
  '-G', '--get', '--next', '--output-dir', '--url', '--url-query', '--max-filesize',
  '--connect-timeout', '--max-time', '--retry', '--retry-delay', '--retry-all-errors',
  '--fail', '-f', '--verbose', '-v', '--trace', '--trace-ascii', '--write-out', '-w',
  '--dump-header', '-D', '--cookie-jar', '-c', '--netrc', '--netrc-file', '--preproxy',
  '--noproxy', '--proxy-user', '--proxy-header', '--alt-svc', '--doh-url', '--dns-servers',
  '--ftp-*', '--mail-*', '--telnet-*', '--tftp-*', '--metalink', '--parallel', '-Z',
  '--parallel-immediate', '--parallel-max', '--pass', '--pinnedpubkey', '--hostpubmd5',
  '--pubkey', '--quote', '--raw', '--request-target', '--run-tcp-fastopen',
  '--scp-require', '--ssl-allow-beast', '--ssl-reqd', '--tls-max', '--tlsv1',
  '--tlsv1.1', '--tlsv1.2', '--tlsv1.3', '--tls13-ciphers', '--ciphers', '--curves',
  '--egd-file', '--random-file', '--hostpubsha256', '--http1.0', '--http1.1',
  '--http2', '--http2-prior-knowledge', '--http3', '--no-keepalive', '--keepalive-time',
  '--limit-rate', '--speed-limit', '--speed-time', '--no-buffer', '--buffer',
  '--progress-bar', '-#', '--silent', '-s', '--show-error', '-S', '--stderr',
  '--location-trusted', '--no-location', '-L0',
])

/**
 * Parse a pasted cURL command. Throws stable AppError codes:
 *   REMOTE_IMPORT_CURL_INVALID, REMOTE_IMPORT_CURL_UNSAFE_OPTION,
 *   REMOTE_IMPORT_CURL_MULTIPLE_URLS, REMOTE_IMPORT_REQUEST_CONTEXT_INVALID,
 *   REMOTE_IMPORT_HEADER_VALUE_INVALID.
 */
export function parseCurl(input: string): ParsedCurlRemoteImport {
  const args = tokenize(input)
  if (!args) {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
  }

  // A browser-copied command starts with the `curl` binary name — drop it so it
  // is not mistaken for the URL (the first positional). Purely defensive: the
  // token is never executed, it is only skipped.
  if (args.length > 0 && args[0].value.toLowerCase() === 'curl') {
    args.shift()
  }
  if (args.length === 0) {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
  }

  let url: string | null = null
  const requestContext: RemoteImportRequestContext = {}
  const unsupportedOptions: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const { value: token, quoted } = args[i]

    // Shell composition is only rejected in UNQUOTED spans — quoted values are
    // literal (cookie/session values may legitimately contain `;` or `&`).
    if (!quoted && SHELL_COMPOSITION.test(token)) {
      throw new AppError('REMOTE_IMPORT_CURL_UNSAFE_OPTION', 'The pasted cURL command contains shell syntax and is not supported.', 400)
    }

    if (!token.startsWith('-') || token === '-') {
      // ── Positional: the URL (exactly one). ────────────────────────────────
      if (url !== null) {
        throw new AppError('REMOTE_IMPORT_CURL_MULTIPLE_URLS', 'Paste a cURL command with a single URL.', 400)
      }
      url = token
      continue
    }

    // ── Option handling. ────────────────────────────────────────────────────
    if (token === '-L' || token === '--location') continue // fetcher follows redirects anyway
    if (token === '--request' || token === '-X') {
      const method = args[i + 1]
      if (!method || !/^GET(\s|$)/i.test(method.value)) {
        throw new AppError('REMOTE_IMPORT_CURL_UNSAFE_OPTION', 'The pasted cURL command uses a request method that is not supported.', 400)
      }
      i += 1
      continue
    }
    if (token === '-H' || token === '--header') {
      const raw = args[i + 1]
      if (!raw) throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
      const colon = raw.value.indexOf(':')
      if (colon <= 0) {
        throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
      }
      const name = raw.value.slice(0, colon).trim().toLowerCase()
      const value = raw.value.slice(colon + 1).trim()
      i += 1
      if (name === 'authorization' || name === 'proxy-authorization') {
        throw new AppError('REMOTE_IMPORT_CURL_UNSAFE_OPTION', 'Authorization credentials are not supported by this feature.', 400)
      }
      if (!SUPPORTED_HEADER_NAMES.has(name)) {
        throw new AppError('REMOTE_IMPORT_CURL_UNSAFE_OPTION', `The header "${raw.value.slice(0, colon).trim()}" is not supported by this feature.`, 400)
      }
      if (name === 'referer') requestContext.referer = value
      else if (name === 'origin') requestContext.origin = value
      else if (name === 'user-agent') requestContext.userAgent = value
      else if (name === 'cookie') requestContext.cookie = value
      continue
    }
    if (token === '-A' || token === '--user-agent') {
      const value = args[i + 1]
      if (!value) throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
      requestContext.userAgent = value.value
      i += 1
      continue
    }
    if (token === '-b' || token === '--cookie') {
      const value = args[i + 1]
      if (!value) throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
      requestContext.cookie = value.value
      i += 1
      continue
    }
    if (UNSAFE_OPTIONS.has(token)) {
      unsupportedOptions.push(token)
      throw new AppError('REMOTE_IMPORT_CURL_UNSAFE_OPTION', `The pasted cURL command uses the option "${token}" which is not supported.`, 400)
    }
    // Anything unrecognized is fail-closed: never silently ignored (spec §4).
    unsupportedOptions.push(token)
    throw new AppError('REMOTE_IMPORT_CURL_UNSAFE_OPTION', `The pasted cURL command uses the option "${token}" which is not supported.`, 400)
  }

  if (!url) {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
  }

  // Scheme + URL sanity (the signed query string is preserved verbatim).
  // Control characters in the URL are rejected outright (new URL() would
  // silently percent-encode them, hiding an injection attempt).
  if (/[\x00-\x1f\x7f]/.test(url)) {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'The pasted cURL command could not be parsed.', 400)
  }

  // Authoritative validation of the extracted values (CR/LF, caps, origins).
  const validated = validateRequestContext(requestContext)
  return { url, requestContext: validated ?? {}, unsupportedOptions }
}