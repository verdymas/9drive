import { describe, expect, it } from 'vitest'
import {
  assertSupportedEncryption,
  buildRewrittenPlaylist,
  normalizeSegments,
  type NormalizedSegment,
} from './segments.js'

const manifestUrl = 'https://cdn.example.com/hls/stream.m3u8'

function segment(overrides: Partial<NormalizedSegment> = {}): NormalizedSegment {
  return {
    uri: 'https://cdn.example.com/hls/seg-1.ts',
    duration: 6,
    byterange: null,
    map: null,
    key: null,
    discontinuity: false,
    title: null,
    index: 1,
    isFmp4: false,
    ...overrides,
  }
}

describe('normalizeSegments', () => {
  it('resolves relative URIs against the FINAL manifest URL', () => {
    const parsed = normalizeSegments(
      [{ uri: 'segments/seg-1.ts', duration: 6 }],
      manifestUrl,
    )
    expect(parsed[0].uri).toBe('https://cdn.example.com/hls/segments/seg-1.ts')
  })

  it('resolves a protocol-relative URI', () => {
    const parsed = normalizeSegments([{ uri: '//cdn2.example.com/seg.ts', duration: 6 }], manifestUrl)
    expect(parsed[0].uri).toBe('https://cdn2.example.com/seg.ts')
  })

  it('keeps absolute URIs unchanged', () => {
    const parsed = normalizeSegments([{ uri: 'https://other.example.com/a.ts', duration: 6 }], manifestUrl)
    expect(parsed[0].uri).toBe('https://other.example.com/a.ts')
  })

  it('computes implicit byte-range offsets per spec', () => {
    const parsed = normalizeSegments(
      [
        { uri: 'file.mp4', duration: 6, byterange: { length: 100, offset: 0 } },
        { uri: 'file.mp4', duration: 6, byterange: { length: 100, offset: 100 } },
        // Omitted offset — implicit: previous end.
        { uri: 'file.mp4', duration: 6, byterange: { length: 50 } },
      ],
      manifestUrl,
    )
    expect(parsed[0].byterange).toEqual({ length: 100, offset: 0 })
    expect(parsed[1].byterange).toEqual({ length: 100, offset: 100 })
    expect(parsed[2].byterange).toEqual({ length: 50, offset: 200 })
  })

  it('resolves key and map URIs against the manifest URL', () => {
    const parsed = normalizeSegments(
      [
        {
          uri: 'seg-1.ts',
          duration: 6,
          key: { METHOD: 'AES-128', URI: 'keys/key.bin', IV: '0xabcdef' },
          map: { uri: 'init.mp4' },
        },
      ],
      manifestUrl,
    )
    expect(parsed[0].key?.uri).toBe('https://cdn.example.com/hls/keys/key.bin')
    expect(parsed[0].key?.iv).toBe('0xabcdef')
    expect(parsed[0].map?.uri).toBe('https://cdn.example.com/hls/init.mp4')
    expect(parsed[0].isFmp4).toBe(true)
  })

  it('marks fMP4 when any segment carries a map', () => {
    const parsed = normalizeSegments(
      [
        { uri: 'a.ts', duration: 6 },
        { uri: 'b.ts', duration: 6, map: { uri: 'init.mp4' } },
      ],
      manifestUrl,
    )
    expect(parsed.every((s) => s.isFmp4)).toBe(true)
  })

  it('reads LOWERCASE key attrs exactly as m3u8-parser emits them', () => {
    // m3u8-parser's real output is `{ method, uri, iv, keyformat }` (lowercase),
    // while the ambient shim declares uppercase. A parsed manifest whose key
    // URI is silently dropped would strip the key from the rewritten playlist
    // and hand FFmpeg undecryptable ciphertext (regression from the e2e test).
    const parsed = normalizeSegments(
      [
        {
          uri: 'seg-1.ts',
          duration: 6,
          key: { method: 'AES-128', uri: 'keys/key.bin', iv: '0xabcdef' },
        },
      ],
      manifestUrl,
    )
    expect(parsed[0].key?.uri).toBe('https://cdn.example.com/hls/keys/key.bin')
    expect(parsed[0].key?.method).toBe('AES-128')
    expect(parsed[0].key?.iv).toBe('0xabcdef')
  })
})

