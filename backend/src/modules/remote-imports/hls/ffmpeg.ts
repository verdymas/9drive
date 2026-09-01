/**
 * FFmpeg + ffprobe integration for HLS remote imports (§15/§16 of the spec).
 *
 * Security posture:
 *  - FFmpeg runs via `spawn` with an argument ARRAY — never a shell string,
 *    never user input in an argument position.
 *  - FFmpeg reads ONLY the local rewritten playlist (job directory) — the
 *    `-protocol_whitelist file,crypto` forbids http/https/tcp/tls so a remote
 *    fetch can never bypass the application's SSRF-safe fetcher.
 *  - The process working directory is the job directory.
 *  - `-progress pipe:1` is parsed for remux percentage.
 *  - Cancellation sends SIGTERM, then SIGKILL after a grace period; a hard
 *    timeout force-kills the process.
 *  - stderr is capped; partial output is never renamed over the final file.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'
import { selectConcatSegments, validateSegmentFile, type SegmentValidation, type TsLayout } from './segment-validator.js'

export type FfmpegProgress = { percent: number | null; speed: string | null }

export type FfmpegRunResult = {
  /** Final path of the remuxed file (already renamed from the `.part`). */
  outputPath: string
  stderrTail: string
}

function execFileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Verify both binaries exist; throws FFMPEG_NOT_AVAILABLE otherwise. */
export function verifyFfmpegAvailable(): void {
  if (!execFileExists(env.REMOTE_IMPORT_FFMPEG_PATH)) {
    throw new AppError(HLS_ERROR_CODES.FFMPEG_NOT_AVAILABLE, HLS_ERROR_MESSAGES.FFMPEG_NOT_AVAILABLE, 500)
  }
  if (!execFileExists(env.REMOTE_IMPORT_FFPROBE_PATH)) {
    throw new AppError(HLS_ERROR_CODES.FFMPEG_NOT_AVAILABLE, HLS_ERROR_MESSAGES.FFMPEG_NOT_AVAILABLE, 500)
  }
}

/** Run `-version` for both tools; returns a safe log line. */
export async function ffmpegVersionInfo(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const version = async (bin: string): Promise<string> => {
    try {
      const { stdout } = await runBinary(bin, ['-version'], 10_000, () => undefined)
      const first = stdout.split('\n')[0]?.trim() ?? 'unknown'
      return first
    } catch {
      return 'unavailable'
    }
  }
  return { ffmpeg: await version(env.REMOTE_IMPORT_FFMPEG_PATH), ffprobe: await version(env.REMOTE_IMPORT_FFPROBE_PATH) }
}

async function runBinary(bin: string, args: string[], timeoutMs: number, onProgress: (line: string) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const maxStderr = 64 * 1024
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new AppError(HLS_ERROR_CODES.FFMPEG_TIMEOUT, HLS_ERROR_MESSAGES.FFMPEG_TIMEOUT, 408))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr)
      for (const line of text.split('\n')) onProgress(line)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
        const err = new AppError(HLS_ERROR_CODES.HLS_FFMPEG_FAILED, `FFmpeg exited with code ${code}.`, 500)
        ;(err as AppError & { meta?: string }).meta = stderr.slice(-2000)
        reject(err)
      }
    })
  })
}

/**
 * Parse a `-progress pipe:1` line pair (`key=value`). Returns the last percent
 * and speed seen. `progress=end` is ignored by callers (mux completed).
 */
export function parseFfmpegProgress(line: string): Partial<FfmpegProgress> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq)
  const value = trimmed.slice(eq + 1)
  if (key === 'out_time_ms') {
    const ms = Number(value)
    if (Number.isFinite(ms)) return { percent: null }
  }
  if (key === 'progress') {
    // 'continue'/'end' markers — nothing to report.
    return null
  }
  return null
}

/**
 * Parse the standard ffmpeg progress lines into a percentage when the total
 * duration is known. `out_time_us` is the current output timestamp in
 * microseconds.
 */
