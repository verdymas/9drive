import { describe, expect, it } from 'vitest'
import { appendExtensionFromMime, extensionFromMime, nameHasExtension, sanitizeFileName } from './filename-sanitize.js'

describe('sanitizeFileName', () => {
  it('passes through a clean name', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf')
    expect(sanitizeFileName('My Photo (1).jpg')).toBe('My Photo (1).jpg')
  })

  it('strips path separators', () => {
    expect(sanitizeFileName('../../etc/passwd')).not.toMatch(/[\\/]/)
    expect(sanitizeFileName('..\\..\\win.ini')).not.toMatch(/[\\/]/)
  })

  it('removes control characters', () => {
    expect(sanitizeFileName('bad\x00\x1bname\x7f.txt')).toBe('badname.txt')
  })

  it('removes illegal filename characters', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h')).toBe('abcdefgh')
  })

  it('truncates over-long names but keeps the fallback path safe', () => {
    const long = 'x'.repeat(500)
    const out = sanitizeFileName(long + '.pdf')
    expect(out.length).toBeLessThanOrEqual(255)
    expect(out.length).toBeGreaterThan(0)
    // The extension survives truncation.
    expect(out.endsWith('.pdf')).toBe(true)
  })

  it('falls back for empty or dotted input', () => {
    expect(sanitizeFileName('')).toBe('file')
    expect(sanitizeFileName('   ')).toBe('file')
    expect(sanitizeFileName('.')).toBe('file')
    expect(sanitizeFileName('..')).toBe('file')
  })

  it('falls back for reserved Windows device names', () => {
    expect(sanitizeFileName('CON')).toBe('file')
    expect(sanitizeFileName('PRN')).toBe('file')
    expect(sanitizeFileName('AUX')).toBe('file')
    expect(sanitizeFileName('NUL')).toBe('file')
    expect(sanitizeFileName('COM1')).toBe('file')
  })

  it('neutralizes reserved device names but keeps a safe extension', () => {
    expect(sanitizeFileName('con.txt')).toBe('file.txt')
    expect(sanitizeFileName('LPT9.docx')).toBe('file.docx')
  })

  it('trims trailing dots and spaces', () => {
    expect(sanitizeFileName('file.')).toBe('file')
    expect(sanitizeFileName('file ')).toBe('file')
    expect(sanitizeFileName('file..')).toBe('file')
  })

  it('never yields a name that could traverse directories', () => {
    const nasty = ['../secret', '..\\secret', '/etc/passwd', 'a\\..\\b']
    for (const input of nasty) {
      const out = sanitizeFileName(input)
      expect(out).not.toContain('/')
      expect(out).not.toContain('\\')
      expect(out).not.toBe('..')
    }
  })
})

describe('nameHasExtension', () => {
  it('detects a terminal extension', () => {
    expect(nameHasExtension('movie.mp4')).toBe(true)
    expect(nameHasExtension('archive.tar.gz')).toBe(true)
    expect(nameHasExtension('ubuntu-24.04.iso')).toBe(true)
    expect(nameHasExtension('My.Movie.mkv')).toBe(true)
  })

  it('rejects extensionless names', () => {
    expect(nameHasExtension('movie')).toBe(false)
    expect(nameHasExtension('abc123')).toBe(false)
    expect(nameHasExtension('remote-file-ab12cd')).toBe(false)
    expect(nameHasExtension('')).toBe(false)
  })
})

describe('extensionFromMime / appendExtensionFromMime', () => {
  it('maps known content types (normalized, parameters stripped)', () => {
    expect(extensionFromMime('video/mp4')).toBe('mp4')
    expect(extensionFromMime('video/x-matroska')).toBe('mkv')
    expect(extensionFromMime('image/jpeg')).toBe('jpg')
    expect(extensionFromMime('application/pdf')).toBe('pdf')
    expect(extensionFromMime('Video/MP4; charset=binary')).toBe('mp4')
    expect(extensionFromMime('AUDIO/MPEG')).toBe('mp3')
  })

  it('returns null for unknown or HLS types (never a guessed extension)', () => {
    expect(extensionFromMime('application/octet-stream')).toBeNull()
    expect(extensionFromMime('application/vnd.apple.mpegurl')).toBeNull()
    expect(extensionFromMime('audio/x-mpegurl')).toBeNull()
    expect(extensionFromMime(null)).toBeNull()
    expect(extensionFromMime('')).toBeNull()
  })

  it('appends a known extension to an extensionless name', () => {
    expect(appendExtensionFromMime('abc123', 'video/mp4')).toBe('abc123.mp4')
    expect(appendExtensionFromMime('screenshot', 'image/png')).toBe('screenshot.png')
    expect(appendExtensionFromMime('remote-file-ab12cd', 'image/png')).toBe('remote-file-ab12cd.png')
  })

  it('never overwrites an explicit extension and never guesses', () => {
    expect(appendExtensionFromMime('movie.mkv', 'video/mp4')).toBe('movie.mkv')
    expect(appendExtensionFromMime('movie.mp4', 'video/mp4')).toBe('movie.mp4')
    expect(appendExtensionFromMime('clip', 'application/octet-stream')).toBe('clip')
    expect(appendExtensionFromMime('clip', null)).toBe('clip')
  })
})