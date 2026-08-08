import { describe, expect, it } from 'vitest'
import { normalizeFolderName } from './normalize-folder-name.js'

describe('normalizeFolderName', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeFolderName('  MOV  ')).toBe('mov')
    expect(normalizeFolderName('Movies')).toBe('movies')
    expect(normalizeFolderName('Action/Series')).toBe('action/series')
  })

  it('applies NFC normalization (precomposed output)', () => {
    // "e" + combining acute accent → "é"
    expect(normalizeFolderName('café')).toBe('café')
    expect(normalizeFolderName('café')).toBe('café')
    expect(normalizeFolderName('café')).toBe(normalizeFolderName('café'))
  })

  it('preserves internal spaces and dots', () => {
    expect(normalizeFolderName('My Movies 2026')).toBe('my movies 2026')
    expect(normalizeFolderName('Series.Name')).toBe('series.name')
  })

  it('handles empty and whitespace-only names', () => {
    expect(normalizeFolderName('')).toBe('')
    expect(normalizeFolderName('   ')).toBe('')
  })
})