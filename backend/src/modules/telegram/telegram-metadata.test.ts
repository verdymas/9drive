import { describe, expect, it } from 'vitest'
import {
  buildLogicalPath,
  encodeCaption,
  looksLikeNineDriveCaption,
  NINE_DRIVE_ID_KEY,
  NINE_DRIVE_PATH_KEY,
  normalizeLogicalPath,
  parseCaption,
  splitLogicalPath,
  TELEGRAM_CAPTION_MAX,
} from './telegram-metadata.js'

describe('telegram-metadata — parser', () => {
  it('round-trips an id + path caption', () => {
    const caption = `${NINE_DRIVE_ID_KEY}=abc-123\n${NINE_DRIVE_PATH_KEY}=Projects/APP-V/docs/architecture.md`
    const parsed = parseCaption(caption)
    expect(parsed.stableId).toBe('abc-123')
    expect(parsed.logicalPath).toBe('Projects/APP-V/docs/architecture.md')
    expect(parsed.hasAny).toBe(true)
    expect(parsed.extraLines).toEqual([])
    expect(parsed.diagnostics.idKept).toBe(true)
    expect(parsed.diagnostics.pathKept).toBe(true)
  })

  it('handles CRLF line endings', () => {
    const caption = `${NINE_DRIVE_ID_KEY}=abc\r\n${NINE_DRIVE_PATH_KEY}=A/B.md`
    const parsed = parseCaption(caption)
    expect(parsed.stableId).toBe('abc')
    expect(parsed.logicalPath).toBe('A/B.md')
  })

  it('preserves extra lines in order', () => {
    const caption = [
      'human-readable note',
      `${NINE_DRIVE_ID_KEY}=file-1`,
      'second note',
      `${NINE_DRIVE_PATH_KEY}=Somewhere/file.txt`,
      'tail',
    ].join('\n')
    const parsed = parseCaption(caption)
    expect(parsed.stableId).toBe('file-1')
    expect(parsed.logicalPath).toBe('Somewhere/file.txt')
    expect(parsed.extraLines).toEqual(['human-readable note', 'second note', 'tail'])
  })

  it('first id wins, later duplicates are flagged', () => {
    const caption = `${NINE_DRIVE_ID_KEY}=first\n${NINE_DRIVE_ID_KEY}=second`
    const parsed = parseCaption(caption)
    expect(parsed.stableId).toBe('first')
    expect(parsed.diagnostics.idSeen).toBe(2)
    expect(parsed.diagnostics.idKept).toBe(true)
    expect(parsed.diagnostics.idReason).toBe('duplicate')
  })

  it('first path wins, later duplicates are flagged', () => {
    const caption = `${NINE_DRIVE_PATH_KEY}=A/B.md\n${NINE_DRIVE_PATH_KEY}=C/D.md`
    const parsed = parseCaption(caption)
    expect(parsed.logicalPath).toBe('A/B.md')
    expect(parsed.diagnostics.pathSeen).toBe(2)
    expect(parsed.diagnostics.pathKept).toBe(true)
    expect(parsed.diagnostics.pathReason).toBe('duplicate')
  })

  it('drops malformed stable ids without throwing', () => {
    const caption = `${NINE_DRIVE_ID_KEY}=has spaces\n${NINE_DRIVE_PATH_KEY}=A/B.md`
    const parsed = parseCaption(caption)
    expect(parsed.stableId).toBeNull()
    expect(parsed.logicalPath).toBe('A/B.md')
    expect(parsed.diagnostics.idReason).toBe('malformed')
  })

  it('drops malformed paths (forbidden characters, empty segments)', () => {
    const cases = [
      `${NINE_DRIVE_PATH_KEY}=A/B:C.md`, // colon forbidden
      `${NINE_DRIVE_PATH_KEY}=A//B.md`, // empty segment
      `${NINE_DRIVE_PATH_KEY}=`, // empty
    ]
    for (const caption of cases) {
      const parsed = parseCaption(caption)
      expect(parsed.logicalPath).toBeNull()
    }
  })

  it('parses the path up to the first newline and treats the rest as extras', () => {
    // The encoder never produces a caption with an embedded newline in a
    // segment; the parser splits on LF first, so a forged caption with
    // `A/B\nC.md` becomes `9drive:path=A/B` + extras `C.md`. This is the
    // safe behaviour — never throw, never invent a path.
    const parsed = parseCaption(`${NINE_DRIVE_PATH_KEY}=A/B\nC.md`)
    expect(parsed.logicalPath).toBe('A/B')
    expect(parsed.extraLines).toEqual(['C.md'])
  })

  it('normalizes NFC paths', () => {
    // "café" with combining acute (NFD) should normalize to NFC.
    const decomposed = 'café'
    const caption = `${NINE_DRIVE_PATH_KEY}=${decomposed}/file.md`
    const parsed = parseCaption(caption)
    expect(parsed.logicalPath).toBe('café/file.md')
  })

  it('returns null path for empty / null caption', () => {
    expect(parseCaption(null).logicalPath).toBeNull()
    expect(parseCaption(undefined).logicalPath).toBeNull()
    expect(parseCaption('').logicalPath).toBeNull()
  })

  it('ignores unknown keys without flagging diagnostics', () => {
    const parsed = parseCaption('some:other=value')
    expect(parsed.hasAny).toBe(false)
    expect(parsed.diagnostics.idKept).toBe(false)
    expect(parsed.diagnostics.pathKept).toBe(false)
  })
})

