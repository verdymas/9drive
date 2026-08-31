/**
 * HLS segment validation (remux-reliability fix §2–§4).
 *
 * Pure, dependency-free MPEG-TS inspection used at two gates:
 *
 *  1. Download gate (materialize.ts): reject error-page artifacts (HTML/JSON/
 *     XML/empty) that can never be media payload, with a safe per-segment
 *     debug log. The STRICT signature check is deliberately NOT here — a
 *     valid segment may be fMP4, AAC/ADTS, or an unkeyed non-TS payload the
 *     HLS demuxer handles natively, so this layer only stops obvious garbage.
 *  2. Concat gate (ffmpeg.ts): a segment must be a real standalone MPEG-TS
 *     payload (or M2TS) before it may enter the raw concatenation — no blind
 *     `cat *.ts`. Mixing packet sizes (188/192/204) is the classic killer of
 *     a forced `-f mpegts` demux ("changing packet size … could not find
 *     codec parameters"), so the concat payload is restricted to ONE packet
 *     size and must START on a segment that carries PAT/PMT — the codec
 *     parameters live there.
 *
 * Everything here is pure (buffer in → classification out); file I/O lives in
 * `validateSegmentFile`. Nothing logs URLs, local paths, cookies or secrets.
 */
import fsp from 'node:fs/promises'
import { AppError } from '../../../utils/app-error.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './errors.js'

const SYNC_BYTE = 0x47
const HEAD_SCAN_BYTES = 64 * 1024
const MAX_PACKETS_SCANNED = 512
/** Minimum sync-byte hits before a layout is accepted. */
const MIN_SYNC_HITS = 4
/** Minimum sync-byte ratio before a layout is accepted. */
const MIN_SYNC_RATIO = 0.7

export type TsLayout = {
  packetSize: 188 | 192 | 204 | 208
  /** Offset of the 0x47 sync byte within each packet (0 for raw TS, 4 for M2TS). */
  syncOffset: number
  /** Absolute byte offset of the first complete packet boundary.
   *  Packet k starts at `baseOffset + k * packetSize`.
   *  The sync byte for packet k is at `baseOffset + syncOffset + k * packetSize`. */
  baseOffset: number
  /** Fraction of packets whose sync byte matched 0x47 (0..1). */
  syncScore: number
}

export type SegmentClassification =
  | { kind: 'mpegts'; layout: TsLayout; hasPatPmt: boolean }
  | { kind: 'm2ts'; layout: TsLayout; hasPatPmt: boolean }
  | { kind: 'fmp4'; brand: string }
  /** fMP4 media fragment (starts with `moof`) — not standalone TS, not init. */
  | { kind: 'moof' }
  /** Keyed (AES-128) segment — raw bytes are ciphertext, nothing to check. */
  | { kind: 'ciphertext' }
  | { kind: 'invalid'; reason: 'empty' | 'html' | 'json' | 'xml' | 'no-sync' | 'too-short' }

export type SegmentValidation = {
  /** 1-based segment index (matches NormalizedSegment.index / local names). */
  index: number
  sizeBytes: number
  classification: SegmentClassification
}

// Candidate (packetSize, syncOffset) layouts, best-first: standard 188,
// padded 192/204/208 with the sync at 0, then the M2TS variants where a
// 4-byte timestamp prefix pushes the sync byte to offset 4.
const LAYOUT_CANDIDATES: Array<{ packetSize: TsLayout['packetSize']; syncOffset: number }> = [
  { packetSize: 188, syncOffset: 0 },
  { packetSize: 192, syncOffset: 0 },
  { packetSize: 204, syncOffset: 0 },
  { packetSize: 208, syncOffset: 0 },
  { packetSize: 192, syncOffset: 4 },
  { packetSize: 208, syncOffset: 4 },
]

/**
 * Detect the dominant MPEG-TS packet layout by scanning every candidate stride
 * and base offset for the best 0x47 sync hit rate over the first 64 KiB. This
 * mirrors FFmpeg's mpegts demuxer approach: scan for sync, check consecutive
 * syncs at the stride, lock onto the alignment with the highest score.
 *
 * The key difference from the original code: it scans ALL candidate base
 * offsets (not just assuming sync starts at byte 0), applies syncOffset when
 * checking sync bytes (so M2TS at offset 4 is checked at buf[base+4+k*stride],
 * not buf[base+k*stride]), and requires 2 consecutive sync bytes to lock
 * before scoring (preventing false positives on stray 0x47 bytes).
 */
