import { describe, expect, it } from 'vitest'
import { resolveSelectedVariant, resolveSelectedAudio, selectBestVariant } from './selection.js'
import type { HlsVariantMetadata, HlsAudioTrackMetadata } from './manifest.js'

function variant(partial: Partial<HlsVariantMetadata>): HlsVariantMetadata {
  return {
    id: 'abc',
    childPlaylistUrl: 'https://x/index.m3u8',
    bandwidth: 1_000_000,
    averageBandwidth: null,
    width: null,
    height: null,
    frameRate: null,
    codecs: [],
    audioGroup: null,
    label: '',
    ...partial,
  }
}

const variants = [
  variant({ id: 'low', height: 360, bandwidth: 800_000, averageBandwidth: 700_000, codecs: ['avc1.4d001e'] }),
  variant({ id: 'mid', height: 720, bandwidth: 3_000_000, averageBandwidth: 2_500_000, codecs: ['avc1.64001f'] }),
  variant({ id: 'high', height: 1080, bandwidth: 6_000_000, averageBandwidth: 5_200_000, codecs: ['avc1.640028'] }),
]

describe('selectBestVariant', () => {
  it('picks the highest resolution under the limit', () => {
    expect(selectBestVariant(variants)?.id).toBe('high')
  })

  it('respects maxHeight', () => {
    expect(selectBestVariant(variants, { maxHeight: 720 })?.id).toBe('mid')
    expect(selectBestVariant(variants, { maxHeight: 360 })?.id).toBe('low')
  })

  it('returns null when nothing is within limits', () => {
    expect(selectBestVariant(variants, { maxHeight: 240 })).toBeNull()
  })

  it('prefers a video-capable variant over an audio-only one', () => {
    const onlyAudio = variant({ id: 'audio-only', codecs: ['mp4a.40.2'], height: null })
    const mixed = [...variants, onlyAudio]
    expect(selectBestVariant(mixed)?.id).toBe('high')
  })
})

describe('resolveSelectedVariant', () => {
  it('auto → best available', () => {
    expect(resolveSelectedVariant(variants, 'auto').id).toBe('high')
    expect(resolveSelectedVariant(variants, null).id).toBe('high')
    expect(resolveSelectedVariant(variants, undefined).id).toBe('high')
  })

  it('resolves an exact opaque id', () => {
    expect(resolveSelectedVariant(variants, 'mid').id).toBe('mid')
  })

  it('throws for an unknown id', () => {
    expect(() => resolveSelectedVariant(variants, 'nope')).toThrowError(/no longer available/)
  })

  it('throws when no valid variant exists', () => {
    expect(() => resolveSelectedVariant([], 'auto')).toThrowError(/No playable/)
  })
})

describe('resolveSelectedAudio', () => {
  const tracks: HlsAudioTrackMetadata[] = [
    { id: 'en', language: 'en', name: 'English', isDefault: true, isAutoSelect: true, playlistUrl: 'https://x/en.m3u8', groupId: 'audio' },
    { id: 'id', language: 'id', name: 'Indonesian', isDefault: false, isAutoSelect: true, playlistUrl: null, groupId: 'audio' },
  ]

  it('returns null with no tracks', () => {
    expect(resolveSelectedAudio([], 'auto')).toBeNull()
  })

  it('auto → the default-marked track', () => {
    expect(resolveSelectedAudio(tracks, 'auto')?.id).toBe('en')
  })

  it('resolves an exact audio id', () => {
    const t = resolveSelectedAudio(tracks, 'id')
    expect(t?.name).toBe('Indonesian')
    expect(t?.playlistUrl).toBeNull() // server-side null is allowed
  })

  it('throws for an unknown audio id', () => {
    expect(() => resolveSelectedAudio(tracks, 'xx')).toThrowError(/no longer available/)
  })

  it('falls back to the first track when no default is marked', () => {
    const noDefault = tracks.map((t) => ({ ...t, isDefault: false }))
    expect(resolveSelectedAudio(noDefault, 'auto')?.id).toBe('en')
  })
})