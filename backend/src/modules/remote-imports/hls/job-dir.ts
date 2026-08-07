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
