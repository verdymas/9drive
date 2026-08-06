import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/env.js'

/**
 * Temp-file storage for Remote Import.
 *
 * Downloads land on the worker's local disk (shared volume when containerized)
 * under `REMOTE_IMPORT_TEMP_DIR` before being uploaded to the destination
 * account. Files are keyed by import id; a stale sweep removes files older
 * than `REMOTE_IMPORT_TEMP_RETENTION_HOURS` (default 24h) — the cancel/cleanup
 * path also deletes the temp file eagerly.
 */
export function tempDir() {
  return path.resolve(env.REMOTE_IMPORT_TEMP_DIR)
}

export async function ensureTempDir() {
  await fsp.mkdir(tempDir(), { recursive: true })
}

export function tempFilePath(importId: string) {
  return path.join(tempDir(), `${importId}.part`)
}

export function finalTempFilePath(importId: string) {
  return path.join(tempDir(), `${importId}.download`)
}

export async function removeTempFile(importId: string) {
  for (const file of [tempFilePath(importId), finalTempFilePath(importId)]) {
    await fsp.rm(file, { force: true }).catch(() => undefined)
  }
}

/** Remove temp files for imports that completed/cancelled/failed before `cutoff`. */
export async function sweepStaleTempFiles(cutoff: Date) {
  await ensureTempDir()
  const entries = await fsp.readdir(tempDir(), { withFileTypes: true })
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.part') && !entry.name.endsWith('.download')) continue
    const filePath = path.join(tempDir(), entry.name)
    try {
      const stats = await fsp.stat(filePath)
      if (stats.mtimeMs < now && stats.mtimeMs < cutoff.getTime()) {
        await fsp.rm(filePath, { force: true })
      }
    } catch {
      /* raced with an active download; skip */
    }
  }
}

export function startTempSweeper(intervalMs = 60 * 60 * 1000) {
  const timer = setInterval(() => {
    const cutoff = new Date(Date.now() - env.REMOTE_IMPORT_TEMP_RETENTION_HOURS * 60 * 60 * 1000)
    void sweepStaleTempFiles(cutoff).catch((err) => console.error('[remote-import] temp sweeper failed:', err))
  }, intervalMs)
  timer.unref()
  return timer
}

/** Create the temp part file (fresh, truncating any leftover). */
export async function createTempPartFile(importId: string): Promise<string> {
  await ensureTempDir()
  const filePath = tempFilePath(importId)
  await fsp.writeFile(filePath, Buffer.alloc(0), { flag: 'w' })
  return filePath
}

/** fs.promises wrapper returning an appendable stream (no global state). */
export function appendStreamToTemp(filePath: string) {
  return fs.createWriteStream(filePath, { flags: 'a' })
}
