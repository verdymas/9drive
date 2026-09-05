/**
 * 9Drive metadata embedded in Telegram document captions.
 *
 * Captions on Telegram storage documents carry the logical identity of the
 * 9Drive file, so a re-upload, a new channel, or a filename change cannot
 * break identity:
 *
 *     9drive:id=<stable-file-id>
 *     9drive:path=Projects/APP-V/docs/architecture.md
 *
 * Rules (single source of truth — see
 * `implementations/9drive-telegram-path-metadata-prompts/README.md`):
 *   - 9Drive is the authoritative logical filesystem.
 *   - Telegram Topics are not mapped to folders.
 *   - Filename is the actual filename (independent of the path).
 *   - `9drive:id` is stable identity.
 *   - `9drive:path` is the current logical location.
 *   - Telegram deletion must not delete a 9Drive file.
 *
 * Encoding is deterministic and reversible: the encoder never produces
 * characters the parser would refuse, and the parser never throws on
 * malformed input — it always returns a structured result so callers can
 * route unrecognizable captions to the existing inbox folder.
 */

export const NINE_DRIVE_ID_KEY = '9drive:id'
export const NINE_DRIVE_PATH_KEY = '9drive:path'
export const NINE_DRIVE_META_KEY = '9drive:meta'

/** Stable-id format: ASCII letters/digits/`-`/`_`/`.`, 1..36 chars. UUIDs fit. */
const STABLE_ID_RE = /^[A-Za-z0-9._-]{1,36}$/

/** Path segment allowed: anything but `/`, control chars, and a small list of
 *  reserved chars that would collide with the caption format (`\n`, `\r`,
 * `\0`, `:`, `*`, `?`). Segments are joined by `/`. */
const SEGMENT_FORBIDDEN_RE = /[\u0000\u000A\u000D/:?*]/

/** Telegram caption limit for documents. */
export const TELEGRAM_CAPTION_MAX = 1024

/**
 * A path segment is unsafe when it is `.` or `..`: it can never be a real
 * file/folder name in 9Drive, and accepting it would let a malicious caption
 * claim a path outside the user's root (spec §8, §21). The path builders
 * reject any path containing such a segment by returning `null`, so the
 * caller falls back to the inbox instead of creating a `.`/`..` folder.
 */
export function isUnsafeSegment(segment: string): boolean {
  return segment === '.' || segment === '..'
}

export type ParsedMetadata = {
  /** Stable file id from `9drive:id=`, or `null` when not present / invalid. */
  stableId: string | null
  /** Logical path (segments, NFC, slash-joined, no leading/trailing slash),
   *  or `null` when not present / invalid. The final segment is the
   *  filename in 9Drive; the parser does not split it off — that is the
   *  caller's job (the file model already owns the filename column). */
  logicalPath: string | null
  /** Encrypted recovery metadata line value (`v1:<payload>`) from
   *  `9drive:meta=`, or `null` when not present / invalid. Callers must
   *  NOT decrypt it for normal reads — only sync / recovery / manual
   *  repair. Legacy plaintext `9drive:path` remains supported. */
  encryptedMeta: string | null
  /** Original caption lines minus the recognized 9Drive lines, preserved
   *  in order so we don't lose user-written captions. */
  extraLines: string[]
  /** `true` when at least one `9drive:*` key was recognized. Used to route
   *  to the inbox vs. a deterministic ingest. */
  hasAny: boolean
  /** Per-key diagnostic: which keys were seen, which were kept (first
   *  wins), which were dropped as malformed or duplicated. Useful for the
   *  structured logging the ingest emits. */
  diagnostics: {
    idSeen: number
    idKept: boolean
    idReason?: 'missing' | 'malformed' | 'duplicate'
    pathSeen: number
    pathKept: boolean
    pathReason?: 'missing' | 'malformed' | 'empty' | 'duplicate'
    metaSeen: number
    metaKept: boolean
    metaReason?: 'missing' | 'malformed' | 'duplicate'
  }
}

const EMPTY_DIAGNOSTICS: ParsedMetadata['diagnostics'] = {
  idSeen: 0,
  idKept: false,
  idReason: 'missing',
  pathSeen: 0,
  pathKept: false,
  pathReason: 'missing',
  metaSeen: 0,
  metaKept: false,
  metaReason: 'missing',
}

/** Split a caption on the only separator that survives captions intact: LF.
 *  CR is tolerated; CRLF is normalized to LF. Trailing empty lines are
 *  dropped so a caption that ends with `\n` doesn't surface a phantom line. */
