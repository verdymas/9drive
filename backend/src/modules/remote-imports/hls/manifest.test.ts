import { describe, expect, it } from 'vitest'
import {
  classifyPlaylistKind,
  isHlsContentType,
  looksLikeM3u8Url,
  m3u8PrefixIsHls,
  parseManifest,
  plainM3uBody,
  safeVariantLabel,
} from './manifest.js'

const MASTER_BODY = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Indonesian",LANGUAGE="id",DEFAULT=NO,AUTOSELECT=YES,URI="audio/id.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2",AUDIO="audio"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"
mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,AVERAGE-BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"
high/index.m3u8`

const MEDIA_VOD = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
seg-1.ts
#EXTINF:6.000,
seg-2.ts
#EXT-X-ENDLIST`

const MEDIA_LIVE = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:6.000,
seg-1.ts
#EXTINF:6.000,
seg-2.ts`

describe('classification helpers', () => {
  it('detects HLS content types', () => {
    expect(isHlsContentType('application/vnd.apple.mpegurl')).toBe(true)
    expect(isHlsContentType('application/x-mpegurl; charset=utf-8')).toBe(true)
    expect(isHlsContentType('application/octet-stream')).toBe(false)
    expect(isHlsContentType(null)).toBe(false)
  })

  it('detects .m3u8 URLs', () => {
    expect(looksLikeM3u8Url(new URL('https://x/y/stream.m3u8'))).toBe(true)
    expect(looksLikeM3u8Url(new URL('https://x/y/stream.M3U8?token=1'))).toBe(true)
    expect(looksLikeM3u8Url(new URL('https://x/y/file.mp4'))).toBe(false)
  })

  it('requires an HLS-specific tag for the body prefix check', () => {
    expect(m3u8PrefixIsHls('#EXTM3U\n#EXT-X-TARGETDURATION:6')).toBe(true)
    expect(m3u8PrefixIsHls('#EXTM3U\n#EXTINF:6,\nfile.mp3')).toBe(false)
    expect(plainM3uBody('#EXTM3U\n#EXTINF:6,\nfile.mp3')).toBe(true)
    expect(plainM3uBody('#EXTM3U\n#EXT-X-TARGETDURATION:6')).toBe(false)
  })

  it('classifies playlist kinds', () => {
    expect(classifyPlaylistKind(true)).toBe('vod')
    expect(classifyPlaylistKind(false, 'EVENT')).toBe('event')
    expect(classifyPlaylistKind(false)).toBe('live')
  })

  it('formats safe variant labels', () => {
    expect(safeVariantLabel({ width: 1920, height: 1080, bandwidth: 6_000_000, averageBandwidth: 5_200_000 })).toBe('1080p · 5.20 Mbps')
    expect(safeVariantLabel({ width: null, height: null, bandwidth: 800_000, averageBandwidth: null })).toBe('0.80 Mbps')
  })
})

describe('parseManifest', () => {
  it('parses a master playlist with variants + audio tracks', () => {
    const info = parseManifest(MASTER_BODY, 'https://cdn.example.com/master.m3u8')
    expect(info.sourceType).toBe('master')
    expect(info.variants).toHaveLength(3)
    const high = info.variants.find((v) => v.height === 1080)
    expect(high?.bandwidth).toBe(6_000_000)
    expect(high?.childPlaylistUrl).toBe('https://cdn.example.com/high/index.m3u8')
    expect(high?.codecs).toContain('avc1.640028')
    expect(info.audioTracks).toHaveLength(2)
    const en = info.audioTracks.find((t) => t.language === 'en')
    expect(en?.name).toBe('English')
    expect(en?.playlistUrl).toBe('https://cdn.example.com/audio/en.m3u8')
    expect(en?.isDefault).toBe(true)
  })

  it('resolves variant child URLs against the FINAL manifest URL', () => {
    const info = parseManifest(MASTER_BODY, 'https://cdn.example.com/path/master.m3u8')
    expect(info.variants[0]?.childPlaylistUrl).toBe('https://cdn.example.com/path/low/index.m3u8')
  })

  it('parses a VOD media playlist with duration', () => {
    const info = parseManifest(MEDIA_VOD, 'https://cdn.example.com/media.m3u8')
    expect(info.sourceType).toBe('media')
    expect(info.isFinite).toBe(true)
    expect(info.playlistType).toBe('vod')
    expect(info.durationSeconds).toBe(12)
  })

  it('parses a live/event media playlist', () => {
    const info = parseManifest(MEDIA_LIVE, 'https://cdn.example.com/live.m3u8')
    expect(info.sourceType).toBe('media')
    expect(info.isFinite).toBe(false)
    expect(info.playlistType).toBe('event')
  })

  it('rejects a body with neither variants nor segments', () => {
    expect(() => parseManifest('#EXTM3U\n#EXT-X-VERSION:7\n', 'https://x/m.m3u8')).toThrowError(/not a valid HLS playlist/)
  })

  it('rejects too many variants', () => {
    expect(() => parseManifest(MASTER_BODY, 'https://x/m.m3u8', { maxVariants: 2 })).toThrowError(/too many variants/)
  })

  it('rejects too many segments', () => {
    expect(() => parseManifest(MEDIA_VOD, 'https://x/m.m3u8', { maxSegments: 1 })).toThrowError(/too many segments/)
  })
})
