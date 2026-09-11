import { describe, expect, it } from 'vitest'
import { detectFileName, resolveCapturedFileName } from './filename-detection.js'

describe('resolveCapturedFileName', () => {
  it('prefers a semantic capture title over an opaque suggested URL name', () => {
    expect(resolveCapturedFileName({
      suggestedFileName: '55234234e.vid',
      mediaIdentityTitle: 'video bagus',
      mimeType: 'video/mp4',
    })).toBe('video bagus.mp4')
  })

  it('keeps a meaningful suggested URL filename', () => {
    expect(resolveCapturedFileName({
      suggestedFileName: 'video-bagus.mp4',
      mimeType: 'video/mp4',
    })).toBe('video-bagus.mp4')
  })

  it('keeps a meaningful URL suggestion ahead of a generic page title', () => {
    expect(resolveCapturedFileName({
      suggestedFileName: 'video-bagus.mp4',
      pageTitle: 'Watch Video - Example',
      mimeType: 'video/mp4',
    })).toBe('video-bagus.mp4')
  })

  it('prefers a probed Content-Disposition name over capture metadata', () => {
    expect(resolveCapturedFileName({
      suggestedFileName: '55234234e.vid',
      mediaIdentityTitle: 'video bagus',
      probed: { fileName: 'Server Name.mp4', fileNameSource: 'content-disposition-filename' },
      mimeType: 'video/mp4',
    })).toBe('Server Name.mp4')
  })

  it('uses the probed MIME when the capture did not retain Content-Type', () => {
    expect(resolveCapturedFileName({
      suggestedFileName: '55234234e.vid',
      probed: { fileName: 'Video Bagus', fileNameSource: 'final-url-path', mimeType: 'video/mp4' },
    })).toBe('Video Bagus.mp4')
  })

  it('prefers a meaningful probed URL name over a page title', () => {
    expect(resolveCapturedFileName({
      suggestedFileName: '55234234e.vid',
      pageTitle: 'Watch Video - Example',
      probed: { fileName: 'video-bagus.mp4', fileNameSource: 'final-url-path', mimeType: 'video/mp4' },
    })).toBe('video-bagus.mp4')
  })
})

describe('detectFileName', () => {
  it('normalizes a generic URL transport extension from the response MIME', () => {
    const result = detectFileName({
      contentDisposition: null,
      originalUrl: new URL('https://cdn.example.com/55234234e.vid'),
      finalUrl: new URL('https://cdn.example.com/55234234e.vid'),
      fallbackShortId: 'abc123',
      mimeType: 'video/mp4',
    })
    expect(result.fileName).toBe('55234234e.mp4')
    expect(result.fileNameSource).toBe('final-url-path')
  })

  it('normalizes a generic Content-Disposition extension from the response MIME', () => {
    const result = detectFileName({
      contentDisposition: 'attachment; filename="abc123.bin"',
      originalUrl: new URL('https://cdn.example.com/download'),
      finalUrl: new URL('https://cdn.example.com/download'),
      fallbackShortId: 'abc123',
      mimeType: 'video/x-matroska',
    })
    expect(result.fileName).toBe('abc123.mkv')
    expect(result.fileNameSource).toBe('content-disposition-filename')
  })

  it('uses a known MIME before an optional generic fallback extension', () => {
    const result = detectFileName({
      contentDisposition: null,
      originalUrl: new URL('https://cdn.example.com/'),
      finalUrl: new URL('https://cdn.example.com/'),
      fallbackShortId: 'abc123',
      extension: 'bin',
      mimeType: 'video/mp4',
    })
    expect(result.fileName).toBe('remote-file-abc123.mp4')
  })
})
