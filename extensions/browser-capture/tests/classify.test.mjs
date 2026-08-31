/**
 * Classification tests — plain assert-based, runnable with `node tests/run.js`
 * (no framework needed; mirrors the backend's self-check convention).
 */
import assert from 'node:assert/strict'
import {
  classifyResource, filenameFromUrl, detectFilename, groupCaptures,
  parseContentDispositionFilename, displayTypeFor, extractQuality, estimateSize,
  urlQualityLabel,
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
  // Audio
  ['https://cdn.example.com/song.mp3', null, 'audio', null],
  ['https://cdn.example.com/track.flac', null, 'audio', null],
  ['https://cdn.example.com/podcast.mp3', 'audio/mpeg', 'audio', null],
  // Archive
  ['https://cdn.example.com/bundle.zip', null, 'archive', null],
  ['https://cdn.example.com/backup.tar.gz', null, 'archive', null],
  ['https://cdn.example.com/bundle.rar', 'application/x-rar-compressed', 'archive', null],
  // Image
  ['https://cdn.example.com/pic.png', null, 'image', null],
  ['https://cdn.example.com/photo.jpg', 'image/jpeg', 'image', null],
  ['https://cdn.example.com/favicon.ico', null, 'image', null],
  // Other (gated by the "Other Files" filter)
  ['https://cdn.example.com/setup.exe', null, 'other', null],
  ['https://cdn.example.com/data.csv', null, 'other', null],
  ['https://cdn.example.com/font.woff2', null, 'other', null],
  // Suppressed: segments and media internals
  ['https://cdn.example.com/hls/seg-0001.ts', null, null, null],
  ['https://cdn.example.com/hls/chunk.m4s', null, null, null],
  ['https://cdn.example.com/subs/en.vtt', null, null, null],
  ['https://cdn.example.com/video.key', null, null, null],
  // Not capturable
  ['https://example.com/', 'text/html', null, null],
  ['https://example.com/page.html', 'text/html', null, null],
  ['https://example.com/', 'application/json', null, null],
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
// filename* (RFC 5987) now supported by the shared filename-resolver parser
assert.equal(parseContentDispositionFilename("attachment; filename*=UTF-8''movie.mp4"), 'movie.mp4')
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
assert.equal(displayTypeFor('audio', null), 'Audio')
assert.equal(displayTypeFor('image', null), 'Image')
assert.equal(displayTypeFor('archive', null), 'Archive')
assert.equal(displayTypeFor('other', null), 'Other')
assert.equal(displayTypeFor('document', 'application/pdf'), 'PDF Document')
assert.equal(displayTypeFor('document', 'application/msword'), 'Document')
assert.equal(displayTypeFor('document', null), 'Document')
assert.equal(displayTypeFor('unknown', null), 'Unknown')
pass += 10

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

// ── Master/variant directory grouping (Phase 07) ─────────────────────────────

// Master at tree root + variants in quality subdirectories → ONE group whose
// primary is the master (shallowest + non-quality name), not the first event.
const g7 = groupCaptures([
  cap({ id: 'v1080', type: 'hls', filename: 'index.m3u8', pageUrl: 'https://s.com/watch', url: 'https://cdn.com/videos/1080/index.m3u8', ts: 3 }),
  cap({ id: 'v720', type: 'hls', filename: 'index.m3u8', pageUrl: 'https://s.com/watch', url: 'https://cdn.com/videos/720/index.m3u8', ts: 2 }),
  cap({ id: 'master', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/watch', url: 'https://cdn.com/videos/master.m3u8', ts: 1 }),
  cap({ id: 'audio', type: 'hls', filename: 'index.m3u8', pageUrl: 'https://s.com/watch', url: 'https://cdn.com/videos/audio/index.m3u8', ts: 4 }),
])
assert.equal(g7.length, 1, 'master + variants → one group')
assert.equal(g7[0].type, 'hls-group')
assert.equal(g7[0].primary.id, 'master', 'master chosen as primary despite earliest ts')
assert.equal(g7[0].variants.length, 4)

// Different CDN origins on the same page stay separate (no over-grouping).
const g8 = groupCaptures([
  cap({ id: 'a', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn-a.com/master.m3u8' }),
  cap({ id: 'b', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn-b.com/master.m3u8' }),
])
assert.equal(g8.length, 2, 'different origins → separate cards')
assert.ok(g8.every((g) => g.type === 'single'))

// Same origin, different trees → separate cards (unrelated media).
const g9 = groupCaptures([
  cap({ id: 'a', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/trailer/master.m3u8' }),
  cap({ id: 'b', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/feature/master.m3u8' }),
])
assert.equal(g9.length, 2, 'different trees → separate cards')
assert.ok(g9.every((g) => g.type === 'single'))

// DASH groups with DASH (manifest.mpd + 1080/720 dirs) — cross-type is NOT
// grouped (hls vs dash are different types).
const g10 = groupCaptures([
  cap({ id: 'm', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/v/master.m3u8' }),
  cap({ id: 'd', type: 'dash', filename: 'manifest.mpd', pageUrl: 'https://s.com/', url: 'https://cdn.com/v/manifest.mpd' }),
])
assert.equal(g10.length, 2, 'hls + dash stay separate')
assert.ok(g10.every((g) => g.type === 'single'))

// ── URL-derived quality labels (Phase 11 variant naming) ─────────────────────

assert.equal(urlQualityLabel('https://cdn.com/videos/1080/index.m3u8'), '1080p')
assert.equal(urlQualityLabel('https://cdn.com/videos/720/index.m3u8'), '720p')
assert.equal(urlQualityLabel('https://cdn.com/videos/audio/index.m3u8'), null)
assert.equal(urlQualityLabel('https://cdn.com/videos/4k/index.m3u8'), '4K')
assert.equal(urlQualityLabel('https://cdn.com/videos/master.m3u8'), null)
assert.equal(urlQualityLabel('https://cdn.com/videos/1080.m3u8'), '1080p')
assert.equal(urlQualityLabel(null), null)
pass += 15

const groupPass = 10
console.log(`classify: ${pass + groupPass} checks passed`)