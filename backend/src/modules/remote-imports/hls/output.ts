/**
 * Output-container selection for HLS remote imports (§14 of the spec).
 *
 * Rules:
 *  - `auto` (default): stream-copy, prefer MP4 only when all selected streams
 *    are compatible; prefer MKV when there are separate audio tracks,
 *    subtitles, discontinuities, or uncertain container compatibility.
 *  - If Automatic picks MP4 and stream-copy muxing fails for container
 *    compatibility, the worker retries once with MKV.
 *  - A user-selected MP4 is never silently changed to MKV.
 *  - The final stored filename extension must match the actual output
 *    container — never a duplicate extension.
 */
export type ContainerChoice = 'auto' | 'mkv' | 'mp4'

export type ContainerEligibility = {
  hasSeparateAudio: boolean
  hasSubtitles: boolean
  hasDiscontinuities: boolean
}

export function resolveContainer(requested: ContainerChoice, eligibility: ContainerEligibility): 'mkv' | 'mp4' {
  if (requested === 'mkv') return 'mkv'
  if (requested === 'mp4') return 'mp4'
  return recommendContainer(eligibility)
}

/**
 * Automatic selection (§3): MKV is the DEFAULT HLS output container. MKV is
 * more tolerant of stream-copy combinations (raw MPEG-TS, fMP4 fragments,
 * separate audio, subtitles, discontinuities) and plays better with Jellyfin.
 * The old behaviour tried MP4 first and only fell back on mux failure — the
 * refactor spec mandates MKV first and never attempting MP4 first.
 */
export function recommendContainer(_eligibility: ContainerEligibility): 'mkv' | 'mp4' {
  return 'mkv'
}

export function containerExtension(container: 'mkv' | 'mp4'): string {
  return container
}

/**
 * Derive the output file name for a remuxed HLS import.
 *
 * Rules (§14):
 *  - a name that ALREADY ends in the output extension is kept as-is (never a
 *    double extension),
 *  - a `.m3u8`/`.m3u` suffix is replaced by the output extension,
 *  - otherwise the extension is appended once.
 *
 * NOTE: this name is METADATA-ONLY. It describes the remuxed output for
 * diagnostics/UI, but the processor never uses it as the canonical filename —
 * the persisted `remote_imports.fileName` is authoritative and is what the
 * provider upload and the `File.name` registration receive (see processor.ts).
 */
export function hlsDerivedFileName(fileName: string, extension: string): string {
  if (fileNameHasExtension(fileName, extension)) return fileName
  const base = fileName.replace(/\.(m3u8|m3u)$/i, '')
  const clean = base.trim().replace(/\.+$/, '')
  return `${clean || 'video'}.${extension}`
}

/** True when the filename already ends with the requested extension (case-insensitive). */
export function fileNameHasExtension(fileName: string, extension: string): boolean {
  return new RegExp(`\\.${extension.replace(/[^a-z0-9]/gi, '')}$`, 'i').test(fileName)
}

/** True when automatic MP4 should be reconsidered after a mux failure. */
export function shouldAutoFallbackToMkv(requested: ContainerChoice): boolean {
  return requested === 'auto'
}