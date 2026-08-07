import { describe, expect, it } from 'vitest'
import { parse as hlsParse, stringify as hlsStringify } from 'hls-parser'
import { rewriteMediaPlaylist, validateLocalPlaylist } from './manifest-service.js'
import type { NormalizedSegment } from './segments.js'

/**
 * hls-parser round-trip tests (§24 of the refactor spec):
 *
 *   parse(original) → mutate remote URIs to local URIs → stringify()
 *     → parse(generated)
 *
 * Every HLS semantic the spec calls out must survive: master/media detection,
 * variants, audio renditions, durations, discontinuities, maps, byte ranges,
 * keys, media sequence, endlist.
 */

const MANIFEST_URL = 'https://cdn.example.com/hls/stream.m3u8'

function seg(uri: string, overrides: Partial<NormalizedSegment> = {}): NormalizedSegment {
  return {
    uri,
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

const localFor = (s: NormalizedSegment) => `/tmp/job/video-${String(s.index).padStart(6, '0')}.ts`
const keyLocalFor = (uri: string) => `/tmp/job/key-000001.bin`
const mapLocalFor = (uri: string) => `/tmp/job/video-init-000001.mp4`

describe('rewriteMediaPlaylist round-trip', () => {
  it('preserves master/media detection, variants, audio renditions', () => {
    // Round-trip a MASTER playlist — the rewrite must not touch it, and
    // parse(generated) must still see a master with variants + renditions.
    const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2",AUDIO="audio"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
mid/index.m3u8`
    const reparsed = hlsParse(master) as import('hls-parser').types.MasterPlaylist
    expect(reparsed.isMasterPlaylist).toBe(true)
    expect(reparsed.variants).toHaveLength(2)
    expect(reparsed.variants[0]?.audio).toHaveLength(1)
    expect(reparsed.variants[0]?.audio[0]?.uri).toBe('audio/en.m3u8')
    const out = hlsStringify(reparsed)
    const reparsed2 = hlsParse(out) as import('hls-parser').types.MasterPlaylist
    expect(reparsed2.isMasterPlaylist).toBe(true)
    expect(reparsed2.variants).toHaveLength(2)
    expect(reparsed2.variants[0]?.audio[0]?.uri).toBe('audio/en.m3u8')
  })

  it('rewrites segment/map/key URIs to local filenames, preserving durations', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="keys/k.bin",IV=0xABCDEF0123456789ABCDEF0123456789
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-1.ts
#EXTINF:4.500,
seg-2.ts
#EXT-X-ENDLIST`
    const segments = [
      seg('https://cdn.example.com/hls/seg-1.ts', { index: 1, duration: 6, map: { uri: 'https://cdn.example.com/hls/init.mp4', byterange: null }, key: { method: 'AES-128', uri: 'https://cdn.example.com/hls/keys/k.bin', iv: '0xABCDEF0123456789ABCDEF0123456789', keyformat: null } }),
      seg('https://cdn.example.com/hls/seg-2.ts', { index: 2, duration: 4.5, map: { uri: 'https://cdn.example.com/hls/init.mp4', byterange: null }, key: { method: 'AES-128', uri: 'https://cdn.example.com/hls/keys/k.bin', iv: '0xABCDEF0123456789ABCDEF0123456789', keyformat: null } }),
    ]
    const out = rewriteMediaPlaylist(body, segments, localFor, keyLocalFor, mapLocalFor)
    expect(out).toContain('video-000001.ts')
    expect(out).toContain('video-000002.ts')
    expect(out).toContain('key-000001.bin')
    expect(out).toContain('video-init-000001.mp4')
    expect(out).not.toMatch(/https?:\/\//)
    expect(out).toContain('IV=0xABCDEF0123456789ABCDEF0123456789')
    // Re-parse the generated playlist — durations must survive.
    const reparsed = hlsParse(out) as import('hls-parser').types.MediaPlaylist
    expect(reparsed.isMasterPlaylist).toBe(false)
    expect(reparsed.segments[0]?.duration).toBe(6)
    expect(reparsed.segments[1]?.duration).toBe(4.5)
    expect(reparsed.segments[0]?.uri).toBe('video-000001.ts')
    expect(reparsed.segments[0]?.key?.uri).toBe('key-000001.bin')
    expect(reparsed.segments[0]?.map?.uri).toBe('video-init-000001.mp4')
  })

  it('preserves discontinuities and media sequence and endlist', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.000,
seg-1.ts
#EXT-X-DISCONTINUITY
#EXTINF:4.500,
seg-2.ts
#EXT-X-ENDLIST`
    const segments = [
      seg('https://cdn.example.com/hls/seg-1.ts', { index: 1 }),
      seg('https://cdn.example.com/hls/seg-2.ts', { index: 2, duration: 4.5, discontinuity: true }),
    ]
    const out = rewriteMediaPlaylist(body, segments, localFor, keyLocalFor, mapLocalFor)
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:10')
    expect(out).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(out).toContain('#EXT-X-DISCONTINUITY')
    expect(out).toContain('#EXT-X-ENDLIST')
    const reparsed = hlsParse(out) as import('hls-parser').types.MediaPlaylist
    expect(reparsed.mediaSequenceBase).toBe(10)
    expect(reparsed.playlistType).toBe('VOD')
    expect(reparsed.endlist).toBe(true)
    expect(reparsed.segments[1]?.discontinuity).toBe(true)
  })

  it('removes EXT-X-BYTERANGE after materialization (segment IS the range)', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
#EXT-X-BYTERANGE:1000@0
file.mp4
#EXT-X-ENDLIST`
    const segments = [
      seg('https://cdn.example.com/hls/file.mp4', { byterange: { length: 1000, offset: 0 } }),
    ]
    const out = rewriteMediaPlaylist(body, segments, localFor, keyLocalFor, mapLocalFor)
    expect(out).not.toContain('BYTERANGE')
    expect(out).toContain('video-000001.ts')
  })

  it('throws HLS_INVALID_MANIFEST when the body is a master playlist', () => {
    // A master body reaches the rewrite (e.g. a variant URL misdirected to a
    // master) — that is not a valid media playlist for remuxing.
    const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=100
child.m3u8`
    expect(() =>
      rewriteMediaPlaylist(master, [seg('https://x/s.ts')], localFor, keyLocalFor, mapLocalFor),
    ).toThrowError(/not a valid HLS playlist/)
  })

  it('throws HLS_SOURCE_CHANGED when the body parses to zero segments', () => {
    // An empty media playlist (no EXTINF) parses but has no segments — the
    // normalized model has one, so the count guard fires.
    expect(() =>
      rewriteMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-ENDLIST', [seg('https://x/s.ts')], localFor, keyLocalFor, mapLocalFor),
    ).toThrowError(/playlist changed/)
  })

  it('throws HLS_SOURCE_CHANGED when parsed segment count disagrees', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
seg-1.ts
#EXT-X-ENDLIST`
    // 2 normalized segments vs 1 parsed segment.
    expect(() =>
      rewriteMediaPlaylist(
        body,
        [seg('https://x/s1.ts', { index: 1 }), seg('https://x/s2.ts', { index: 2 })],
        localFor,
        keyLocalFor,
        mapLocalFor,
      ),
    ).toThrowError(/playlist changed/)
  })
})

describe('validateLocalPlaylist', () => {
  it('accepts a local-only media playlist and lists the files to check', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
video-000001.ts
#EXT-X-ENDLIST`
    const result = validateLocalPlaylist(body, '/tmp/job')
    expect(result.segmentCount).toBe(1)
    expect(result.localFiles).toContain('video-000001.ts')
  })

  it('rejects a playlist with a remote URI', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
https://evil.example.com/seg.ts
#EXT-X-ENDLIST`
    expect(() => validateLocalPlaylist(body, '/tmp/job')).toThrowError(/local playlist/)
  })

  it('rejects a URI escaping the job directory', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
../../etc/passwd
#EXT-X-ENDLIST`
    expect(() => validateLocalPlaylist(body, '/tmp/job')).toThrowError(/local playlist/)
  })

  it('rejects a master playlist passed as local', () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=100
child.m3u8`
    expect(() => validateLocalPlaylist(body, '/tmp/job')).toThrowError(/local playlist/)
  })

  it('rejects an empty playlist', () => {
    expect(() => validateLocalPlaylist('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-ENDLIST', '/tmp/job')).toThrowError(/local playlist/)
  })
})
