/**
 * HLS job-directory management (§6).
 *
 * Layout: `REMOTE_IMPORT_TEMP_DIR/{userId}/{jobId}/` — everything for one HLS
 * import lives under this root. Cleanup removes the whole job directory and
 * never touches anything outside the configured temporary root.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../../config/env.js'
import { tempDir } from '../temp-storage.js'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'

export function hlsJobDir(userId: string, importId: string): string {
  const root = path.resolve(tempDir())
  const jobDir = path.join(root, userId, importId)
  const resolved = path.resolve(jobDir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'Invalid job directory.', 500)
  }
  return resolved
}

/** Persisted state file for retry/resume of a partially-materialized import. */
export function jobStatePath(jobDir: string): string {
  return path.join(jobDir, 'job-state.json')
}

export type JobState = {
  version: 1
  importId: string
  playlistUrl: string
  selectedVariantId: string | null
  audioTrackId: string | null
  outputContainer: string
  /** Absolute local paths of completed segments, in order. */
  completedSegments: string[]
  /** Total bytes downloaded so far. */
  downloadedBytes: string
  /** True once the rewritten playlist has been written. */
  playlistWritten: boolean
  /** True once remuxing has completed (upload-only retry). */
  remuxComplete: boolean
}

export async function readJobState(jobDir: string): Promise<JobState | null> {
  try {
    const raw = await fsp.readFile(jobStatePath(jobDir), 'utf8')
    const parsed = JSON.parse(raw) as JobState
    return parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}

export async function writeJobState(jobDir: string, state: JobState): Promise<void> {
  await fsp.writeFile(jobStatePath(jobDir), JSON.stringify(state), { mode: 0o600 })
}

/**
 * Resume marker for a "retry convert only" (remux-only) HLS import.
 *
 * Written into the job directory when the remux/verify step fails so a
 * convert-only retry can resume at the remux step — reusing the already
 * materialized segments instead of re-downloading them. `version` gates reads
 * so a future schema change can refuse stale markers cleanly.
 */
export type HlsResumeMarker = {
  version: 1
  mode: 'remux-only'
  /** Final media (video) playlist URL — re-fetched on resume to derive segment URIs. */
  playlistUrl: string
  /** Alternate audio playlist URL, or null when the video muxes its own audio. */
  audioPlaylistUrl: string | null
  /** Container resolved at failure — the resume honours the original selection. */
  container: 'mkv' | 'mp4'
  /** True when the output is expected to carry audio (from source type / audio track). */
  expectAudio: boolean
  mediaDurationSeconds: number
}

export function resumeMarkerPath(jobDir: string): string {
  return path.join(jobDir, 'resume.json')
}

export async function readResumeMarker(jobDir: string): Promise<HlsResumeMarker | null> {
  try {
    const raw = await fsp.readFile(resumeMarkerPath(jobDir), 'utf8')
    const parsed = JSON.parse(raw) as HlsResumeMarker
    return parsed?.version === 1 && parsed.mode === 'remux-only' ? parsed : null
  } catch {
    return null
  }
}

export async function writeResumeMarker(jobDir: string, marker: HlsResumeMarker): Promise<void> {
  // The job dir was created via ensureJobDir() before the pipeline ran; the
  // containment check below mirrors removeJobDir — never write outside the
  // configured temporary root.
  const root = path.resolve(tempDir())
  const resolved = path.resolve(jobDir)
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'Invalid job directory.', 500)
  }
  await fsp.mkdir(jobDir, { recursive: true, mode: 0o700 })
  await fsp.writeFile(resumeMarkerPath(jobDir), JSON.stringify(marker), { mode: 0o600 })
}

/**
 * Drop the resume marker. Used after a successful convert-only retry so the
 * caller's job-dir cleanup (which keeps the dir only while a marker exists)
 * removes the now-unneeded scratch directory.
 */
export async function removeResumeMarker(jobDir: string): Promise<void> {
  await fsp.rm(resumeMarkerPath(jobDir), { force: true }).catch(() => undefined)
}

/** Recursively remove the job directory; never touches anything else. */
export async function removeJobDir(jobDir: string): Promise<void> {
  const root = path.resolve(tempDir())
  const resolved = path.resolve(jobDir)
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    // Safety: only ever delete inside the temp root.
    throw new AppError(HLS_ERROR_CODES.HLS_OUTPUT_INVALID, 'Refusing to remove outside the temp root.', 500)
  }
  await fsp.rm(resolved, { recursive: true, force: true }).catch(() => undefined)
}

export { tempDir, ensureTempDir, sweepStaleTempFiles } from '../temp-storage.js'