export function detectTsLayout(buf: Buffer): TsLayout | null {
  const scanLength = Math.min(buf.length, HEAD_SCAN_BYTES)
  if (scanLength < 64) return null

  let best: TsLayout | null = null
  let bestHits = 0

  for (const { packetSize, syncOffset } of LAYOUT_CANDIDATES) {
    // For each candidate (packetSize, syncOffset), scan every possible base
    // offset within the first 4096 bytes. The base is the absolute position
    // of the first complete packet boundary — the sync byte sits at
    // base + syncOffset.
    const maxBase = Math.min(scanLength - packetSize, 4096)
    for (let base = 0; base <= maxBase; base += 1) {
      // The sync byte for this candidate is at `base + syncOffset`.
      const syncPos = base + syncOffset
      if (buf[syncPos] !== SYNC_BYTE) continue

      // Require 2 consecutive syncs at the stride to lock onto this alignment.
      const sync2 = syncPos + packetSize
      if (sync2 >= scanLength || buf[sync2] !== SYNC_BYTE) continue

      // Full scan: count hits from the aligned base.
      const fullPackets = Math.floor((scanLength - base) / packetSize)
      if (fullPackets < 2) continue
      let hits = 0
      for (let k = 0; k < fullPackets; k += 1) {
        if (buf[base + syncOffset + k * packetSize] === SYNC_BYTE) hits += 1
      }
      if (hits < MIN_SYNC_HITS) continue
      const score = hits / fullPackets
      if (score < MIN_SYNC_RATIO) continue
      // Strictly greater hits: the candidate order breaks ties, keeping the
      // more standard layout (earlier in LAYOUT_CANDIDATES) when two
      // alignments both fit.
      if (hits > bestHits) {
        best = { packetSize, syncOffset, baseOffset: base, syncScore: score }
        bestHits = hits
      }
    }
  }
  return best
}

/**
 * True when the buffer contains a PAT (PID 0x0000, table_id 0x00) AND a
 * matching PMT (table_id 0x02 on a PID the PAT maps). Codec parameters are
 * carried in the PAT/PMT — a TS payload without them makes FFmpeg report
 * "could not find codec parameters".
 */
export function hasPatPmt(buf: Buffer, layout: TsLayout): boolean {
  const { packetSize, syncOffset, baseOffset = 0 } = layout
  if (buf.length - baseOffset < packetSize) return false
  const packetCount = Math.min(MAX_PACKETS_SCANNED, Math.floor((buf.length - baseOffset) / packetSize))

  const pmtPids = new Set<number>()
  for (let k = 0; k < packetCount; k += 1) {
    const p = baseOffset + k * packetSize
    // Sync byte at p + syncOffset; header bytes start at p + syncOffset + 1.
    if (buf[p + syncOffset] !== SYNC_BYTE) continue
    const h = p + syncOffset // header base
    const pusi = (buf[h + 1] >> 6) & 1
    if (!pusi) continue
    const pid = ((buf[h + 1] & 0x1f) << 8) | buf[h + 2]
    if (pid !== 0x0000) continue
    const payload = sectionPayloadStart(buf, h, packetSize)
    if (payload < 0) continue
    const section = payload + 1 + buf[payload] // pointer_field
    if (section + 7 >= h + packetSize) continue
    if (buf[section] !== 0x00) continue // table_id PAT
    const sectionLength = ((buf[section + 1] & 0x0f) << 8) | buf[section + 2]
    // Entries start after the 8-byte section header; the section ends at
    // 3 + section_length, the last 4 bytes being the CRC.
    const entriesEnd = Math.min(section + 3 + sectionLength - 4, h + packetSize - 2)
    for (let e = section + 8; e + 3 < entriesEnd; e += 4) {
      const programNumber = (buf[e] << 8) | buf[e + 1]
      const pmtPid = ((buf[e + 2] & 0x1f) << 8) | buf[e + 3]
      if (programNumber !== 0) pmtPids.add(pmtPid)
    }
  }
  if (pmtPids.size === 0) return false

  // Confirm at least one PMT packet (matching PID, table_id 0x02).
  for (let k = 0; k < packetCount; k += 1) {
    const p = baseOffset + k * packetSize
    const h = p + syncOffset
    if (buf[h] !== SYNC_BYTE) continue
    const pid = ((buf[h + 1] & 0x1f) << 8) | buf[h + 2]
    if (!pmtPids.has(pid)) continue
    if (((buf[h + 1] >> 6) & 1) === 0) continue
    const payload = sectionPayloadStart(buf, h, packetSize)
    if (payload < 0) continue
    const section = payload + 1 + buf[payload]
    if (section < h + packetSize && buf[section] === 0x02) return true
  }
  return false
}

/** Start of the packet payload (after header + adaptation field), or -1. */
function sectionPayloadStart(buf: Buffer, p: number, packetSize: number): number {
  const afc = (buf[p + 3] >> 4) & 0x03
  if (afc === 0) return -1
  let payload = p + 4
  if (afc === 2) return -1 // adaptation-only, no payload
  if (afc === 3) payload = p + 5 + buf[p + 4]
  return payload < p + packetSize ? payload : -1
}

/**
 * Classify a segment's raw bytes. `encrypted` (keyed segment) short-circuits
 * every signature check — ciphertext has no structure to validate.
 */
