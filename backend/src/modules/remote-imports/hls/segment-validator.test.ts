import { describe, expect, it } from 'vitest'
import {
  classifySegment,
  detectTsLayout,
  hasPatPmt,
  selectConcatSegments,
  type SegmentValidation,
  type TsLayout,
} from './segment-validator.js'

/**
 * Synthetic TS fixtures for the segment validator (remux fix tests).
 *
 * We construct MPEG-TS packets by hand instead of shelling out to ffmpeg —
 * the validator is the unit under test, and the byte-level properties it
 * inspects (sync bytes, packet size, PAT/PMT tables) are exactly what
 * hand-rolled bytes can express.
 */
const SYNC = 0x47

/** Build N TS packets with the given payload. Each packet is `packetSize` bytes (sync + header + payload). */
function makeTs(payloads: Buffer[], opts: { packetSize?: 188 | 192 | 204; syncOffset?: number; usePusi?: boolean; pid?: number } = {}): Buffer {
  const packetSize = opts.packetSize ?? 188
  const syncOffset = opts.syncOffset ?? 0
  const pid = opts.pid ?? 0x0000
  const chunks: Buffer[] = []
  for (const payload of payloads) {
    const packet = Buffer.alloc(packetSize)
    if (syncOffset > 0) {
      // M2TS-style prefix — first syncOffset bytes are padding (0xff).
      packet.fill(0xff, 0, syncOffset)
    }
    packet[syncOffset] = SYNC
    // Header byte 1: pusi (1 bit) + transport_priority (1 bit) + pid_high (5 bits).
    // Use 0x40/0x41 to set pusi, then OR-in the real pid high so the result
    // encodes the requested pid exactly.
    const pusiBit = opts.usePusi === false ? 0x00 : 0x40
    packet[syncOffset + 1] = pusiBit | ((pid >> 8) & 0x1f)
    packet[syncOffset + 2] = pid & 0xff
    packet[syncOffset + 3] = 0x10 // AFC=01 (payload only), no adaptation field
    // Copy payload, padding the rest with 0xff. Trim the source to fit.
    const available = packetSize - (syncOffset + 4)
    payload.subarray(0, Math.min(payload.length, available)).copy(packet, syncOffset + 4)
    chunks.push(packet)
  }
  return Buffer.concat(chunks)
}

/**
 * Build a single PAT packet (PID 0x0000) that maps a single program to the
 * given PMT PID. Returns one 188-byte packet.
 */
function makePatPacket(pmtPid: number, programNumber = 1, layoutOpts: { packetSize?: 188 | 192 | 204; syncOffset?: number } = {}): Buffer {
  const section: number[] = [
    0x00, // table_id PAT
    0xb0, 0x0d, // section_syntax_indicator=1, section_length=13
    0x00, 0x01, // transport_stream_id
    0xc1, // version=0, current_next=1
    0x00, 0x00, // section_number, last_section_number
    (programNumber >> 8) & 0xff,
    programNumber & 0xff,
    0xe0 | ((pmtPid >> 8) & 0x1f),
    pmtPid & 0xff,
    // CRC32 placeholder — 4 bytes
    0x00, 0x00, 0x00, 0x00,
  ]
  const payload = Buffer.from([0x00, ...section])
  return makeTs([payload], { pid: 0x0000, ...layoutOpts })
}

/** Build a single PMT packet (PID `pmtPid`) declaring one video stream on `videoPid`. */
function makePmtPacket(pmtPid: number, videoPid = 0x0100, layoutOpts: { packetSize?: 188 | 192 | 204; syncOffset?: number } = {}): Buffer {
  const section: number[] = [
    0x02, // table_id PMT
    0xb0, 0x12, // section_syntax_indicator=1, section_length=18
    0x00, 0x01, // program_number
    0xc1, // version=0, current_next=1
    0x00, 0x00,
    0xe0 | ((pmtPid >> 8) & 0x1f),
    pmtPid & 0xff,
    0xf0, 0x00, // PCR_PID = videoPid
    0x0f, // program_info_length = 0
    0x1b, // stream_type H.264
    0xe0 | ((videoPid >> 8) & 0x1f),
    videoPid & 0xff,
    0xf0, 0x00, // ES_info_length = 0
    0x00, 0x00, 0x00, 0x00, // CRC
  ]
  const payload = Buffer.from([0x00, ...section])
  return makeTs([payload], { pid: pmtPid, ...layoutOpts })
}

