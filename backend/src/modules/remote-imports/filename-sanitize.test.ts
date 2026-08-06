import { describe, expect, it } from 'vitest'
import { sanitizeFileName } from './filename-sanitize.js'

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