export function parseFfmpegProgressLine(line: string, totalSeconds: number): { percent: number | null; speed: string | null } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq)
  const value = trimmed.slice(eq + 1)
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const us = key === 'out_time_ms' ? Number(value) * 1000 : Number(value)
    if (!Number.isFinite(us) || totalSeconds <= 0) return { percent: null, speed: null }
    const seconds = us / 1_000_000
    return { percent: Math.max(0, Math.min(99.9, (seconds / totalSeconds) * 100)), speed: null }
  }
  if (key === 'speed') return { percent: null, speed: value === 'N/A' ? null : value }
  return null
}

/**
 * Shared FFmpeg process runner: spawn, cap stderr, parse `-progress pipe:1`,
 * enforce the timeout, forward abort (SIGTERM → SIGKILL), and rename the
 * `.part` output to its final path only on a clean exit.
 */
function runFfmpegProcess(args: string[], outputPartPath: string, opts: { cwd: string; signal?: AbortSignal; onProgress?: (p: { percent: number | null }) => void; totalDurationSeconds?: number }): Promise<FfmpegRunResult> {
  const maxStderr = 64 * 1024
  const timeoutMs = env.REMOTE_IMPORT_FFMPEG_TIMEOUT_SECONDS * 1000
  const { cwd, signal, onProgress, totalDurationSeconds } = opts

  return new Promise((resolve, reject) => {
    const child = spawn(env.REMOTE_IMPORT_FFMPEG_PATH, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''

    const kill = (signalName: NodeJS.Signals) => {
      child.kill(signalName)
    }

    const timer = setTimeout(() => {
      kill('SIGKILL')
      reject(new AppError(HLS_ERROR_CODES.FFMPEG_TIMEOUT, HLS_ERROR_MESSAGES.FFMPEG_TIMEOUT, 408))
    }, timeoutMs)

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        kill('SIGTERM')
        // Escalate after a grace period so a hung process cannot survive.
        setTimeout(() => kill('SIGKILL'), 5_000).unref()
      }, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const parsed = parseFfmpegProgressLine(line, totalDurationSeconds ?? 0)
        if (parsed?.percent != null) onProgress?.({ percent: parsed.percent })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', async (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const err = new AppError(HLS_ERROR_CODES.HLS_REMUX_FAILED, HLS_ERROR_MESSAGES.HLS_REMUX_FAILED, 500)
        ;(err as AppError & { meta?: string }).meta = stderr.slice(-2000)
        reject(err)
        return
      }
      // Rename `.part` → final only after FFmpeg succeeded.
      const finalPath = outputPartPath.replace(/\.part$/, '')
      await fsp.rename(outputPartPath, finalPath)
      resolve({ outputPath: finalPath, stderrTail: stderr.slice(-2000) })
    })
  })
}

/** Shared demux flags — the known-good conversion script (code_example_convert.sh)
 *  uses the same large probe buffers so unusual/pipe-like sources are detected. */
const DEMUXER_ARGS = ['-analyzeduration', '100M', '-probesize', '100M']

/**
 * Stream-copy mapping for the output muxer: only video, audio and subtitles.
 * Matroska rejects data/unknown/private MPEG-TS streams ("Only audio, video,
 * and subtitles are supported for Matroska.") — the `?` keeps each map
 * optional so audio-only / video-only sources still remux.
 */
export const SUPPORTED_STREAM_MAP_ARGS = ['-map', '0:v?', '-map', '0:a?', '-map', '0:s?']

/**
 * Raw-payload demux flags — the code_example_convert.sh "repair" step doubles
 * the probe buffers so the forced `mpegts` demuxer can sync onto a large or
 * garbage-prefixed MPEG-TS payload where default-sized probing would fail.
 */
const CONCAT_TS_DEMUXER_ARGS = ['-analyzeduration', '200M', '-probesize', '200M']

/**
 * Run FFmpeg against the local rewritten playlist (stream copy — the fast
 * path). A container that cannot hold the stream-copied codec fails here; the
 * pipeline falls back to `runFfmpegReencode`.
 *
 * @param inputPlaylistPath absolute path of the local media playlist
 * @param outputPartPath   absolute `.part` path — renamed to final on success
 * @param container        'mkv' | 'mp4'
 * @param cwd              job directory
 * @param signal           abort (SIGTERM → SIGKILL escalation)
 * @param onProgress       throttled percent callback
 */