function validation(index: number, sizeBytes: number, c: SegmentValidation['classification']): SegmentValidation {
  return { index, sizeBytes, classification: c }
}

describe('detectTsLayout', () => {
  it('returns the standard 188-byte layout for a clean TS stream', () => {
    const buf = makeTs(Array.from({ length: 16 }, () => Buffer.alloc(100, 0xff)))
    const layout = detectTsLayout(buf)
    expect(layout).not.toBeNull()
    expect(layout!.packetSize).toBe(188)
    expect(layout!.syncOffset).toBe(0)
    expect(layout!.syncScore).toBeGreaterThanOrEqual(0.7)
  })

  it('detects M2TS (sync at offset 4) for 192-byte packets', () => {
    const buf = makeTs(Array.from({ length: 16 }, () => Buffer.alloc(100, 0xff)), { packetSize: 192, syncOffset: 4 })
    const layout = detectTsLayout(buf)
    expect(layout).not.toBeNull()
    expect(layout!.packetSize).toBe(192)
    expect(layout!.syncOffset).toBe(4)
  })

  it('detects 204-byte padded TS', () => {
    const buf = makeTs(Array.from({ length: 16 }, () => Buffer.alloc(100, 0xff)), { packetSize: 204, syncOffset: 0 })
    const layout = detectTsLayout(buf)
    expect(layout).not.toBeNull()
    expect(layout!.packetSize).toBe(204)
  })

  it('detects TS even with a garbage prefix before the first sync byte', () => {
    // Real-world segments often begin with a few bytes of garbage, a partial
    // packet, or a timestamp prefix before the first 0x47 sync byte. The
    // detector must anchor on the FIRST sync byte, not buf[0].
    const ts = makeTs(Array.from({ length: 16 }, () => Buffer.alloc(100, 0xff)))
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x47, 0x00]) // contains a stray 0x47 too
    const buf = Buffer.concat([garbage, ts])
    const layout = detectTsLayout(buf)
    expect(layout).not.toBeNull()
    expect(layout!.packetSize).toBe(188)
    expect(layout!.syncOffset).toBe(0)
  })

  it('detects M2TS with a garbage prefix', () => {
    const ts = makeTs(Array.from({ length: 16 }, () => Buffer.alloc(100, 0xff)), { packetSize: 192, syncOffset: 4 })
    const garbage = Buffer.from([0x00, 0x01, 0x02])
    const buf = Buffer.concat([garbage, ts])
    const layout = detectTsLayout(buf)
    expect(layout).not.toBeNull()
    expect(layout!.packetSize).toBe(192)
    expect(layout!.syncOffset).toBe(4)
  })

  it('returns null for random bytes (no sync pattern)', () => {
    const buf = Buffer.alloc(64 * 1024)
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 17) & 0xff
    expect(detectTsLayout(buf)).toBeNull()
  })

  it('returns null for too-short input', () => {
    expect(detectTsLayout(Buffer.alloc(64))).toBeNull()
  })
})

