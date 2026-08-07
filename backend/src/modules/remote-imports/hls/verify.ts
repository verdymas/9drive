/**
 * Output verification with ffprobe (§16 of the spec).
 *
 * After remuxing, the output is verified BEFORE upload: container format,
 * duration, file size, expected video/audio streams, codec names, width/height
 * and stream durations. Rejects empty / zero-byte / truncated outputs and
 * anything outside the configured size limits.
 */
import fsp from 'node:fs/promises'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import { runFfprobe } from './ffmpeg.js'

export type MediaVerification = {
  container: string | null
  durationSeconds: number | null
  sizeBytes: number
  hasVideo: boolean
  hasAudio: boolean
  codecs: string[]
  width: number | null
  height: number | null
}

type FfprobeFormat = { format_name?: string; duration?: string; size?: string }
type FfprobeStream = { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }

/**
 * Verify the remuxed output. `expectVideo` / `expectAudio` assert the streams
 * the selected variant implied. Throws HLS_OUTPUT_INVALID on any failure.
 */
export async function verifyOutput(filePath: string, opts: { expectVideo: boolean; expectAudio: boolean }): Promise<MediaVerification> {
  const stats = await fsp.stat(filePath).catch(() => null)
  if (!stats || stats.size === 0) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, HLS_ERROR_MESSAGES.HLS_OUTPUT_INVALID, 500)
  }
  if (stats.size > env.REMOTE_IMPORT_MAX_BYTES) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'The output exceeds the maximum allowed size.', 413)
  }

  const probe = await runFfprobe(filePath)
  const format = probe.format as FfprobeFormat | undefined
  const streams = (Array.isArray(probe.streams) ? probe.streams : []) as FfprobeStream[]

  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  if (opts.expectVideo && !video) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'The output contains no video stream.', 500)
  }
  if (opts.expectAudio && !audio) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'The output contains no audio stream.', 500)
  }

  const formatDuration = Number(format?.duration)
  const duration = Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : null
  if (opts.expectVideo && duration !== null && duration < 0.1) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'The output appears truncated.', 500)
  }

  return {
    container: format?.format_name ?? null,
    durationSeconds: duration,
    sizeBytes: stats.size,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    codecs: streams.map((s) => s.codec_name ?? '').filter(Boolean),
    width: video?.width ?? null,
    height: video?.height ?? null,
  }
}