/** Timestamp/DTS compatibility flags (§9 — named profile `timestamp_compat`). */
const TIMESTAMP_COMPAT_ARGS = ['-fflags', '+genpts', '-avoid_negative_ts', 'make_zero']

/**
 * True when the remux stderr tail looks like a timestamp/DTS problem (negative
 * or non-monotonic timestamps) — the case the `timestamp_compat` profile fixes.
 */
function looksLikeTimestampIssue(stderr: string): boolean {
  return /non-monotonic dts|invalid dts|negative.*timestamp|timestamp.*negative|dts <|pts <|out of range.*dts|non-monotonic.*timestamp/i.test(stderr)
}

/**
 * Run FFmpeg against the local rewritten playlist (stream copy — the fast
 * path). A container that cannot hold the stream-copied codec fails here; the
 * pipeline falls back to `runFfmpegReencode`.
 *
 * On a first failure that looks like a timestamp/DTS issue, the run is retried
 * ONCE with the named `timestamp_compat` profile (`-fflags +genpts
 * -avoid_negative_ts make_zero`) — a targeted fix, never random flag
 * combinations (§9). The retry reports HLS_FFMPEG_TIMESTAMP_FAILED if it
 * fails again, so the failure is attributable.
 *
 * @param inputPlaylistPath absolute path of the local media playlist
 * @param outputPartPath   absolute `.part` path — renamed to final on success
 * @param container        'mkv' | 'mp4'
 * @param cwd              job directory
 * @param signal           abort (SIGTERM → SIGKILL escalation)
 * @param onProgress       throttled percent callback
 */
export async function runFfmpegRemux(
  inputPlaylistPath: string,
  outputPartPath: string,
  container: 'mkv' | 'mp4',
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: { percent: number | null }) => void,
  totalDurationSeconds?: number,
): Promise<FfmpegRunResult> {
  verifyFfmpegAvailable()
  // Diagnostic only — never throws, never fails a remux because an
  // unsupported (data/private) stream exists.
  const probe = await probeMediaStreams(inputPlaylistPath, 'playlist').catch(() => null)
  const baseArgs = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-progress', 'pipe:1',
    '-protocol_whitelist', 'file,crypto',
    ...DEMUXER_ARGS,
    // The rewritten local playlist emits .m3u8/.ts (segments), .mp4 (fMP4
    // init maps) and .bin (AES-128 keys). FFmpeg's HLS demuxer restricts which
    // file extensions it will open — without this, a `video-key-000001.bin`
    // key (or `.mp4` init map) is refused ("Unable to open key file").
    '-allowed_extensions', 'm3u8,ts,mp4,bin',
    '-i', inputPlaylistPath,
    ...SUPPORTED_STREAM_MAP_ARGS,
    '-c', 'copy',
    ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
    // The output path is `output.<ext>.part` — FFmpeg cannot infer the muxer
    // from a `.part` suffix, so the container is pinned explicitly.
    '-f', container === 'mp4' ? 'mp4' : 'matroska',
    '-y',
  ]

  try {
    return await runFfmpegProcess([...baseArgs, outputPartPath], outputPartPath, { cwd, signal, onProgress, totalDurationSeconds })
  } catch (error) {
    // Attach a safe stream-selection summary before any retry so both the
    // first failure and the retry failure carry it.
    if (error instanceof AppError && error.code === HLS_ERROR_CODES.HLS_REMUX_FAILED) {
      const summary = summarizeStreamSelection(probe)
      if (summary) (error as AppError & { meta?: string }).meta = `${(error as AppError & { meta?: string }).meta ?? ''}${summary}`.trim()
    }
    // Timestamp/DTS problem → ONE retry with the named compatibility profile.
    if (error instanceof AppError && error.code === HLS_ERROR_CODES.HLS_REMUX_FAILED && looksLikeTimestampIssue((error as AppError & { meta?: string }).meta ?? '')) {
      try {
        return await runFfmpegProcess([...baseArgs, ...TIMESTAMP_COMPAT_ARGS, outputPartPath], outputPartPath, { cwd, signal, onProgress, totalDurationSeconds })
      } catch (retryError) {
        // The compatibility profile failed too — surface it as an attributable
        // timestamp error (a new AppError; `code` is readonly).
        if (retryError instanceof AppError && retryError.code === HLS_ERROR_CODES.HLS_REMUX_FAILED) {
          const err = new AppError(HLS_ERROR_CODES.HLS_FFMPEG_TIMESTAMP_FAILED, HLS_ERROR_MESSAGES.HLS_FFMPEG_TIMESTAMP_FAILED, 500)
          ;(err as AppError & { meta?: string }).meta = (retryError as AppError & { meta?: string }).meta
          throw err
        }
        throw retryError
      }
    }
    throw error
  }
}