export function classifySegment(buf: Buffer, opts: { encrypted?: boolean } = {}): SegmentClassification {
  if (opts.encrypted) return { kind: 'ciphertext' }
  if (buf.length === 0) return { kind: 'invalid', reason: 'empty' }
  if (buf.length < 4) return { kind: 'invalid', reason: 'too-short' }

  // Error-page sniffing: an HTML/XML/JSON error response can never be media.
  // Trim a UTF-8 BOM + leading whitespace before matching (both occur in the
  // wild before the real first byte).
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1').replace(/^\uFEFF/, '').trimStart()
  const lower = head.slice(0, 128).toLowerCase()
  if (/^<!doctype html/i.test(lower) || /^<html[\s>]/i.test(lower) || /^<head[\s>]/i.test(lower) || /^<body[\s>]/i.test(lower)) {
    return { kind: 'invalid', reason: 'html' }
  }
  if (/^<\?xml/i.test(lower)) return { kind: 'invalid', reason: 'xml' }
  if (head.startsWith('{') || head.startsWith('[')) return { kind: 'invalid', reason: 'json' }

  // fMP4 init maps start with an ISO-BMFF `ftyp` box; media fragments are
  // `moof`/`mdat` and legitimately fall through to no-sync.
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1').replace(/\0.*$/, '')
    return { kind: 'fmp4', brand }
  }

  // fMP4 media fragments start with `moof` (movie fragment) — a real HLS
  // segment in fMP4 format. Without this, a common fMP4 stream would be
  // misclassified as `no-sync` and silently dropped from the concat payload
  // (concatenating raw fMP4 fragments is wrong anyway, but the HLS demuxer
  // handles them natively, so the concat path should never be reached for
  // fMP4 in the first place — the detection here is diagnostic only).
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'moof') {
    return { kind: 'moof' }
  }

  const layout = detectTsLayout(buf)
  if (!layout) return { kind: 'invalid', reason: 'no-sync' }
  const patPmt = hasPatPmt(buf, layout)
  return layout.syncOffset === 0 ? { kind: 'mpegts', layout, hasPatPmt: patPmt } : { kind: 'm2ts', layout, hasPatPmt: patPmt }
}

/**
 * Read a segment file's head (first 64 KiB) + size and classify it. The head
 * is sufficient for layout/PAT-PMT detection — full-body reads happen only in
 * the concat payload assembly.
 */
export async function validateSegmentFile(filePath: string, opts: { index?: number; encrypted?: boolean } = {}): Promise<SegmentValidation> {
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(filePath, 'r')
    const head = Buffer.alloc(Math.min(HEAD_SCAN_BYTES, 65536))
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const stats = await handle.stat()
    return {
      index: opts.index ?? 0,
      sizeBytes: stats.size,
      classification: classifySegment(head.subarray(0, bytesRead), { encrypted: opts.encrypted }),
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(HLS_ERROR_CODES.HLS_SEGMENT_INVALID, HLS_ERROR_MESSAGES.HLS_SEGMENT_INVALID, 500)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export type ConcatSelection = {
  /** Validated, single-packet-size, PAT/PMT-anchored segments (in order). */
  payload: SegmentValidation[]
  /** Indexes excluded from the payload (invalid, mismatched, or no PAT/PMT). */
  dropped: number[]
  /** Distinct packet sizes seen across the valid TS segments. */
  packetSizes: number[]
  /** True when every valid TS segment shared one packet size. */
  uniform: boolean
}

/**
 * Pure decision logic for the raw-concat gate. The payload:
 *  - contains only segments classified as standalone TS (`mpegts`/`m2ts`),
 *  - is restricted to the MOST COMMON packet size (mixed 188/192/204 breaks
 *    the forced `-f mpegts` demux — mismatched segments are dropped, never
 *    concatenated),
 *  - starts on the earliest segment that carries PAT/PMT (without it the
 *    demuxer reports "could not find codec parameters").
 */
export function selectConcatSegments(validations: SegmentValidation[]): ConcatSelection {
  const dropped: number[] = []
  const ts = validations.filter((v) => {
    const isTs = v.classification.kind === 'mpegts' || v.classification.kind === 'm2ts'
    if (!isTs) dropped.push(v.index)
    return isTs
  }) as Array<SegmentValidation & { classification: { kind: 'mpegts' | 'm2ts'; layout: TsLayout; hasPatPmt: boolean } }>

  if (ts.length === 0) return { payload: [], dropped, packetSizes: [], uniform: false }

  // Mode (most common) packet size. sort() is stable — ties keep the
  // first-seen size, which matches the stream's dominant layout.
  const counts = new Map<number, number>()
  for (const v of ts) counts.set(v.classification.layout.packetSize, (counts.get(v.classification.layout.packetSize) ?? 0) + 1)
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const packetSizes = [...counts.keys()]
  const uniform = packetSizes.length === 1

  const payload: typeof ts = []
  for (const v of ts) {
    if (v.classification.layout.packetSize !== mode) {
      dropped.push(v.index)
      continue
    }
    payload.push(v)
  }

  // Anchor the payload on a PAT/PMT-bearing segment — skip the leading
  // segments that cannot provide codec parameters.
  while (payload.length > 0 && !payload[0].classification.hasPatPmt) {
    dropped.push(payload[0].index)
    payload.shift()
  }

  return { payload, dropped, packetSizes, uniform }
}
