/**
 * Classification tests — plain assert-based, runnable with `node tests/run.js`
 * (no framework needed; mirrors the backend's self-check convention).
 */
import assert from 'node:assert/strict'
import { classifyResource, filenameFromUrl, detectFilename, groupCaptures } from '../src/classify.js'

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
assert.equal(detectFilename({ url: 'https://x.example.com/', pageTitle: 'My Show <EP12>' }), 'My Show <EP12>')
assert.equal(detectFilename({ url: 'https://x.example.com/' }), 'captured-file')

// ── groupCaptures ──────────────────────────────────────────────────────────

const cap = (overrides) => ({ id: 'c-' + Math.random().toString(36).slice(2, 6), status: 'detected', ts: Date.now(), type: 'video', filename: 'x.mp4', url: 'https://x.com/x.mp4', pageUrl: 'https://x.com/', mime: null, ...overrides })

// Single video stays alone.
const g1 = groupCaptures([cap({ type: 'video', filename: 'movie.mp4' })])
assert.equal(g1.length, 1, 'single video → 1 group')
assert.equal(g1[0].type, 'single')

// Lone HLS stays alone.
const g2 = groupCaptures([cap({ type: 'hls', filename: 'master.m3u8', pageUrl: 'https://stream.com/watch' })])
assert.equal(g2.length, 1, 'lone HLS → 1 group')
assert.equal(g2[0].type, 'single')

// Multiple HLS from same page → grouped.
const g3 = groupCaptures([
  cap({ id: 'a', type: 'hls', filename: '1080.m3u8', pageUrl: 'https://stream.com/watch', url: 'https://cdn.com/1080.m3u8', ts: 3 }),
  cap({ id: 'b', type: 'hls', filename: '720.m3u8', pageUrl: 'https://stream.com/watch', url: 'https://cdn.com/720.m3u8', ts: 2 }),
  cap({ id: 'c', type: 'hls', filename: '360.m3u8', pageUrl: 'https://stream.com/watch', url: 'https://cdn.com/360.m3u8', ts: 1 }),
])
assert.equal(g3.length, 1, 'same-page HLS → 1 group')
assert.equal(g3[0].type, 'hls-group')
assert.equal(g3[0].variants.length, 3, '3 variants')
assert.equal(g3[0].primary.id, 'a', 'first detected = primary')

// HLS from different pages → separate groups.
const g4 = groupCaptures([
  cap({ id: 'a', type: 'hls', filename: 'a.m3u8', pageUrl: 'https://a.com/watch', url: 'https://cdn.com/a.m3u8' }),
  cap({ id: 'b', type: 'hls', filename: 'b.m3u8', pageUrl: 'https://b.com/watch', url: 'https://cdn.com/b.m3u8' }),
])
assert.equal(g4.length, 2, 'different pages → 2 groups')
assert.equal(g4[0].type, 'single')
assert.equal(g4[1].type, 'single')

// Mixed types: video + HLS → separate groups.
const g5 = groupCaptures([
  cap({ id: 'v', type: 'video', filename: 'clip.mp4', pageUrl: 'https://x.com/' }),
  cap({ id: 'h', type: 'hls', filename: 'h.m3u8', pageUrl: 'https://y.com/' }),
])
assert.equal(g5.length, 2, 'mixed types → 2 groups')
assert.ok(g5.every((g) => g.type === 'single'))

// Expired/consumed captures filtered out.
const g6 = groupCaptures([
  cap({ id: 'x', type: 'video', status: 'expired' }),
  cap({ id: 'y', type: 'hls', status: 'consumed', pageUrl: 'https://x.com/' }),
])
assert.equal(g6.length, 0, 'all consumed/expired → empty')

// Quality sorting: 720 < 1080 in variants array (primary stays first).
const g7 = groupCaptures([
  cap({ id: 'p', type: 'hls', filename: 'master.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/master.m3u8', ts: 10 }),
  cap({ id: 'lo', type: 'hls', filename: '360.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/360.m3u8', ts: 5 }),
  cap({ id: 'hi', type: 'hls', filename: '1080.m3u8', pageUrl: 'https://s.com/', url: 'https://cdn.com/1080.m3u8', ts: 8 }),
])
assert.equal(g7[0].variants[0].id, 'p', 'primary first')
assert.equal(g7[0].variants[1].id, 'lo', '360 before 1080')
assert.equal(g7[0].variants[2].id, 'hi', '1080 after 360')

const groupPass = 9

console.log(`classify: ${pass + 5 + groupPass} checks passed`)