/**
 * Concatenate the materialized MPEG-TS segments and stream-copy them into the
 * output container — the "repair" method from code_example_convert.sh (the
 * script's final block: `ffmpeg ... -f mpegts -i "$TEMP_FILE" -c copy`).
 *
 * When the HLS *demuxer* refuses the playlist/segments (a non-TS first segment,
 * a quirk in one segment), the raw payload itself may still be fine — the
 * lenient `mpegts` demuxer skips garbage and syncs onto the stream where the
 * HLS demuxer hard-fails. We concat the local TS segments ourselves (a known
 * local file → known local file copy is safe — none of the segment paths are
 * untrusted input), then force `-f mpegts` on the payload with doubled probe
 * buffers exactly like the script. If this copy also fails, the caller reports
 * HLS_CONCAT_TS_COPY_FAILED (the terminal conversion error) — the pipeline's
 * final re-encode attempt is not re-attempted, since the HLS demuxer failure
 * that started this chain is independent of the codec.
 *
 * Concatenation is now STREAMD (1 MiB copy) instead of `fsp.readFile` per
 * segment — a 2-hour HLS import's first segment can be 256 MiB, and the old
 * path double-buffered the whole stream. A validation gate enforces:
 *   - every segment classified as a real MPEG-TS / M2TS payload (no HTML/JSON
 *     error pages, no fMP4, no ciphertext),
 *   - a single, uniform packet size (188 / 192 / 204 / 208) across the whole
 *     payload — mixing them is the classic `[mpegts] changing packet size …
 *     could not find codec parameters` failure,
 *   - the first payload segment carries a PAT/PMT (codec parameters live there).
 *
 * Dropped segments are reported in the error meta as safe counts + index
 * ranges — never paths, never URLs.
 *
 * Only usable when every segment was materialized as a standalone MPEG-TS file
 * with no init-map/byterange dependencies (discontinuities also make the
 * raw concat unsafe) — the pipeline guards this before calling.
 *
 * @param segmentPaths   absolute paths of the materialized local TS segments, in order
 * @param outputPartPath absolute `.part` path — renamed to final on success
 * @param container      'mkv' | 'mp4'
 * @param cwd            job directory
 * @param signal         abort (SIGTERM → SIGKILL escalation)
 * @param onProgress     throttled percent callback
 */
