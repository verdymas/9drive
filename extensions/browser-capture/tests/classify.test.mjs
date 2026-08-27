/**
 * Classification tests — plain assert-based, runnable with `node tests/run.js`
 * (no framework needed; mirrors the backend's self-check convention).
 */
import assert from 'node:assert/strict'
import {
  classifyResource, filenameFromUrl, detectFilename, groupCaptures,
  parseContentDispositionFilename, displayTypeFor, extractQuality, estimateSize,
} from '../src/classify.js'

const cases = [
  // [url, mime, expected type, expected sub]
  ['https://cdn.example.com/video/master.m3u8', null, 'hls', 'manifest'],
  ['https://cdn.example.com/video/index.m3u8?token=abc', null, 'hls', 'manifest'],
  ['https://cdn.example.com/stream.mpd', null, 'dash', 'manifest'],
  ['https://cdn.example.com/video/master.m3u8', 'application/vnd.apple.mpegurl', 'hls', 'manifest'],
  ['https://cdn.example.com/movie.mp4?sig=secret', null, 'video', null],
  ['https://cdn.example.com/movie.mp4', 'video/mp4', 'video', null],
  ['https://cdn.example.com/clip.webm', null, 'video', null],
  ['https://cdn.example.com/doc.pdf', null, 'document', null],
  ['https://cdn.example.com/doc.pdf', 'application/pdf', 'document', null],
  ['https://cdn.example.com/report.docx', null, 'document', null],
  // Suppressed: segments and media internals
  ['https://cdn.example.com/hls/seg-0001.ts', null, null, null],
  ['https://cdn.example.com/hls/chunk.m4s', null, null, null],
  ['https://cdn.example.com/subs/en.vtt', null, null, null],
  ['https://cdn.example.com/video.key', null, null, null],
  // Not capturable
  ['https://example.com/', 'text/html', null, null],
  ['https://example.com/image.png', 'image/png', null, null],
  ['ftp://x/file.mp4', null, null, null],
  ['javascript:alert(1)', null, null, null],
]

let pass = 0
for (const [url, mime, wantType, wantSub] of cases) {
  const got = classifyResource(url, mime)
  const actual = got ? [got.type, got.sub] : [null, null]
  assert.deepEqual(actual, [wantType, wantSub], `${url} (${mime})`)
  pass++
}

// Filename rules: path wins; query NEVER leaks into a name.
assert.equal(filenameFromUrl('https://x.example.com/a/b/movie.mp4?sig=zzz'), 'movie.mp4')
assert.equal(filenameFromUrl('https://x.example.com/'), '')
assert.equal(detectFilename({ url: 'https://x.example.com/v/film.m3u8?t=1' }), 'film.m3u8')
pass += 3

// ── Content-Disposition filename parsing ────────────────────────────────────

assert.equal(parseContentDispositionFilename('attachment; filename="movie.mp4"'), 'movie.mp4')
assert.equal(parseContentDispositionFilename('attachment; filename=video.mkv'), 'video.mkv')
assert.equal(parseContentDispositionFilename('inline; filename="doc.pdf"'), 'doc.pdf')
assert.equal(parseContentDispositionFilename(null), null)
assert.equal(parseContentDispositionFilename(''), null)
// filename* (RFC 5987) is intentionally skipped — returns null
assert.equal(parseContentDispositionFilename("attachment; filename*=UTF-8''movie.mp4"), null)
pass += 6

// ── detectFilename with Content-Disposition ─────────────────────────────────

assert.equal(
  detectFilename({ url: 'https://x.com/old.m3u8', contentDisposition: 'attachment; filename="movie.mp4"' }),
  'movie.mp4',
)
assert.equal(
  detectFilename({ url: 'https://x.com/path/file', contentDisposition: 'attachment; filename="doc.pdf"' }),
  'doc.pdf',
)
// No Content-Disposition falls back to URL
assert.equal(
  detectFilename({ url: 'https://x.com/video.mp4', contentDisposition: null }),
  'video.mp4',
)
// Content-Disposition overrides generic HLS manifest names
assert.equal(
  detectFilename({ url: 'https://cdn.com/master.m3u8', contentDisposition: 'attachment; filename="Show S01E01.mp4"' }),
  'Show S01E01.mp4',
)
// Generic HLS name without Content-Disposition falls through to page title
assert.equal(
  detectFilename({ url: 'https://cdn.com/master.m3u8', contentDisposition: null, pageTitle: 'My Cool Show' }),
  'My Cool Show',
)
// Generic HLS name without anything falls back to URL name
assert.equal(
  detectFilename({ url: 'https://cdn.com/master.m3u8', contentDisposition: null }),
  'master.m3u8',
)
pass += 6

