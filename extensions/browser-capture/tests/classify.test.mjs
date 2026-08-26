/**
 * Classification tests — plain assert-based, runnable with `node tests/run.js`
 * (no framework needed; mirrors the backend's self-check convention).
 */
import assert from 'node:assert/strict'
import { classifyResource, filenameFromUrl, detectFilename } from '../src/classify.js'

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

console.log(`classify: ${pass + 5} checks passed`)
