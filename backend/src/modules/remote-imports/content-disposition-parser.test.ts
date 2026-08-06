import { describe, expect, it } from 'vitest'
import { getDispositionParameter, parseContentDispositionFileName, decodeExtValue } from './content-disposition-parser.js'

/**
 * Content-Disposition parser tests (§4/§13). Covers every listed case plus
 * precedence, malformed headers, traversal payloads, and escaped quotes.
 */
describe('parseContentDispositionFileName', () => {
  it('handles the canonical quoted form', () => {
    expect(parseContentDispositionFileName('attachment; filename="movie.mkv"')).toBe('movie.mkv')
  })

  it('handles the unquoted token form', () => {
    expect(parseContentDispositionFileName('attachment; filename=movie.mkv')).toBe('movie.mkv')
  })

  it('decodes a UTF-8 filename* value', () => {
    expect(parseContentDispositionFileName("attachment; filename*=UTF-8''Movie%20Name.mkv")).toBe('Movie Name.mkv')
  })

  it('gives filename* precedence over filename', () => {
    expect(
      parseContentDispositionFileName("attachment; filename=\"fallback.mkv\"; filename*=UTF-8''Nama%20Film.mkv"),
    ).toBe('Nama Film.mkv')
  })

  it('returns the filename for an inline disposition', () => {
    expect(parseContentDispositionFileName('inline; filename="movie.mkv"')).toBe('movie.mkv')
  })

  it('does not break on a semicolon inside a quoted value', () => {
    expect(parseContentDispositionFileName('attachment; filename="file;name.mkv"')).toBe('file;name.mkv')
  })

  it('handles escaped quotes inside a quoted value', () => {
    expect(parseContentDispositionFileName('attachment; filename="escaped\\"name.mkv"')).toBe('escaped"name.mkv')
  })

  it('decodes a non-ASCII UTF-8 filename*', () => {
    expect(parseContentDispositionFileName("attachment; filename*=UTF-8''%E6%98%A0%E7%94%BB.mkv")).toBe('映画.mkv')
  })

  it('accepts a filename* with unencoded unreserved chars', () => {
    expect(parseContentDispositionFileName("attachment; filename*=UTF-8''Movie%20Name.mkv")).toBe('Movie Name.mkv')
    expect(parseContentDispositionFileName("attachment; filename*=UTF-8''MovieName.mkv")).toBe('MovieName.mkv')
  })

  it('falls back to filename when filename* has invalid percent-encoding', () => {
    expect(
      parseContentDispositionFileName("attachment; filename*=UTF-8''invalid%ZZname.mkv; filename=\"fallback.mkv\""),
    ).toBe('fallback.mkv')
  })

  it('falls back to filename when filename* is non-UTF-8', () => {
    expect(
      parseContentDispositionFileName("attachment; filename*=ISO-8859-1''caf%2Etxt; filename=\"plain.txt\""),
    ).toBe('plain.txt')
  })

  it('returns null for a bare "attachment" disposition', () => {
    expect(parseContentDispositionFileName('attachment')).toBeNull()
  })

  it('returns null for a malformed header', () => {
    expect(parseContentDispositionFileName('attachment; fish"broken')).toBeNull()
    expect(parseContentDispositionFileName(';;;;')).toBeNull()
  })

  it('returns null for an empty header', () => {
    expect(parseContentDispositionFileName('')).toBeNull()
    expect(parseContentDispositionFileName(null as unknown as string)).toBeNull()
  })

  it('returns null for an empty filename', () => {
    expect(parseContentDispositionFileName('attachment; filename=""')).toBeNull()
  })

  it('returns the traversal-looking filename verbatim (sanitizer handles it later)', () => {
    expect(parseContentDispositionFileName('attachment; filename="../movie.mkv"')).toBe('../movie.mkv')
    // RFC 7230: backslash escapes the next char in a quoted string, so
    // `\m` → `m` — the traversal name loses its backslash but is still
    // handed verbatim to the sanitizer, which neutralizes it.
    expect(parseContentDispositionFileName('attachment; filename="..\\movie.mkv"')).toBe('..movie.mkv')
    expect(parseContentDispositionFileName("attachment; filename*=UTF-8''..%2Fmovie.mkv")).toBe('../movie.mkv')
  })

  it('is case-insensitive for parameter names', () => {
    expect(parseContentDispositionFileName('ATTACHMENT; FILENAME="movie.mkv"')).toBe('movie.mkv')
    expect(parseContentDispositionFileName('attachment; FileName*=UTF-8\'\'Movie.mkv')).toBe('Movie.mkv')
  })

  it('ignores parameters before and after the filename', () => {
    expect(parseContentDispositionFileName('attachment; size=123; filename="a.mkv"; creation-date="0"')).toBe('a.mkv')
  })

  it('handles whitespace around = and ;', () => {
    expect(parseContentDispositionFileName('attachment;  filename  =  "movie.mkv" ; foo=bar')).toBe('movie.mkv')
  })
})

describe('decodeExtValue', () => {
  it('rejects values without the charset/language separator', () => {
    expect(decodeExtValue('movie.mkv').ok).toBe(false)
  })

  it('rejects non-UTF-8 charsets', () => {
    expect(decodeExtValue("ISO-8859-1''photo.jpg").ok).toBe(false)
  })

  it('accepts ext values that are entirely unencoded (RFC 8187 allows unreserved)', () => {
    expect(decodeExtValue("UTF-8''plain.txt").ok).toBe(true)
  })

  it('rejects malformed percent-encoding', () => {
    expect(decodeExtValue("UTF-8''bad%ZZ").ok).toBe(false)
  })

  it('rejects control chars / non-ASCII raw bytes', () => {
    expect(decodeExtValue("UTF-8''bad%01name").ok).toBe(false)
  })

  it('accepts a valid value', () => {
    const decoded = decodeExtValue("UTF-8''Movie%20Name%2Emkv")
    expect(decoded.ok).toBe(true)
    expect(decoded.value).toBe('Movie Name.mkv')
  })
})