export async function runFfmpegConcatTsCopy(
  segmentPaths: string[],
  outputPartPath: string,
  container: 'mkv' | 'mp4',
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: { percent: number | null }) => void,
): Promise<FfmpegRunResult> {
  verifyFfmpegAvailable()

  // ── Validation gate (remux fix §3). ───────────────────────────────────────
  // `selectConcatSegments` is pure: same `segmentPaths` → same selection.
  // A failure here means the source actually mixed packet sizes, sent an
  // error page for one segment, or the first segment was header-less — the
  // exact class of problems the old `cat *.ts` pipeline silently propagated
  // to FFmpeg as a "could not find codec parameters" failure.
  const validations: SegmentValidation[] = []
  for (let i = 0; i < segmentPaths.length; i += 1) {
    validations.push(await validateSegmentFile(segmentPaths[i], { index: i + 1 }))
  }
  const selection = selectConcatSegments(validations)
  if (selection.payload.length === 0) {
    const meta = describeConcatFailure(validations, selection)
    throw Object.assign(new AppError(HLS_ERROR_CODES.HLS_CONCAT_TS_COPY_FAILED, HLS_ERROR_MESSAGES.HLS_CONCAT_TS_COPY_FAILED, 500), { meta })
  }
  const droppedSummary = selection.dropped.length > 0 ? ` dropped=${selection.dropped.length} packetSizes=${selection.packetSizes.join(',')}` : ''
  console.log(`[hls-remux] concat-gate segments=${validations.length} payload=${selection.payload.length} uniform=${selection.uniform}${droppedSummary}`)

  // ── Stream the payload: 1 MiB read → 1 MiB write per pass. ───────────────
  const payloadPath = path.join(cwd, 'concat-payload.ts')
  const payloadHandle = await fsp.open(payloadPath, 'w')
  try {
    for (const v of selection.payload) {
      const localName = path.basename(segmentPaths[v.index - 1])
      console.log(`[hls-remux] concat-stream segment=${localName} size=${v.sizeBytes}`)
      const src = await fsp.open(segmentPaths[v.index - 1], 'r')
      try {
        const buf = Buffer.alloc(1024 * 1024)
        let pos = 0
        while (true) {
          const { bytesRead } = await src.read(buf, 0, buf.length, pos)
          if (bytesRead === 0) break
          await payloadHandle.write(buf.subarray(0, bytesRead))
          pos += bytesRead
        }
      } finally {
        await src.close().catch(() => undefined)
      }
    }
  } catch (error) {
    await payloadHandle.close().catch(() => undefined)
    await fsp.rm(payloadPath, { force: true }).catch(() => undefined)
    throw error
  }
  await payloadHandle.close()

  // ── Input probe (diagnostic only, never throws). ─────────────────────────
  const rawProbe = await probeMediaStreams(payloadPath, 'rawts').catch(() => null)

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-progress', 'pipe:1',
    '-protocol_whitelist', 'file,crypto',
    ...CONCAT_TS_DEMUXER_ARGS,
    // Force the MPEG-TS demuxer — do NOT let FFmpeg sniff the extension-less
    // payload. The lenient TS demuxer syncs onto the stream where the HLS
    // demuxer hard-fails.
    '-f', 'mpegts',
    '-i', payloadPath,
    ...SUPPORTED_STREAM_MAP_ARGS,
    '-c', 'copy',
    ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
    '-f', container === 'mp4' ? 'mp4' : 'matroska',
    '-y',
  ]

  try {
    // NOTE: `runFfmpegProcess` spawns the args VERBATIM — the output path must
    // be appended here (the remux caller does `[...baseArgs, outputPartPath]`).
    return await runFfmpegProcess([...args, outputPartPath], outputPartPath, { cwd, signal, onProgress })
  } catch (error) {
    // Attach a safe summary to the terminal failure — never paths, never URLs.
    if (error instanceof AppError && (error as { code?: string }).code === HLS_ERROR_CODES.HLS_REMUX_FAILED) {
      const meta = `${summarizeStreamSelection(rawProbe)} ${describeConcatFailure(validations, selection)}`.trim()
      if (meta) (error as AppError & { meta?: string }).meta = `${(error as AppError & { meta?: string }).meta ?? ''}${meta}`.trim()
    }
    throw error
  } finally {
    // The payload is scratch — never leave it in the job dir (the output
    // `.part` file stays for the caller to rename on success).
    await fsp.rm(payloadPath, { force: true }).catch(() => undefined)
  }
}