describe('assertSupportedEncryption', () => {
  it('allows unencrypted segments', () => {
    expect(() => assertSupportedEncryption([segment()])).not.toThrow()
  })

  it('allows AES-128 keys', () => {
    expect(() =>
      assertSupportedEncryption([segment({ key: { method: 'AES-128', uri: 'https://k/k.bin', iv: null, keyformat: null } })]),
    ).not.toThrow()
  })

  it('rejects SAMPLE-AES', () => {
    expect(() =>
      assertSupportedEncryption([segment({ key: { method: 'SAMPLE-AES', uri: 'https://k/k.bin', iv: null, keyformat: null } })]),
    ).toThrowError(/not supported/)
  })

  it('rejects DRM KEYFORMATs (FairPlay / Widevine / PlayReady)', () => {
    for (const keyformat of ['com.apple.streamingkeydelivery', 'com.widevine.alpha', 'com.microsoft.playready']) {
      expect(() =>
        assertSupportedEncryption([segment({ key: { method: 'AES-128', uri: 'https://k/k.bin', iv: null, keyformat } })]),
      ).toThrowError(/not supported/)
    }
  })
})

describe('buildRewrittenPlaylist', () => {
  it('emits a local-only playlist with relative filenames', () => {
    const segments = [
      segment({ index: 1, duration: 6 }),
      segment({ index: 2, duration: 6.5, uri: 'https://cdn.example.com/hls/seg-2.ts' }),
    ]
    const body = buildRewrittenPlaylist(
      segments,
      (s) => `/tmp/job/video-${String(s.index).padStart(6, '0')}.ts`,
      (uri) => `/tmp/job/key.bin`,
      (uri) => `/tmp/job/init.mp4`,
    )
    const lines = body.split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines).toContain('#EXT-X-TARGETDURATION:7')
    expect(lines).toContain('#EXTINF:6.000,')
    expect(lines).toContain('#EXTINF:6.500,')
    // Local bare filenames, never remote URIs.
    expect(lines.some((l) => l.includes('video-000001.ts'))).toBe(true)
    expect(lines.some((l) => l.includes('video-000002.ts'))).toBe(true)
    expect(lines.some((l) => l.includes('http://'))).toBe(false)
    expect(lines.some((l) => l.includes('https://'))).toBe(false)
    expect(lines[lines.length - 1]).toBe('#EXT-X-ENDLIST')
  })

  it('emits EXT-X-KEY with the IV when the key changes', () => {
    const segments = [
      segment({ index: 1, key: { method: 'AES-128', uri: 'https://k/k1.bin', iv: '0xabc123', keyformat: null } }),
      segment({ index: 2, uri: 'https://cdn.example.com/hls/seg-2.ts', key: { method: 'AES-128', uri: 'https://k/k1.bin', iv: '0xabc123', keyformat: null } }),
    ]
    const body = buildRewrittenPlaylist(
      segments,
      (s) => `/tmp/job/video-${String(s.index).padStart(6, '0')}.ts`,
      (uri) => `/tmp/job/key-000001.bin`,
      () => `/tmp/job/init.mp4`,
    )
    expect(body).toContain('#EXT-X-KEY:METHOD="AES-128",URI="key-000001.bin",IV="0xabc123"')
  })

  it('emits EXT-X-MAP for fMP4 and EXT-X-DISCONTINUITY', () => {
    const segments = [
      segment({
        index: 1,
        map: { uri: 'https://cdn.example.com/hls/init.mp4', byterange: null },
        isFmp4: true,
      }),
      segment({ index: 2, discontinuity: true, uri: 'https://cdn.example.com/hls/seg-2.ts' }),
    ]
    const body = buildRewrittenPlaylist(
      segments,
      (s) => `/tmp/job/video-${String(s.index).padStart(6, '0')}.ts`,
      () => `/tmp/job/key.bin`,
      () => `/tmp/job/video-init-000001.mp4`,
    )
    expect(body).toContain('#EXT-X-MAP:URI="video-init-000001.mp4"')
    expect(body).toContain('#EXT-X-DISCONTINUITY')
  })
})