function splitCaptionLines(caption: string | null | undefined): string[] {
  if (!caption) return []
  const normalized = caption.replace(/\r\n?/g, '\n')
  const parts = normalized.split('\n')
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Detect whether a line carries a known 9Drive key (`9drive:id=` or
 *  `9drive:path=`). Case-sensitive — the encoder always emits lowercase
 *  keys, and mixed-case keys are deliberate no-ops to avoid silently
 *  accepting malformed input. */
function isNineDriveLine(line: string): boolean {
  return (
    line.startsWith(`${NINE_DRIVE_ID_KEY}=`) ||
    line.startsWith(`${NINE_DRIVE_PATH_KEY}=`) ||
    line.startsWith(`${NINE_DRIVE_META_KEY}=`)
  )
}

/** Encode a logical path (slash-joined, NFC) into a single caption line.
 *  Per-segment forbidden characters are dropped on the encoder side: a
 *  segment containing `/`, control chars, `:`, `*`, or `?` is rejected
 *  with `null` so the caller never produces an unparseable caption. The
 *  resulting line never exceeds `TELEGRAM_CAPTION_MAX`. */
function encodePath(path: string): string | null {
  if (typeof path !== 'string') return null
  const normalized = path.normalize('NFC').trim()
  if (normalized === '') return null
  // Strip a single leading slash so callers can pass either form.
  const trimmed = normalized.replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed === '') return null
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (segment === '') return null
    if (segment.length > 255) return null
    if (SEGMENT_FORBIDDEN_RE.test(segment)) return null
    if (isUnsafeSegment(segment)) return null
  }
  const line = `${NINE_DRIVE_PATH_KEY}=${segments.join('/')}`
  if (line.length > TELEGRAM_CAPTION_MAX) return null
  return line
}

/**
 * Build the full caption for an outbound Telegram document. Returns a
 * single string ≤ `TELEGRAM_CAPTION_MAX`. Existing extra lines from a
 * previous caption are preserved (in order) when supplied; new extras are
 * dropped if the combined caption would exceed the limit. Stable id is
 * validated with `STABLE_ID_RE`. Returns `null` only when the stable id is
 * missing/malformed — the caller should never invoke this without an id
 * because a caption without `9drive:id` is uninformative.
 */
export function encodeCaption(input: {
  stableId: string
  logicalPath?: string | null
  /** Pre-encrypted `9drive:meta` line VALUE (`v1:<payload>`), emitted when
   *  the caller has encrypted the recovery metadata. Callers must produce
   *  it via the crypto service — this module never encrypts. */
  encryptedMeta?: string | null
  extras?: string[] | null
}): string | null {
  if (!STABLE_ID_RE.test(input.stableId)) return null
  const lines: string[] = [`${NINE_DRIVE_ID_KEY}=${input.stableId}`]
  // The encrypted `9drive:meta` payload already carries the logical path
  // (see RecoveryMetadata.path). Emitting the plaintext `9drive:path` line
  // beside it would defeat the encryption: anyone with channel access could
  // read the path the spec was trying to hide. Mutually exclusive here so
  // callers don't have to remember — the plaintext line is the fallback
  // only when the encrypted line is dropped (empty / oversized ciphertext).
  let metaEmitted = false
  if (input.encryptedMeta) {
    const clean = input.encryptedMeta.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
    if (clean !== '' && clean.length <= TELEGRAM_CAPTION_MAX - `${NINE_DRIVE_META_KEY}=`.length) {
      lines.push(`${NINE_DRIVE_META_KEY}=${clean}`)
      metaEmitted = true
    }
  }
  if (input.logicalPath && !metaEmitted) {
    const pathLine = encodePath(input.logicalPath)
    if (pathLine) lines.push(pathLine)
  }
  if (input.extras && input.extras.length > 0) {
    for (const extra of input.extras) {
      if (typeof extra !== 'string') continue
      // Strip control chars but keep the rest so user-written captions
      // (emails, descriptions, hashes) survive.
      const clean = extra.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
      if (clean === '') continue
      // Don't carry a 9drive line through extras — the parser would
      // treat it as a duplicate.
      if (isNineDriveLine(clean)) continue
      const candidate = [...lines, clean].join('\n')
      if (candidate.length > TELEGRAM_CAPTION_MAX) break
      lines.push(clean)
    }
  }
  const caption = lines.join('\n')
  return caption.length <= TELEGRAM_CAPTION_MAX ? caption : null
}

/**
 * Parse a caption string into a `ParsedMetadata`. Never throws. Always
 * returns a structured result so the caller can route unrecognizable
 * captions to the inbox. Duplicate keys: first wins, the rest are
 * counted in `diagnostics.idSeen`/`pathSeen` and flagged as `duplicate`.
 */
