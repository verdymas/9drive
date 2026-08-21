/**
 * Sanitize a remote-derived filename for safe use as a local name and a
 * provider name.
 *
 * The sanitizer is the LAST line of defense for anything that came from the
 * remote (Content-Disposition header or URL path) and is applied again at
 * import creation even when the probe already sanitized: the worker never
 * lets a remote value influence a local filesystem path (temp files are keyed
 * by import id, never by filename), and the registered name is always the
 * sanitized value.
 *
 * Rules:
 *  - Unicode NFC normalization (canonical form — visually identical but
 *    differently-composed names do not produce distinct files),
 *  - null bytes and control characters removed,
 *  - path separators and traversal components (`..`, `.`) removed — a
 *    filename can never contain a path,
 *  - Windows-illegal chars (`<>:"|?*`) and trailing dots/spaces removed,
 *  - reserved Windows device names (CON, PRN, AUX, NUL, COM1.., LPT1..)
 *    replaced with the fallback,
 *  - truncated to MAX_NAME_LENGTH (the backend's `fileName` column max),
 *    preserving the extension when truncation is needed,
 *  - never returns an empty string (falls back to 'file').
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g
const ILLEGAL_CHARS = /[<>:"|?*]+/g
const PATH_SEPARATORS = /[\\/]+/g
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const TRAILING_DOTS_SPACES = /[. ]+$/

/** Max stored name length (matches the `fileName` column: varchar(255)). */
export const MAX_NAME_LENGTH = 255

/** Replace the suffix `.exe` on a reserved device name (keep extension). */
const RESERVED_WITH_EXT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.(.*)$/i

/**
 * Split a sanitized name into `[stem, extension]` where the extension is the
 * final `.xxx` (or `.tar.gz` for common multi-part suffixes) when present.
 * Used to preserve the extension across truncation and duplicate-avoidance.
 */
function splitExtension(name: string): [string, string] {
  const multi = /\.(tar\.gz|tar\.bz2|tar\.xz|tar\.zst)$/i.exec(name)
  if (multi) return [name.slice(0, multi.index), name.slice(multi.index + 1)]
  const dot = name.lastIndexOf('.')
  if (dot > 0) return [name.slice(0, dot), name.slice(dot + 1)]
  return [name, '']
}

/** Replace a reserved Windows device name (optionally with extension). */
function replaceReserved(name: string): string | null {
  if (RESERVED_WINDOWS.test(name)) {
    const m = RESERVED_WITH_EXT.exec(name)
    return m ? `file.${m[2]}` : 'file'
  }
  return null
}

/**
 * Sanitize a candidate filename. `raw` may be anything the remote or the user
 * supplied; the result is always a safe, non-empty, path-free name.
 */
export function sanitizeFileName(raw: string): string {
  const fallback = 'file'
  let name = raw.normalize('NFC')
    .replace(PATH_SEPARATORS, '-')
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_CHARS, '')
    .trim()
  if (!name) return fallback
  if (name === '.' || name === '..') return fallback
  const replaced = replaceReserved(name)
  if (replaced) return replaced
  if (name.length > MAX_NAME_LENGTH) {
    const [stem, ext] = splitExtension(name)
    const room = MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0)
    name = stem.slice(0, Math.max(room, 1)) + (ext ? `.${ext}` : '')
  }
  if (TRAILING_DOTS_SPACES.test(name)) name = name.replace(TRAILING_DOTS_SPACES, '')
  return name || fallback
}

/**
 * Append an extension to `name` unless it already has one (or `name` ends in
 * a dot). Used by the generated-fallback path so we never produce
 * `movie.mkv.mkv`. The extension is sanitized (alphanumeric + dot only).
 */
export function appendExtension(name: string, extension: string | null | undefined): string {
  if (!extension) return name
  const ext = extension.replace(/[^a-zA-Z0-9.+_-]/g, '').replace(/^\.+/, '')
  if (!ext) return name
  if (/\.$/.test(name) || name.endsWith(`.${ext}`) || name === ext) return name
  return `${name}.${ext}`
}

/** True when the name already carries a terminal extension (`.mp4`, `.tar.gz`). */
export function nameHasExtension(name: string): boolean {
  return /\.\w{1,8}$/.test(name)
}

/**
 * Known-safe Content-Type → file extension mappings. Used ONLY to give a
 * file a usable extension when the remote provided none (no Content-
 * Disposition header, extensionless URL path). Unknown types map to nothing —
 * a guessed extension is worse than none. HLS playlist types are deliberately
 * absent (HLS imports name by the output container instead).
 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/mp2t': 'ts',
  'video/mpeg': 'mpg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
}

/** Extension for a known-safe MIME type (normalized, lowercased) or null. */
export function extensionFromMime(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return MIME_EXTENSIONS[base] ?? null
}

/**
 * Append a MIME-derived extension when the name has none AND the type maps to
 * a known-safe extension. Never touches a name that already has one and never
 * guesses for unknown types.
 */
export function appendExtensionFromMime(name: string, mimeType: string | null | undefined): string {
  if (nameHasExtension(name)) return name
  return appendExtension(name, extensionFromMime(mimeType))
}
