import { describe, expect, it } from 'vitest'
import {
  buildLogicalPath,
  encodeCaption,
  looksLikeNineDriveCaption,
  NINE_DRIVE_ID_KEY,
  NINE_DRIVE_META_KEY,
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

  it('rejects path-traversal captions and flags them malformed', () => {
    const caption = `${NINE_DRIVE_PATH_KEY}=../../outside/file.mkv`
    const parsed = parseCaption(caption)
    expect(parsed.logicalPath).toBeNull()
    expect(parsed.diagnostics.pathSeen).toBe(1)
    expect(parsed.diagnostics.pathReason).toBe('malformed')
    // Same for a mid-path `..` — never invent a resolved path.
    expect(parseCaption(`${NINE_DRIVE_PATH_KEY}=A/../B.md`).logicalPath).toBeNull()
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
    expect(parsed.diagnostics.metaKept).toBe(false)
  })

  it('parses an encrypted 9drive:meta line alongside the stable id', () => {
    const caption = `${NINE_DRIVE_ID_KEY}=abc-123\n${NINE_DRIVE_META_KEY}=v1:aaa:bbb:ccc`
    const parsed = parseCaption(caption)
    expect(parsed.stableId).toBe('abc-123')
    expect(parsed.encryptedMeta).toBe('v1:aaa:bbb:ccc')
    expect(parsed.logicalPath).toBeNull()
    expect(parsed.hasAny).toBe(true)
    expect(parsed.diagnostics.metaKept).toBe(true)
    expect(parsed.diagnostics.metaReason).toBeUndefined()
    expect(parsed.extraLines).toEqual([])
  })

  it('keeps 9drive:meta out of extraLines and drops empty meta values', () => {
    const parsed = parseCaption(`${NINE_DRIVE_META_KEY}=v1:xyz\nnote`)
    expect(parsed.encryptedMeta).toBe('v1:xyz')
    expect(parsed.extraLines).toEqual(['note'])
    const empty = parseCaption(`${NINE_DRIVE_META_KEY}=`)
    expect(empty.encryptedMeta).toBeNull()
    expect(empty.diagnostics.metaSeen).toBe(1)
    expect(empty.diagnostics.metaReason).toBe('malformed')
  })

  it('first meta wins, later duplicates are flagged', () => {
    const parsed = parseCaption(`${NINE_DRIVE_META_KEY}=v1:first\n${NINE_DRIVE_META_KEY}=v1:second`)
    expect(parsed.encryptedMeta).toBe('v1:first')
    expect(parsed.diagnostics.metaSeen).toBe(2)
    expect(parsed.diagnostics.metaKept).toBe(true)
    expect(parsed.diagnostics.metaReason).toBe('duplicate')
  })

  it('combines encrypted meta with a legacy plaintext path (transitional captions)', () => {
    const parsed = parseCaption(`${NINE_DRIVE_ID_KEY}=abc\n${NINE_DRIVE_META_KEY}=v1:payload\n${NINE_DRIVE_PATH_KEY}=Movies/a.mkv`)
    expect(parsed.stableId).toBe('abc')
    expect(parsed.encryptedMeta).toBe('v1:payload')
    expect(parsed.logicalPath).toBe('Movies/a.mkv')
  })

  it('treats 9drive:meta captions as 9Drive captions', () => {
    expect(looksLikeNineDriveCaption(`${NINE_DRIVE_META_KEY}=v1:x`)).toBe(true)
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

  it('omits the path line for path-traversal inputs, keeping only the id', () => {
    const caption = encodeCaption({ stableId: 'abc', logicalPath: '../B.md' })
    expect(caption).not.toBeNull()
    // The valid 9drive:id survives; the unsafe path is not encoded.
    expect(caption!.startsWith('9drive:id=abc')).toBe(true)
    expect(caption!.includes('9drive:path=')).toBe(false)
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

  it('emits an encrypted meta line that the parser reads back', () => {
    const caption = encodeCaption({ stableId: 'abc', encryptedMeta: 'v1:aaa:bbb:ccc' })
    expect(caption).not.toBeNull()
    const parsed = parseCaption(caption!)
    expect(parsed.stableId).toBe('abc')
    expect(parsed.encryptedMeta).toBe('v1:aaa:bbb:ccc')
    expect(parsed.logicalPath).toBeNull()
  })

  it('omits the plaintext path when the encrypted meta line is emitted (no leak)', () => {
    // The path lives inside the AES-256-GCM payload — emitting it in cleartext
    // beside the ciphertext would defeat the encryption. The encoder must
    // choose one representation and stay silent on the other.
    const caption = encodeCaption({ stableId: 'abc', encryptedMeta: 'v1:xyz', logicalPath: 'A/B.md' })
    expect(caption).not.toBeNull()
    expect(caption!.includes(`${NINE_DRIVE_PATH_KEY}=`)).toBe(false)
    expect(caption!.includes(`${NINE_DRIVE_META_KEY}=v1:xyz`)).toBe(true)
    // The plaintext path segment must not leak into the caption, including
    // through any other line — the filename is the only thing that survives.
    expect(caption!.includes('A/B.md')).toBe(false)
  })

  it('keeps the plaintext path when the meta line is dropped (empty / oversized)', () => {
    // If the ciphertext is unusable, the path is the only recovery hint —
    // the encoder must fall back to the legacy line in that case.
    const empty = encodeCaption({ stableId: 'abc', encryptedMeta: '', logicalPath: 'A/B.md' })
    expect(empty).not.toBeNull()
    expect(empty!.includes(`${NINE_DRIVE_META_KEY}=`)).toBe(false)
    expect(empty!.includes(`${NINE_DRIVE_PATH_KEY}=A/B.md`)).toBe(true)

    const filler = 'x'.repeat(TELEGRAM_CAPTION_MAX)
    const oversized = encodeCaption({ stableId: 'abc', encryptedMeta: `v1:${filler}`, logicalPath: 'A/B.md' })
    expect(oversized).not.toBeNull()
    expect(oversized!.includes(`${NINE_DRIVE_META_KEY}=`)).toBe(false)
    expect(oversized!.includes(`${NINE_DRIVE_PATH_KEY}=A/B.md`)).toBe(true)
  })

  it('drops an empty / oversized meta value while keeping the id', () => {
    const empty = encodeCaption({ stableId: 'abc', encryptedMeta: '' })
    expect(empty).not.toBeNull()
    expect(empty!.startsWith('9drive:id=abc')).toBe(true)
    expect(empty!.includes(`${NINE_DRIVE_META_KEY}=`)).toBe(false)

    const filler = 'x'.repeat(TELEGRAM_CAPTION_MAX)
    const oversized = encodeCaption({ stableId: 'abc', encryptedMeta: `v1:${filler}` })
    expect(oversized).not.toBeNull()
    expect(oversized!.startsWith('9drive:id=abc')).toBe(true)
    expect(oversized!.includes(`${NINE_DRIVE_META_KEY}=`)).toBe(false)
  })

  it('drops 9drive:meta slipped in via extras (parser would treat as duplicate)', () => {
    const caption = encodeCaption({ stableId: 'abc', extras: [`${NINE_DRIVE_META_KEY}=v1:oops`] })
    expect(caption).not.toBeNull()
    // The duplicate-key extra is dropped by isNineDriveLine, so the encoded
    // caption carries no meta line at all — the parser sees zero.
    const parsed = parseCaption(caption!)
    expect(parsed.diagnostics.metaSeen).toBe(0)
    expect(parsed.encryptedMeta).toBeNull()
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

  it('rejects path traversal and dot segments', () => {
    expect(normalizeLogicalPath('../../outside/file.mkv')).toBeNull()
    expect(normalizeLogicalPath('A/../B.md')).toBeNull()
    expect(normalizeLogicalPath('A/./B.md')).toBeNull()
    expect(normalizeLogicalPath('../file.mkv')).toBeNull()
    expect(normalizeLogicalPath('A/.')).toBeNull()
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
    expect(buildLogicalPath(['A', '..', 'B.md'])).toBeNull()
    expect(buildLogicalPath(['A', '.', 'B.md'])).toBeNull()
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