export function parseCaption(caption: string | null | undefined): ParsedMetadata {
  const lines = splitCaptionLines(caption)
  const diagnostics: ParsedMetadata['diagnostics'] = { ...EMPTY_DIAGNOSTICS }
  let stableId: string | null = null
  let logicalPath: string | null = null
  let encryptedMeta: string | null = null
  const extraLines: string[] = []

  for (const line of lines) {
    if (line.startsWith(`${NINE_DRIVE_ID_KEY}=`)) {
      diagnostics.idSeen += 1
      const value = line.slice(NINE_DRIVE_ID_KEY.length + 1)
      if (stableId !== null) {
        diagnostics.idReason = 'duplicate'
        continue
      }
      if (STABLE_ID_RE.test(value)) {
        stableId = value
        diagnostics.idKept = true
        diagnostics.idReason = undefined
      } else {
        diagnostics.idReason = 'malformed'
      }
      continue
    }
    if (line.startsWith(`${NINE_DRIVE_PATH_KEY}=`)) {
      diagnostics.pathSeen += 1
      const value = line.slice(NINE_DRIVE_PATH_KEY.length + 1)
      if (logicalPath !== null) {
        diagnostics.pathReason = 'duplicate'
        continue
      }
      const normalized = normalizeLogicalPath(value)
      if (normalized === null) {
        diagnostics.pathReason = value === '' ? 'empty' : 'malformed'
      } else {
        logicalPath = normalized
        diagnostics.pathKept = true
        diagnostics.pathReason = undefined
      }
      continue
    }
    if (line.startsWith(`${NINE_DRIVE_META_KEY}=`)) {
      diagnostics.metaSeen += 1
      const value = line.slice(NINE_DRIVE_META_KEY.length + 1)
      if (encryptedMeta !== null) {
        diagnostics.metaReason = 'duplicate'
        continue
      }
      if (value === '') {
        diagnostics.metaReason = 'malformed'
      } else {
        encryptedMeta = value
        diagnostics.metaKept = true
        diagnostics.metaReason = undefined
      }
      continue
    }
    extraLines.push(line)
  }

  return {
    stableId,
    logicalPath,
    encryptedMeta,
    extraLines,
    hasAny: stableId !== null || logicalPath !== null || encryptedMeta !== null,
    diagnostics,
  }
}

/**
 * Normalize a logical path to its canonical form: NFC, slash-joined, no
 * leading/trailing slash, no empty segments, no forbidden characters per
 * segment. Returns `null` for invalid input so the caller can treat
 * malformed paths as "missing".
 */
export function normalizeLogicalPath(rawPath: string | null | undefined): string | null {
  if (typeof rawPath !== 'string') return null
  const normalized = rawPath.normalize('NFC').trim()
  if (normalized === '') return null
  const stripped = normalized.replace(/^\/+/, '').replace(/\/+$/, '')
  if (stripped === '') return null
  const segments = stripped.split('/')
  const cleaned: string[] = []
  for (const segment of segments) {
    if (segment === '') return null
    if (segment.length > 255) return null
    if (SEGMENT_FORBIDDEN_RE.test(segment)) return null
    if (isUnsafeSegment(segment)) return null
    cleaned.push(segment)
  }
  return cleaned.join('/')
}

/** Split a normalized logical path into its segments. The last segment is
 *  the filename; the rest is the folder chain. Returns `[]` for a null
 *  path so callers don't have to special-case. */
export function splitLogicalPath(path: string | null | undefined): string[] {
  if (!path) return []
  return path.split('/')
}

/** Build a logical path from segments (NFC + slash-join). Returns `null`
 *  when any segment is invalid. */
export function buildLogicalPath(segments: string[]): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null
  const cleaned: string[] = []
  for (const segment of segments) {
    if (typeof segment !== 'string') return null
    const normalized = segment.normalize('NFC').trim()
    if (normalized === '') return null
    if (normalized.length > 255) return null
    if (SEGMENT_FORBIDDEN_RE.test(normalized)) return null
    if (isUnsafeSegment(normalized)) return null
    cleaned.push(normalized)
  }
  return cleaned.join('/')
}

/** True when the input looks like a 9Drive caption (at least one known
 *  key is present, valid or not). */
export function looksLikeNineDriveCaption(caption: string | null | undefined): boolean {
  if (!caption) return false
  return (
    caption.includes(`${NINE_DRIVE_ID_KEY}=`) ||
    caption.includes(`${NINE_DRIVE_PATH_KEY}=`) ||
    caption.includes(`${NINE_DRIVE_META_KEY}=`)
  )
}