describe('telegram-metadata — encoder', () => {
  it('emits a deterministic, parser-compatible caption', () => {
    const caption = encodeCaption({ stableId: 'abc-123', logicalPath: 'Projects/APP-V/docs/architecture.md' })
    expect(caption).not.toBeNull()
    const parsed = parseCaption(caption!)
    expect(parsed.stableId).toBe('abc-123')
    expect(parsed.logicalPath).toBe('Projects/APP-V/docs/architecture.md')
  })

  it('omits the path line when the path would be malformed', () => {
    const caption = encodeCaption({ stableId: 'abc', logicalPath: 'A/B:C.md' })
    expect(caption).not.toBeNull()
    const parsed = parseCaption(caption!)
    expect(parsed.stableId).toBe('abc')
    expect(parsed.logicalPath).toBeNull()
  })

  it('returns null when the stable id is malformed', () => {
    expect(encodeCaption({ stableId: 'has spaces', logicalPath: 'A/B.md' })).toBeNull()
  })

  it('preserves extra lines in the encoded caption', () => {
    const caption = encodeCaption({ stableId: 'abc', logicalPath: 'A/B.md', extras: ['human note', 'second'] })
    expect(caption).not.toBeNull()
    const parsed = parseCaption(caption!)
    expect(parsed.stableId).toBe('abc')
    expect(parsed.logicalPath).toBe('A/B.md')
    expect(parsed.extraLines).toEqual(['human note', 'second'])
  })

  it('drops extras that would push the caption over the limit', () => {
    const filler = 'x'.repeat(TELEGRAM_CAPTION_MAX)
    const caption = encodeCaption({ stableId: 'abc', logicalPath: 'A/B.md', extras: [filler] })
    // The caption-without-extras still fits, so the encoder keeps the
    // canonical 9drive lines and silently drops the oversized ones.
    expect(caption).not.toBeNull()
    expect(caption!.startsWith('9drive:id=abc')).toBe(true)
    expect(caption!.includes('9drive:path=A/B.md')).toBe(true)
    // Filler must NOT appear in the final caption.
    expect(caption!.includes('xxx')).toBe(false)
  })

  it('drops 9drive lines slipped in via extras (parser would treat as duplicates)', () => {
    const caption = encodeCaption({ stableId: 'abc', logicalPath: 'A/B.md', extras: [`${NINE_DRIVE_PATH_KEY}=oops.md`] })
    expect(caption).not.toBeNull()
    // The duplicate-key extra is dropped, so the encoded caption only
    // contains the canonical path. The parser sees exactly one path line.
    const parsed = parseCaption(caption!)
    expect(parsed.diagnostics.pathSeen).toBe(1)
    expect(parsed.diagnostics.pathReason).toBeUndefined()
  })
})

describe('telegram-metadata — normalizeLogicalPath', () => {
  it('strips leading/trailing slashes', () => {
    expect(normalizeLogicalPath('/A/B/')).toBe('A/B')
    expect(normalizeLogicalPath('A/B')).toBe('A/B')
  })

  it('returns null for empty / null / blank input', () => {
    expect(normalizeLogicalPath('')).toBeNull()
    expect(normalizeLogicalPath('   ')).toBeNull()
    expect(normalizeLogicalPath(null)).toBeNull()
    expect(normalizeLogicalPath(undefined)).toBeNull()
  })

  it('returns null when any segment is too long or contains forbidden chars', () => {
    expect(normalizeLogicalPath('A/' + 'x'.repeat(256))).toBeNull()
    expect(normalizeLogicalPath('A/B:C')).toBeNull()
    expect(normalizeLogicalPath('A//B')).toBeNull()
  })

  it('NFC-normalizes segments', () => {
    expect(normalizeLogicalPath('café/file.md')).toBe('café/file.md')
  })
})

describe('telegram-metadata — buildLogicalPath / splitLogicalPath', () => {
  it('buildLogicalPath joins with "/" and rejects bad segments', () => {
    expect(buildLogicalPath(['Projects', 'APP-V', 'docs', 'architecture.md'])).toBe('Projects/APP-V/docs/architecture.md')
    expect(buildLogicalPath([])).toBeNull()
    expect(buildLogicalPath(['A', 'B:C'])).toBeNull()
  })

  it('splitLogicalPath is the inverse of buildLogicalPath for valid inputs', () => {
    const segments = ['Projects', 'APP-V', 'docs', 'architecture.md']
    expect(splitLogicalPath(buildLogicalPath(segments)!)).toEqual(segments)
    expect(splitLogicalPath(null)).toEqual([])
    expect(splitLogicalPath('')).toEqual([])
  })
})

describe('telegram-metadata — looksLikeNineDriveCaption', () => {
  it('detects either key in the caption', () => {
    expect(looksLikeNineDriveCaption(`prefix\n${NINE_DRIVE_ID_KEY}=abc`)).toBe(true)
    expect(looksLikeNineDriveCaption(`prefix\n${NINE_DRIVE_PATH_KEY}=A/B.md`)).toBe(true)
  })
  it('returns false for unrelated text', () => {
    expect(looksLikeNineDriveCaption('hello world')).toBe(false)
    expect(looksLikeNineDriveCaption(null)).toBe(false)
    expect(looksLikeNineDriveCaption('')).toBe(false)
  })
})