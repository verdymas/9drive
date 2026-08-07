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
import { env } from '../../../config/env.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'

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
        const err = new AppError(HLS_ERROR_CODES.FFMPEG_NOT_AVAILABLE, `FFmpeg exited with code ${code}.`, 500)
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
  const args = [
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
    '-map', '0',
    '-c', 'copy',
    ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
    // The output path is `output.<ext>.part` — FFmpeg cannot infer the muxer
    // from a `.part` suffix, so the container is pinned explicitly.
    '-f', container === 'mp4' ? 'mp4' : 'matroska',
    '-y',
    outputPartPath,
  ]
  return runFfmpegProcess(args, outputPartPath, { cwd, signal, onProgress, totalDurationSeconds })
}

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
    '-map', '0',
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