/**
 * Deterministic variant + audio-rendition selection for HLS remote imports.
 *
 * Automatic selection:
 *   1. A variant with valid video codecs is preferred.
 *   2. The highest resolution within configured limits.
 *   3. The highest average bandwidth (fallback: bandwidth) within limits.
 *   4. A deterministic tie-breaker (the stable variant id).
 *
 * Only the current version of the constraints is documented per-call; the
 * worker re-resolves a selected opaque id against the freshly fetched master
 * playlist so a raw child-playlist URL from the client is never trusted.
 */
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import type { HlsAudioTrackMetadata, HlsVariantMetadata } from './manifest.js'

/** Video-capable codec prefixes we recognize (avc1/hevc1/mp4a.. for H.264 etc.). */
function isVideoCodec(codec: string): boolean {
  const c = codec.toLowerCase()
  return c.startsWith('avc1') || c.startsWith('avc3') || c.startsWith('hev1') || c.startsWith('hvc1') || c.startsWith('mp4v') || c.startsWith('vp09') || c.startsWith('av01')
}

/**
 * True when a variant plausibly carries video. A variant with no CODECS
 * attribute is allowed (treated as valid) rather than rejected outright —
 * many servers omit codecs.
 */
function variantLooksLikeVideo(variant: HlsVariantMetadata): boolean {
  if (variant.codecs.length === 0) return true
  // At least one codec is a video codec.
  return variant.codecs.some(isVideoCodec)
}

export type AutoSelectOptions = {
  maxHeight?: number
  maxBandwidth?: number
}

/** Pick the "best" variant under configured limits, deterministically. */
export function selectBestVariant(variants: HlsVariantMetadata[], opts: AutoSelectOptions = {}): HlsVariantMetadata | null {
  const maxHeight = opts.maxHeight ?? env.REMOTE_IMPORT_HLS_MAX_HEIGHT
  const maxBandwidth = opts.maxBandwidth ?? env.REMOTE_IMPORT_HLS_MAX_BANDWIDTH

  const eligible = variants
    .filter(variantLooksLikeVideo)
    .filter((v) => maxHeight <= 0 || v.height === null || v.height <= maxHeight)
    .filter((v) => maxBandwidth <= 0 || v.averageBandwidth === null || v.bandwidth === 0 || Math.max(v.averageBandwidth ?? 0, v.bandwidth) <= maxBandwidth)

  if (eligible.length === 0) return null

  // Highest resolution first, then highest bandwidth, then stable id (deterministic).
  return [...eligible].sort((a, b) => {
    const aHeight = a.height ?? 0
    const bHeight = b.height ?? 0
    if (aHeight !== bHeight) return bHeight - aHeight
    const aBw = a.averageBandwidth ?? a.bandwidth
    const bBw = b.averageBandwidth ?? b.bandwidth
    if (aBw !== bBw) return bBw - aBw
    return a.id.localeCompare(b.id)
  })[0]
}

/**
 * Resolve the effective selected variant from a master playlist.
 *
 * `variantId` is either the string `'auto'` (best-available) or a stable id
 * returned by the probe. The caller fetches a FRESH master playlist before
 * calling here — a client-supplied raw URL is never accepted.
 */
export function resolveSelectedVariant(variants: HlsVariantMetadata[], variantId: string | null | undefined): HlsVariantMetadata {
  if (!variantId || variantId === 'auto') {
    const best = selectBestVariant(variants)
    if (!best) throw new AppError(HLS_ERROR_CODES.HLS_NO_VALID_VARIANT, HLS_ERROR_MESSAGES.HLS_NO_VALID_VARIANT, 400)
    return best
  }
  const found = variants.find((v) => v.id === variantId)
  if (!found) throw new AppError(HLS_ERROR_CODES.HLS_SELECTED_VARIANT_NOT_FOUND, HLS_ERROR_MESSAGES.HLS_SELECTED_VARIANT_NOT_FOUND, 400)
  return found
}

/**
 * Choose the audio rendition to mux. Precedence:
 *   1. Playlist-marked default.
 *   2. Auto-select audio.
 *   3. First valid supported rendition.
 * When `audioTrackId` differs from 'auto', that exact track is required.
 */
export function resolveSelectedAudio(tracks: HlsAudioTrackMetadata[], audioTrackId: string | null | undefined): HlsAudioTrackMetadata | null {
  if (tracks.length === 0) return null
  if (audioTrackId && audioTrackId !== 'auto') {
    const found = tracks.find((t) => t.id === audioTrackId)
    if (!found) throw new AppError(HLS_ERROR_CODES.HLS_AUDIO_TRACK_NOT_FOUND, HLS_ERROR_MESSAGES.HLS_AUDIO_TRACK_NOT_FOUND, 400)
    return found
  }
  const def = tracks.find((t) => t.isDefault)
  if (def) return def
  const auto = tracks.find((t) => t.isAutoSelect)
  if (auto) return auto
  return tracks[0] ?? null
}