/** Safe failure summary for the concat gate — counts + index ranges only. */
function describeConcatFailure(validations: SegmentValidation[], selection: ReturnType<typeof selectConcatSegments>): string {
  const kinds = new Map<string, number>()
  for (const v of validations) {
    const c = v.classification
    const key = c.kind === 'mpegts' || c.kind === 'm2ts' ? `${c.kind}/${c.layout.packetSize}` : c.kind
    kinds.set(key, (kinds.get(key) ?? 0) + 1)
  }
  const dropped = selection.dropped.length > 0 ? ` droppedIndexes=${selection.dropped.slice(0, 16).join(',')}${selection.dropped.length > 16 ? '…' : ''}` : ''
  return `[concat-gate] kinds=${[...kinds.entries()].map(([k, n]) => `${k}:${n}`).join(',')} packetSizes=${selection.packetSizes.join(',')} uniform=${selection.uniform} payload=${selection.payload.length}/${validations.length}${dropped}`
}

/** Public safe summary used by callers (and tests) — never logs paths. */
export function describeConcatPayloadForLogs(payload: { validations: SegmentValidation[]; selection: ReturnType<typeof selectConcatSegments> }): string {
  return describeConcatFailure(payload.validations, payload.selection)
}

/**
 * One detected input stream with the remux decision. `reason` is present only
 * when the stream is skipped.
 */
export type ProbedMediaStream = {
  index: number
  codecType: string | null
  codecName: string | null
  selected: boolean
  reason?: string
}

/** Result of probing the input the remux is about to consume. */
export type MediaStreamProbe = {
  inputBasename: string
  mode: 'playlist' | 'rawts'
  format: string | null
  durationSeconds: number | null
  videoCodec: string | null
  audioCodec: string | null
  streams: ProbedMediaStream[]
  ok: boolean
  reason?: string
}

type FfprobeStream = { index?: number; codec_type?: string; codec_name?: string }

/**
 * Decide which input streams the remux keeps. Matroska supports only video,
 * audio and subtitles — data/unknown/private MPEG-TS streams are skipped.
 * Pure (array in → decision out) so the logic is unit-testable without any
 * binary. Unsupported streams never fail a remux.
 */
export function selectRemuxStreams(streams: FfprobeStream[]): ProbedMediaStream[] {
  return streams.map((s, position) => {
    const codecType = s.codec_type ?? null
    const selected = codecType === 'video' || codecType === 'audio' || codecType === 'subtitle'
    const item: ProbedMediaStream = {
      index: s.index ?? position,
      codecType,
      codecName: s.codec_name ?? null,
      selected,
    }
    if (!selected) item.reason = 'unsupported_for_matroska'
    return item
  })
}

/**
 * Run ffprobe on the input the remux is about to consume and log every stream
 * with its selection decision. Diagnostic only: never throws, never returns
 * sensitive fields. The summary is logged AND attached as a safe one-liner for
 * the failure path of the surrounding remux (helps the operator tell "data
 * stream dropped" from "no PAT/PMT" without re-running anything). Logs the
 * basename only — never full paths, URLs or secrets.
 */
export async function probeMediaStreams(inputPath: string, mode: 'playlist' | 'rawts'): Promise<MediaStreamProbe> {
  if (!execFileExists(env.REMOTE_IMPORT_FFPROBE_PATH)) {
    return { inputBasename: path.basename(inputPath), mode, format: null, durationSeconds: null, videoCodec: null, audioCodec: null, streams: [], ok: false, reason: 'ffprobe-missing' }
  }
  const args =
    mode === 'rawts'
      ? ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-f', 'mpegts', inputPath]
      : ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-allowed_extensions', 'm3u8,ts,mp4,bin', inputPath]
  const timeoutMs = 15_000
  try {
    const { stdout } = await runBinary(env.REMOTE_IMPORT_FFPROBE_PATH, args, timeoutMs, () => undefined)
    const parsed = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: FfprobeStream[] }
    const format = parsed.format?.format_name ?? null
    const duration = (() => {
      const d = Number(parsed.format?.duration)
      return Number.isFinite(d) && d > 0 ? d : null
    })()
    const selected = selectRemuxStreams(parsed.streams ?? [])
    const videoCodec = selected.find((s) => s.codecType === 'video')?.codecName ?? null
    const audioCodec = selected.find((s) => s.codecType === 'audio')?.codecName ?? null
    const probe: MediaStreamProbe = {
      inputBasename: path.basename(inputPath),
      mode,
      format,
      durationSeconds: duration,
      videoCodec,
      audioCodec,
      streams: selected,
      ok: Boolean(format),
    }
    console.log(`[hls-remux] streams input=${probe.inputBasename} mode=${mode} format=${format ?? 'unknown'} duration=${duration ?? 'unknown'} video=${videoCodec ?? 'none'} audio=${audioCodec ?? 'none'}`)
    for (const s of selected) {
      console.log(
        `[hls-remux] streams ${s.index}: type=${s.codecType ?? 'unknown'} codec=${s.codecName ?? 'unknown'} selected=${s.selected}${s.reason ? ` reason=${s.reason}` : ''}`,
      )
    }
    return probe
  } catch (error) {
    const reason = error instanceof AppError ? error.code : 'probe-failed'
    console.warn(`[hls-remux] streams input=${path.basename(inputPath)} mode=${mode} reason=${reason}`)
    return { inputBasename: path.basename(inputPath), mode, format: null, durationSeconds: null, videoCodec: null, audioCodec: null, streams: [], ok: false, reason }
  }
}