// ── Display type normalization ──────────────────────────────────────────────

assert.equal(displayTypeFor('hls', null), 'HLS Stream')
assert.equal(displayTypeFor('dash', null), 'MPEG-DASH')
assert.equal(displayTypeFor('video', null), 'Video')
assert.equal(displayTypeFor('document', 'application/pdf'), 'PDF Document')
assert.equal(displayTypeFor('document', 'application/msword'), 'Document')
assert.equal(displayTypeFor('document', null), 'Document')
assert.equal(displayTypeFor('unknown', null), 'Unknown')
assert.equal(displayTypeFor('audio', null), 'Audio')
pass += 8

// ── Quality extraction ──────────────────────────────────────────────────────

assert.equal(extractQuality('1080.m3u8'), '1080p')
assert.equal(extractQuality('720p_video.mp4'), '720p')
assert.equal(extractQuality('master.m3u8'), null)
assert.equal(extractQuality('movie.mp4'), null)
assert.equal(extractQuality(null), null)
assert.equal(extractQuality(''), null)
pass += 6

// ── Size estimation ─────────────────────────────────────────────────────────

// Normal file with content-length
assert.equal(estimateSize({ type: 'video', contentLength: 1234567 }), 1234567)
// Null content-length
assert.equal(estimateSize({ type: 'video', contentLength: null }), null)
// HLS with duration + bandwidth
assert.equal(estimateSize({ type: 'hls', hls: { durationSeconds: 120, bandwidth: 2000000 } }), 30000000)
// HLS without metadata
assert.equal(estimateSize({ type: 'hls', hls: {} }), null)
// HLS with duration but no bandwidth
assert.equal(estimateSize({ type: 'hls', hls: { durationSeconds: 120 } }), null)
// Non-HLS with string content-length
assert.equal(estimateSize({ type: 'video', contentLength: '1048576' }), 1048576)
pass += 6

// ── Grouping ─────────────────────────────────────────────────────────────────

function cap(data) {
  return { id: crypto.randomUUID(), status: 'detected', ts: Date.now(), filename: 'file.mp4', ...data }
}

// Single non-HLS
const g1 = groupCaptures([cap({ id: 'a', type: 'video' })])
assert.equal(g1.length, 1)
assert.equal(g1[0].type, 'single')

// HLS variants from same page → group
const g2 = groupCaptures([
  cap({ id: 'p', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/master.m3u8', ts: 10 }),
  cap({ id: 'v', type: 'hls', filename: '720.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/720.m3u8', ts: 5 }),
])
assert.equal(g2.length, 1)
assert.equal(g2[0].type, 'hls-group')
assert.equal(g2[0].variants.length, 2)

// Different pages → separate single groups (lone HLS is a single, not a group)
const g3 = groupCaptures([
  cap({ id: 'a', type: 'hls', pageUrl: 'https://s.com/a' }),
  cap({ id: 'b', type: 'hls', pageUrl: 'https://s.com/b' }),
])
assert.equal(g3.length, 2)
assert.ok(g3.every((g) => g.type === 'single'))

// Mixed types → no grouping
const g4 = groupCaptures([
  cap({ id: 'a', type: 'video', pageUrl: 'https://s.com/' }),
  cap({ id: 'b', type: 'document', pageUrl: 'https://s.com/' }),
])
assert.equal(g4.length, 2)
assert.ok(g4.every((g) => g.type === 'single'))

// Expired/consumed captures filtered out.
const g5 = groupCaptures([
  cap({ id: 'x', type: 'video', status: 'expired' }),
  cap({ id: 'y', type: 'hls', status: 'consumed', pageUrl: 'https://x.com/' }),
])
assert.equal(g5.length, 0, 'all consumed/expired → empty')

// Quality sorting: 720 < 1080 in variants array (primary stays first).
const g6 = groupCaptures([
  cap({ id: 'p', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/master.m3u8', ts: 10 }),
  cap({ id: 'lo', type: 'hls', filename: '360.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/360.m3u8', ts: 5 }),
  cap({ id: 'hi', type: 'hls', filename: '1080.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/1080.m3u8', ts: 8 }),
])
assert.equal(g6[0].variants[0].id, 'p', 'primary first')
assert.equal(g6[0].variants[1].id, 'lo', '360 before 1080')
assert.equal(g6[0].variants[2].id, 'hi', '1080 after 360')

const groupPass = 10

console.log(`classify: ${pass + groupPass} checks passed`)