describe('hasPatPmt', () => {
  it('returns true when the stream carries a PAT pointing to a real PMT', () => {
    const layout: TsLayout = { packetSize: 188, syncOffset: 0, syncScore: 0.95 }
    const pat = makePatPacket(0x0100, 1)
    const pmt = makePmtPacket(0x0100, 0x0101)
    // The detector walks at most 512 packets; a 2-packet PAT/PMT must be
    // followed by enough filler so the PMT scan reaches its offset.
    const filler = makeTs(Array.from({ length: 24 }, () => Buffer.alloc(100, 0xff)))
    const buf = Buffer.concat([pat, pmt, filler])
    expect(hasPatPmt(buf, layout)).toBe(true)
  })

  it('returns false when only sync bytes are present (no tables)', () => {
    const layout: TsLayout = { packetSize: 188, syncOffset: 0, syncScore: 0.95 }
    const buf = makeTs(Array.from({ length: 12 }, () => Buffer.alloc(100, 0xff)))
    expect(hasPatPmt(buf, layout)).toBe(false)
  })

  it('returns false when PAT is present but the PMT PID is bogus', () => {
    const layout: TsLayout = { packetSize: 188, syncOffset: 0, syncScore: 0.95 }
    const pat = makePatPacket(0x0100, 1)
    const filler = makeTs(Array.from({ length: 24 }, () => Buffer.alloc(100, 0xff)))
    const buf = Buffer.concat([pat, filler])
    expect(hasPatPmt(buf, layout)).toBe(false)
  })
})

describe('classifySegment', () => {
  it('classifies a valid PAT/PMT-bearing TS stream as mpegts with packetSize=188', () => {
    const pat = makePatPacket(0x0100, 1)
    const pmt = makePmtPacket(0x0100, 0x0101)
    const filler = makeTs(Array.from({ length: 24 }, () => Buffer.alloc(100, 0xff)))
    const buf = Buffer.concat([pat, pmt, filler])
    const c = classifySegment(buf)
    expect(c.kind).toBe('mpegts')
    if (c.kind === 'mpegts') {
      expect(c.layout.packetSize).toBe(188)
      expect(c.hasPatPmt).toBe(true)
    }
  })

  it('classifies M2TS (sync offset 4) as m2ts', () => {
    const m2ts = { packetSize: 192 as const, syncOffset: 4 }
    const pat = makePatPacket(0x0100, 1, m2ts)
    const pmt = makePmtPacket(0x0100, 0x0101, m2ts)
    const filler = makeTs(Array.from({ length: 24 }, () => Buffer.alloc(100, 0xff)), m2ts)
    const buf = Buffer.concat([pat, pmt, filler])
    const c = classifySegment(buf)
    expect(c.kind).toBe('m2ts')
    if (c.kind === 'm2ts') {
      expect(c.layout.packetSize).toBe(192)
      expect(c.layout.syncOffset).toBe(4)
      expect(c.hasPatPmt).toBe(true)
    }
  })

  it('classifies sync-valid TS without PAT/PMT as mpegts with hasPatPmt=false', () => {
    const buf = makeTs(Array.from({ length: 16 }, () => Buffer.alloc(100, 0xff)))
    const c = classifySegment(buf)
    expect(c.kind).toBe('mpegts')
    if (c.kind === 'mpegts') expect(c.hasPatPmt).toBe(false)
  })

  it('rejects an HTML error page', () => {
    const buf = Buffer.from('<!doctype html><html><body>502 Bad Gateway</body></html>', 'latin1')
    const c = classifySegment(buf)
    expect(c.kind).toBe('invalid')
    if (c.kind === 'invalid') expect(c.reason).toBe('html')
  })

  it('rejects a JSON error response', () => {
    const buf = Buffer.from('{"error":"not found"}', 'latin1')
    const c = classifySegment(buf)
    expect(c.kind).toBe('invalid')
    if (c.kind === 'invalid') expect(c.reason).toBe('json')
  })

  it('rejects an XML error response', () => {
    const buf = Buffer.from('<?xml version="1.0"?><Error>403</Error>', 'latin1')
    const c = classifySegment(buf)
    expect(c.kind).toBe('invalid')
    if (c.kind === 'invalid') expect(c.reason).toBe('xml')
  })

  it('rejects empty and too-short buffers', () => {
    expect(classifySegment(Buffer.alloc(0)).kind).toBe('invalid')
    if (Buffer.alloc(0).length === 0) {
      const c = classifySegment(Buffer.alloc(0))
      if (c.kind === 'invalid') expect(c.reason).toBe('empty')
    }
    const tiny = classifySegment(Buffer.alloc(3))
    expect(tiny.kind).toBe('invalid')
    if (tiny.kind === 'invalid') expect(tiny.reason).toBe('too-short')
  })

  it('classifies a real fMP4 init section by its ftyp box', () => {
    // Minimal ftyp box: size(4) + 'ftyp' + major_brand(4) + minor(4) + compatible(4)
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftyp'),
      Buffer.from('isom'),
      Buffer.from([0x00, 0x00, 0x02, 0x00]),
      Buffer.from('isomiso2'),
    ])
    const c = classifySegment(buf)
    expect(c.kind).toBe('fmp4')
    if (c.kind === 'fmp4') expect(c.brand).toBe('isom')
  })

  it('rejects random bytes with no sync pattern as no-sync', () => {
    const buf = Buffer.alloc(8 * 1024)
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 11 + 3) & 0xff
    // Guarantee the buffer has NO 0x47 at any candidate offset.
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 0x47) buf[i] = 0x48
    }
    const c = classifySegment(buf)
    expect(c.kind).toBe('invalid')
    if (c.kind === 'invalid') expect(c.reason).toBe('no-sync')
  })

  it('short-circuits to ciphertext for keyed segments (no signature check)', () => {
    // Random bytes that would normally be classified as no-sync — when the
    // segment is encrypted, the validator must not reject it.
    const buf = Buffer.alloc(8 * 1024, 0x33)
    const c = classifySegment(buf, { encrypted: true })
    expect(c.kind).toBe('ciphertext')
  })
})

