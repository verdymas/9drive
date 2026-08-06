/**
 * Sanitize a remote-derived filename for safe use as a local name and a
 * provider name. Strips path separators, control characters, reserved
 * Windows names, and truncates to a sane length. Never trusts the remote.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]+/g
const ILLEGAL_CHARS = /[<>:"|?*]+/g
const PATH_SEPARATORS = /[\\/]+/g
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const TRAILING_DOTS_SPACES = /[. ]+$/

export function sanitizeFileName(raw: string): string {
  const fallback = 'file'
  let name = raw
    .replace(PATH_SEPARATORS, '-')
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_CHARS, '')
    .trim()
  if (!name) return fallback
  if (name === '.' || name === '..') return fallback
  if (RESERVED_WINDOWS.test(name)) return fallback
  if (name.length > 180) name = name.slice(0, 180)
  if (TRAILING_DOTS_SPACES.test(name)) name = name.replace(TRAILING_DOTS_SPACES, '')
  return name || fallback
}
