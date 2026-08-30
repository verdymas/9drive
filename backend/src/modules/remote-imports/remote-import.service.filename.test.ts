import { describe, expect, it } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import { hlsFinalFileName } from './remote-import.service.js'

/**
 * The final stored filename for an HLS import must equal what the user entered
 * (§4 "canonical name"), with exactly two transformations allowed:
 *   - a `.m3u8`/`.m3u` playlist suffix is replaced by the output container's
 *     extension (the user never sees a playlist ext on a remuxed file),
 *   - a name with NO explicit extension gets the container's extension.
 * Anything else stays byte-for-byte identical — in particular, an explicit
 * extension that already matches is kept as-is (never double-appended), and an
 * explicit extension that contradicts the selected container is SILENTLY
 * REPLACED (the extension's FilenameResolver always suggests `.mkv`, the
 * default, and cannot know a backend configured for MP4).
 */
describe('hlsFinalFileName', () => {
  it('keeps an explicit matching extension unchanged (mp4)', () => {
    expect(hlsFinalFileName('My Movie.mp4', 'mp4')).toBe('My Movie.mp4')
  })

  it('keeps an explicit matching extension unchanged (mkv)', () => {
    expect(hlsFinalFileName('My Movie.mkv', 'mkv')).toBe('My Movie.mkv')
  })

  it('keeps an explicit matching extension case-insensitively (MKV → mkv)', () => {
    expect(hlsFinalFileName('My Movie.MKV', 'mkv')).toBe('My Movie.MKV')
  })

  it('silently replaces an extension contradicting the container (mp4 → mkv)', () => {
    expect(hlsFinalFileName('My Movie.mp4', 'mkv')).toBe('My Movie.mkv')
  })

  it('silently replaces an extension contradicting the container (mkv → mp4)', () => {
    expect(hlsFinalFileName('My Movie.mkv', 'mp4')).toBe('My Movie.mp4')
  })

  it('appends the output extension to a name with no extension', () => {
    expect(hlsFinalFileName('My Movie', 'mp4')).toBe('My Movie.mp4')
    expect(hlsFinalFileName('My Movie', 'mkv')).toBe('My Movie.mkv')
    expect(hlsFinalFileName('My Movie', undefined)).toBe('My Movie.mkv') // auto → mkv
  })

  it('replaces a .m3u8 suffix with the output extension', () => {
    expect(hlsFinalFileName('My Movie.m3u8', 'mp4')).toBe('My Movie.mp4')
    expect(hlsFinalFileName('My Movie.M3U8', 'mkv')).toBe('My Movie.mkv')
  })

  it('replaces a .m3u suffix with the output extension', () => {
    expect(hlsFinalFileName('My Movie.m3u', 'mkv')).toBe('My Movie.mkv')
  })

  it('strips trailing dots before appending', () => {
    expect(hlsFinalFileName('My Movie...', 'mkv')).toBe('My Movie.mkv')
  })

  it('treats any terminal extension segment as the extension (mismatch swaps it)', () => {
    // "archive.tar" — `.tar` is the extension; vs mkv that contradicts.
    expect(hlsFinalFileName('archive.tar', 'mkv')).toBe('archive.mkv')
    // A name whose last segment already matches is kept — intermediate dots
    // are part of the basename, never the extension.
    expect(hlsFinalFileName('My.Movie.mkv', 'mkv')).toBe('My.Movie.mkv')
  })
})