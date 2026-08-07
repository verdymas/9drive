import { describe, expect, it } from 'vitest'
import { resolveContainer, recommendContainer, containerExtension, hlsDerivedFileName, fileNameHasExtension } from './output.js'

describe('resolveContainer', () => {
  it('honors explicit mkv/mp4', () => {
    expect(resolveContainer('mkv', { hasSeparateAudio: true, hasSubtitles: true, hasDiscontinuities: true })).toBe('mkv')
    expect(resolveContainer('mp4', { hasSeparateAudio: true, hasSubtitles: true, hasDiscontinuities: true })).toBe('mp4')
  })

  it('routes EVERYTHING to MKV under auto (§3 — MKV is the default)', () => {
    expect(resolveContainer('auto', { hasSeparateAudio: false, hasSubtitles: false, hasDiscontinuities: false })).toBe('mkv')
    expect(resolveContainer('auto', { hasSeparateAudio: true, hasSubtitles: false, hasDiscontinuities: false })).toBe('mkv')
    expect(resolveContainer('auto', { hasSeparateAudio: false, hasSubtitles: true, hasDiscontinuities: false })).toBe('mkv')
    expect(resolveContainer('auto', { hasSeparateAudio: false, hasSubtitles: false, hasDiscontinuities: true })).toBe('mkv')
  })
})

describe('hlsDerivedFileName', () => {
  it('replaces a .m3u8 suffix with the output extension', () => {
    expect(hlsDerivedFileName('movie.m3u8', 'mkv')).toBe('movie.mkv')
    expect(hlsDerivedFileName('movie.M3U8', 'mp4')).toBe('movie.mp4')
  })

  it('replaces a .m3u suffix too', () => {
    expect(hlsDerivedFileName('stream.m3u', 'mkv')).toBe('stream.mkv')
  })

  it('appends when there is no playlist suffix', () => {
    expect(hlsDerivedFileName('movie', 'mp4')).toBe('movie.mp4')
  })

  it('avoids a double extension', () => {
    expect(hlsDerivedFileName('movie.mkv', 'mkv')).toBe('movie.mkv')
  })

  it('falls back to video when the name collapses', () => {
    expect(hlsDerivedFileName('.m3u8', 'mkv')).toBe('video.mkv')
  })
})

describe('fileNameHasExtension', () => {
  it('matches case-insensitively', () => {
    expect(fileNameHasExtension('Movie.MKV', 'mkv')).toBe(true)
    expect(fileNameHasExtension('Movie.mkv', 'mkv')).toBe(true)
    expect(fileNameHasExtension('Movie.mp4', 'mkv')).toBe(false)
  })
})

describe('containerExtension', () => {
  it('returns the container as the extension', () => {
    expect(containerExtension('mkv')).toBe('mkv')
    expect(containerExtension('mp4')).toBe('mp4')
  })
})