describe('selectConcatSegments', () => {
  it('passes through a uniform-packet-size stream with PAT/PMT in segment 1', () => {
    const validations: SegmentValidation[] = [
      validation(1, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
      validation(2, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
    ]
    const out = selectConcatSegments(validations)
    expect(out.payload.map((v) => v.index)).toEqual([1, 2])
    expect(out.dropped).toEqual([])
    expect(out.packetSizes).toEqual([188])
    expect(out.uniform).toBe(true)
  })

  it('drops segments with a mismatched packet size (188 + 192 mix)', () => {
    const validations: SegmentValidation[] = [
      validation(1, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
      validation(2, 1000, { kind: 'mpegts', layout: { packetSize: 192, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
      validation(3, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
    ]
    const out = selectConcatSegments(validations)
    expect(out.payload.map((v) => v.index)).toEqual([1, 3])
    expect(out.dropped).toEqual([2])
    expect(out.packetSizes).toEqual([188, 192])
    expect(out.uniform).toBe(false)
  })

  it('anchors the payload on a PAT/PMT-bearing segment', () => {
    const validations: SegmentValidation[] = [
      validation(1, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: false }),
      validation(2, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: false }),
      validation(3, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
    ]
    const out = selectConcatSegments(validations)
    expect(out.payload.map((v) => v.index)).toEqual([3])
    expect(out.dropped).toEqual([1, 2])
  })

  it('returns an empty payload when nothing qualifies (e.g. fMP4 stream)', () => {
    const validations: SegmentValidation[] = [
      validation(1, 1000, { kind: 'fmp4', brand: 'isom' }),
      validation(2, 1000, { kind: 'fmp4', brand: 'isom' }),
    ]
    const out = selectConcatSegments(validations)
    expect(out.payload).toEqual([])
    expect(out.dropped).toEqual([1, 2])
    expect(out.packetSizes).toEqual([])
    expect(out.uniform).toBe(false)
  })

  it('excludes invalid / ciphertext segments', () => {
    const validations: SegmentValidation[] = [
      validation(1, 1000, { kind: 'invalid', reason: 'html' }),
      validation(2, 1000, { kind: 'ciphertext' }),
      validation(3, 1000, { kind: 'mpegts', layout: { packetSize: 188, syncOffset: 0, syncScore: 0.95 }, hasPatPmt: true }),
    ]
    const out = selectConcatSegments(validations)
    expect(out.payload.map((v) => v.index)).toEqual([3])
    expect(out.dropped).toEqual([1, 2])
  })
})