/**
 * Safe one-line stream-selection summary for failure meta — counts only, no
 * paths, URLs or secrets. Returns '' when the probe failed or was not run.
 */
export function summarizeStreamSelection(probe: MediaStreamProbe | null): string {
  if (!probe || !probe.ok || probe.streams.length === 0) return ''
  const selectedCount = probe.streams.filter((s) => s.selected).length
  const skipped = probe.streams.length - selectedCount
  return `[streams] selected=${selectedCount}/${probe.streams.length} skipped=${skipped}`
}

/** Re-export the layout type for callers that build remediation paths. */
export type { TsLayout }

/**
 * Run FFmpeg against the local rewritten playlist with a REAL encode
 * (H.264 + AAC) — the re-encode fallback the known-good conversion script uses
 * when a stream-copy remux fails (e.g. image2/png-pipe sources, or a codec no
 * container will hold). Slower than `runFfmpegRemux`; called once as a
 * last-resort conversion.
 *
 * @param inputPlaylistPath absolute path of the local media playlist
 * @param outputPartPath   absolute `.part` path — renamed to final on success
 * @param container        'mkv' | 'mp4'
 * @param cwd              job directory
 * @param signal           abort (SIGTERM → SIGKILL escalation)
 * @param onProgress       throttled percent callback
 */
export async function runFfmpegReencode(
  inputPlaylistPath: string,
  outputPartPath: string,
  container: 'mkv' | 'mp4',
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: { percent: number | null }) => void,
  totalDurationSeconds?: number,
): Promise<FfmpegRunResult> {
  verifyFfmpegAvailable()
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-progress', 'pipe:1',
    '-protocol_whitelist', 'file,crypto',
    ...DEMUXER_ARGS,
    '-allowed_extensions', 'm3u8,ts,mp4,bin',
    '-i', inputPlaylistPath,
    ...SUPPORTED_STREAM_MAP_ARGS,
    // H.264 + AAC so the output plays everywhere (VLC, MP) — mirror the
    // known-good script's re-encode flags; yuv420p for max device compatibility.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
    '-f', container === 'mp4' ? 'mp4' : 'matroska',
    '-y',
    outputPartPath,
  ]
  return runFfmpegProcess(args, outputPartPath, { cwd, signal, onProgress, totalDurationSeconds })
}

/**
 * Run ffprobe in JSON mode and return parsed output. Throws FFPROBE_FAILED on
 * non-zero exit or unparseable JSON.
 */
export async function runFfprobe(filePath: string): Promise<Record<string, unknown>> {
  verifyFfmpegAvailable()
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(env.REMOTE_IMPORT_FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new AppError(HLS_ERROR_CODES.FFPROBE_FAILED, HLS_ERROR_MESSAGES.FFPROBE_FAILED, 500))
    })
  })
  try {
    return JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new AppError(HLS_ERROR_CODES.FFPROBE_FAILED, HLS_ERROR_MESSAGES.FFPROBE_FAILED, 500)
  }
}