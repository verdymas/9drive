/**
 * Stable error codes for HLS remote imports (§25 of the feature spec).
 *
 * Every code here maps to a user-facing error message that never contains
 * internal IPs, local paths, stack traces, signed URLs, or secrets. The codes
 * are stable strings — the frontend keys UI behavior off the code, not the
 * message.
 */
export const HLS_ERROR_CODES = {
  HLS_DISABLED: 'HLS_DISABLED',
  HLS_INVALID_MANIFEST: 'HLS_INVALID_MANIFEST',
  HLS_MANIFEST_TOO_LARGE: 'HLS_MANIFEST_TOO_LARGE',
  HLS_PLAYLIST_DEPTH_EXCEEDED: 'HLS_PLAYLIST_DEPTH_EXCEEDED',
  HLS_PLAYLIST_LOOP: 'HLS_PLAYLIST_LOOP',
  HLS_TOO_MANY_VARIANTS: 'HLS_TOO_MANY_VARIANTS',
  HLS_TOO_MANY_SEGMENTS: 'HLS_TOO_MANY_SEGMENTS',
  HLS_NO_VALID_VARIANT: 'HLS_NO_VALID_VARIANT',
  HLS_SELECTED_VARIANT_NOT_FOUND: 'HLS_SELECTED_VARIANT_NOT_FOUND',
  HLS_AUDIO_TRACK_NOT_FOUND: 'HLS_AUDIO_TRACK_NOT_FOUND',
  HLS_LIVE_DURATION_REQUIRED: 'HLS_LIVE_DURATION_REQUIRED',
  HLS_LIVE_NOT_SUPPORTED: 'HLS_LIVE_NOT_SUPPORTED',
  HLS_LIVE_DURATION_INVALID: 'HLS_LIVE_DURATION_INVALID',
  HLS_SEGMENT_DOWNLOAD_FAILED: 'HLS_SEGMENT_DOWNLOAD_FAILED',
  HLS_SEGMENT_TOO_LARGE: 'HLS_SEGMENT_TOO_LARGE',
  HLS_SEGMENT_RANGE_INVALID: 'HLS_SEGMENT_RANGE_INVALID',
  HLS_MAP_DOWNLOAD_FAILED: 'HLS_MAP_DOWNLOAD_FAILED',
  HLS_KEY_DOWNLOAD_FAILED: 'HLS_KEY_DOWNLOAD_FAILED',
  HLS_ENCRYPTION_NOT_SUPPORTED: 'HLS_ENCRYPTION_NOT_SUPPORTED',
  HLS_DRM_NOT_SUPPORTED: 'HLS_DRM_NOT_SUPPORTED',
  HLS_SOURCE_CHANGED: 'HLS_SOURCE_CHANGED',
  HLS_REMUX_FAILED: 'HLS_REMUX_FAILED',
  HLS_OUTPUT_INVALID: 'HLS_OUTPUT_INVALID',
  FFMPEG_NOT_AVAILABLE: 'FFMPEG_NOT_AVAILABLE',
  FFMPEG_TIMEOUT: 'FFMPEG_TIMEOUT',
  FFPROBE_FAILED: 'FFPROBE_FAILED',
} as const

export type HlsErrorCode = (typeof HLS_ERROR_CODES)[keyof typeof HLS_ERROR_CODES]

/** Human-readable (safe) messages for the stable codes. */
export const HLS_ERROR_MESSAGES: Record<HlsErrorCode, string> = {
  HLS_DISABLED: 'HLS imports are disabled.',
  HLS_INVALID_MANIFEST: 'The source is not a valid HLS playlist.',
  HLS_MANIFEST_TOO_LARGE: 'The HLS playlist is too large.',
  HLS_PLAYLIST_DEPTH_EXCEEDED: 'The HLS playlist is nested too deeply.',
  HLS_PLAYLIST_LOOP: 'The HLS playlist references itself in a loop.',
  HLS_TOO_MANY_VARIANTS: 'The HLS master playlist has too many variants.',
  HLS_TOO_MANY_SEGMENTS: 'The HLS playlist has too many segments.',
  HLS_NO_VALID_VARIANT: 'No playable HLS variant was found.',
  HLS_SELECTED_VARIANT_NOT_FOUND: 'The selected quality is no longer available.',
  HLS_AUDIO_TRACK_NOT_FOUND: 'The selected audio track is no longer available.',
  HLS_LIVE_DURATION_REQUIRED: 'A recording duration is required for live streams.',
  HLS_LIVE_NOT_SUPPORTED: 'Live HLS streams are not supported.',
  HLS_LIVE_DURATION_INVALID: 'The recording duration is outside the allowed range.',
  HLS_SEGMENT_DOWNLOAD_FAILED: 'An HLS segment could not be downloaded.',
  HLS_SEGMENT_TOO_LARGE: 'An HLS segment exceeds the maximum allowed size.',
  HLS_SEGMENT_RANGE_INVALID: 'An HLS segment byte range could not be downloaded.',
  HLS_MAP_DOWNLOAD_FAILED: 'HLS initialization data could not be downloaded.',
  HLS_KEY_DOWNLOAD_FAILED: 'The HLS encryption key could not be downloaded.',
  HLS_ENCRYPTION_NOT_SUPPORTED: 'This HLS encryption method is not supported.',
  HLS_DRM_NOT_SUPPORTED: 'DRM-protected HLS streams are not supported.',
  HLS_SOURCE_CHANGED: 'The HLS playlist changed and the import must be restarted.',
  HLS_REMUX_FAILED: 'The HLS media could not be converted.',
  HLS_OUTPUT_INVALID: 'The converted output failed verification.',
  FFMPEG_NOT_AVAILABLE: 'FFmpeg is not available on the server.',
  FFMPEG_TIMEOUT: 'FFmpeg exceeded its time limit.',
  FFPROBE_FAILED: 'The output could not be verified.',
}
