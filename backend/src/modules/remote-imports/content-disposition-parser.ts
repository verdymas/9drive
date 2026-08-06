/**
 * Content-Disposition header parser for Remote Import filename detection.
 *
 * Implements the parts of RFC 6266 / RFC 5987 / RFC 8187 the feature needs:
 *  - `filename="movie.mkv"` (quoted, escaped `\"` allowed inside),
 *  - `filename=movie.mkv` (token, unquoted),
 *  - `filename*=UTF-8''Movie%20Name.mkv` (RFC 5987 encoded — percent-decoded,
 *    unknown or invalid percent-encoding falls back to `filename`, never
 *    throws),
 *  - both present: `filename*` wins (RFC 6266 precedence),
 *  - semicolons inside a quoted string do not split the parameter,
 *  - parameter names are case-insensitive,
 *  - a malformed header returns `null` (the caller falls back to the URL),
 *  - `inline`/`attachment` dispositions with no filename return `null`.
 *
 * This is a dedicated parser (the repository has no Content-Disposition
 * dependency) and is covered by an extensive test suite. It never trusts the
 * remote value — callers pass the result through `sanitizeFileName`.
 */

/** True when a char is a valid RFC 2616 token character. */
function isTokenChar(ch: string): boolean {
  if (ch.length !== 1) return false
  const code = ch.charCodeAt(0)
  if (code > 126) return false
  if (code <= 32) return false
  return '()<>@,;:\\"/[]?={} \t'.indexOf(ch) === -1
}

/**
 * Extract the value of the FIRST parameter named `name` (case-insensitive)
 * from a header like `attachment; filename="movie.mkv"; size=123`,
 * tolerating `filename*=` as a distinct name (RFC 5987 uses a separate
 * parameter name; `name` is matched exactly, including the `*`).
 *
 * Scanning is character-by-character with a quoted-string state machine so
 * semicolons and backslash-escaped quotes inside quotes do not break parsing.
 */
export function getDispositionParameter(header: string, name: string): string | null {
  const lower = name.toLowerCase()
  let i = 0
  const n = header.length
  while (i < n) {
    // Skip whitespace and separators up to the next parameter name.
    while (i < n && (header[i] === ' ' || header[i] === '\t' || header[i] === ';')) i += 1
    if (i >= n) return null

    // Read a token (the parameter name), allowing one trailing `*` (RFC 5987
    // uses a separate `filename*` parameter; `*` is not a token char, so it
    // is consumed as part of the key here).
    const start = i
    while (i < n && isTokenChar(header[i])) i += 1
    if (i < n && header[i] === '*') i += 1
    if (start === i) {
      // Not a token char — skip one char and keep scanning (tolerates junk).
      i += 1
      continue
    }
    const key = header.slice(start, i)

    // Skip whitespace before `=`.
    while (i < n && (header[i] === ' ' || header[i] === '\t')) i += 1
    if (i >= n || header[i] !== '=') {
      // Bare parameter with no value — not our target; keep scanning.
      continue
    }
    i += 1
    while (i < n && (header[i] === ' ' || header[i] === '\t')) i += 1
    if (i >= n) return null

    if (key.toLowerCase() !== lower) {
      // Not our target — skip this parameter's value correctly (a quoted
      // value may contain semicolons, so we cannot just scan to `;`).
      if (header[i] === '"') {
        i += 1
        while (i < n) {
          if (header[i] === '\\') {
            i += 2
            continue
          }
          if (header[i] === '"') break
          i += 1
        }
        if (i < n) i += 1 // closing quote
      } else {
        while (i < n && isTokenChar(header[i])) i += 1
      }
      continue
    }

    // We found the target parameter — parse its value.
    if (header[i] === '"') {
      // Quoted string: backslash escapes the next char; `;` inside is literal.
      i += 1
      let out = ''
      while (i < n) {
        const ch = header[i]
        if (ch === '\\') {
          if (i + 1 < n) {
            out += header[i + 1]
            i += 2
            continue
          }
          break
        }
        if (ch === '"') {
          i += 1
          return out
        }
        out += ch
        i += 1
      }
      // Unterminated quote — treat the scan as failed.
      return null
    }

    // Token value (unquoted).
    const valueStart = i
    while (i < n && isTokenChar(header[i])) i += 1
    if (valueStart === i) return null
    return header.slice(valueStart, i)
  }
  return null
}

/** Percent-decode a string with strict UTF-8 validation (RFC 8187). */
function percentDecodeStrict(input: string): { ok: boolean; value: string } {
  try {
    const decoded = decodeURIComponent(input)
    return { ok: true, value: decoded }
  } catch {
    return { ok: false, value: input }
  }
}

/**
 * Validate a raw RFC 5987 ext value contains only allowed chars. Unreserved
 * characters may appear unencoded; `%` must begin a valid 2-hex escape (this
 * is verified by the strict decode).
 */
function isExtValue(value: string): boolean {
  return /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e%]*$/.test(value)
}

/** Reject decoded control characters (NUL, etc.) in an ext value. */
function hasControlChar(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value)
}

/**
 * Decode an RFC 5987/8187 `filename*=charset'lang'value` value.
 * Only UTF-8 is supported; any other charset, missing lang separator, or
 * malformed percent-encoding yields `{ ok: false }` so callers can fall back
 * to the plain `filename` parameter. Values may be partially unencoded
 * (unreserved chars), but the result must not contain control characters.
 */
export function decodeExtValue(value: string): { ok: boolean; value: string } {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(value)
  if (!match) return { ok: false, value }
  const charset = match[1].toLowerCase()
  const ext = match[3]
  if (charset !== 'utf-8') return { ok: false, value }
  if (!isExtValue(ext)) return { ok: false, value }
  const decoded = percentDecodeStrict(ext)
  if (!decoded.ok || hasControlChar(decoded.value)) return { ok: false, value }
  return { ok: true, value: decoded.value }
}

/**
 * Parse a Content-Disposition header value and return the effective filename,
 * or `null` when no usable filename is present. Precedence per RFC 6266:
 * `filename*` (RFC 5987) over `filename`; a broken `filename*` falls back to
 * `filename`. `inline; filename=` (empty) counts as absent.
 */
export function parseContentDispositionFileName(header: string): string | null {
  if (!header) return null
  // `filename*` must be matched before the plain `filename` scan so the `*`
  // marker is consumed as part of the key.
  const ext = getDispositionParameter(header, 'filename*')
  if (ext !== null) {
    const decoded = decodeExtValue(ext)
    if (decoded.ok && decoded.value.length > 0) return decoded.value
  }
  const plain = getDispositionParameter(header, 'filename')
  if (plain !== null && plain.length > 0) return plain
  return null
}
