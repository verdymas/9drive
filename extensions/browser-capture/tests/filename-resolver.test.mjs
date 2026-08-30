/**
 * Filename-resolver tests — plain assert-based, runnable with `node tests/run.js`
 * (no framework needed; mirrors the classify.test.mjs convention).
 */
import assert from 'node:assert/strict'
import {
  parseContentDispositionFilename,
  sanitizeFilename,
  isGenericName,
  filenameFromUrl,
  resolveFilename,
  removeSiteSuffix,
  SOURCES,
  SOURCE_SCORES,
  HLS_OUTPUT_EXTENSION,
} from '../src/filename-resolver.js'

let pass = 0

// ── Content-Disposition parsing ─────────────────────────────────────────────

function testCD(desc, header, expected) {
  assert.equal(parseContentDispositionFilename(header), expected, desc)
  pass++
}

testCD('filename* UTF-8', `attachment; filename*=UTF-8''My%20Movie.mp4`, 'My Movie.mp4')
testCD('filename* Japanese', `attachment; filename*=UTF-8''Film%20%E6%97%A5%E6%9C%AC%E8%AA%9E%201080p.mp4`, 'Film 日本語 1080p.mp4')
testCD('filename* beats filename', `attachment; filename*=UTF-8''Movie.mkv; filename="old.mp4"`, 'Movie.mkv')
testCD('filename* non-UTF8 falls back to filename', `attachment; filename*=ISO-8859-1''Movie; filename="fallback.mp4"`, 'fallback.mp4')
testCD('filename* malformed % falls back to filename', `attachment; filename*=UTF-8''%ZZbad; filename="safe.mp4"`, 'safe.mp4')
testCD('plain filename quoted', `attachment; filename="movie.mp4"`, 'movie.mp4')
testCD('plain filename token', `attachment; filename=video.mkv`, 'video.mkv')
testCD('no header', null, null)
testCD('empty header', '', null)
testCD('inline without filename', `inline`, null)
testCD('filename empty quoted', `attachment; filename=""`, null)
testCD('filename with spaces', `attachment; filename="My Movie 1080p.mp4"`, 'My Movie 1080p.mp4')
testCD('filename with semicolon in quote', `attachment; filename="my;file.mp4"`, 'my;file.mp4')
testCD('backslash-escaped quote', `attachment; filename="say \\"hello\\".mp4"`, 'say "hello".mp4')

// ── Sanitizer ───────────────────────────────────────────────────────────────

function testSanitize(desc, input, expected) {
  assert.equal(sanitizeFilename(input), expected, desc)
  pass++
}

testSanitize('normal name', 'movie.mp4', 'movie.mp4')
testSanitize('path separator slash', 'a/b/file.mp4', 'a-b-file.mp4')
testSanitize('path separator backslash', 'dir\\file.ts', 'dir-file.ts')
testSanitize('illegal chars', 'file<>:".mp4', 'file.mp4')
testSanitize('control chars', 'file\x00\x01name.mp4', 'filename.mp4')
testSanitize('null byte', 'file\x00.mp4', 'file.mp4')
testSanitize('Windows reserved name', 'CON', 'file')
testSanitize('reserved with ext', 'nul.txt', 'file.txt')
testSanitize('trailing dots', 'video.', 'video')
testSanitize('trailing spaces', 'video.mp4 ', 'video.mp4')
testSanitize('empty input', '', 'file')
testSanitize('dot only', '.', 'file')
testSanitize('dotdot only', '..', 'file')
testSanitize('Unicode preserved', 'Film 日本語 1080p.mp4', 'Film 日本語 1080p.mp4')
testSanitize('long name truncated', 'x'.repeat(300) + '.mp4', 'x'.repeat(251) + '.mp4')
testSanitize('long name no ext', 'x'.repeat(300), 'x'.repeat(255))

// ── Generic name detection ──────────────────────────────────────────────────

function testGeneric(desc, name, expected) {
  assert.equal(isGenericName(name), expected, desc)
  pass++
}

testGeneric('master.m3u8', 'master.m3u8', true)
testGeneric('index.mpd', 'index.mpd', true)
testGeneric('playlist.m3u8', 'playlist.m3u8', true)
testGeneric('manifest.mpd', 'manifest.mpd', true)
testGeneric('1080.mp4', '1080.mp4', true)
testGeneric('720.mkv', '720.mkv', true)
testGeneric('stream.m3u8', 'stream.m3u8', true)
testGeneric('chunklist.m3u8', 'chunklist.m3u8', true)
testGeneric('MyShow.m3u8', 'MyShow.m3u8', false)
testGeneric('lecture-notes.mp4', 'lecture-notes.mp4', false)
testGeneric('Big Buck Bunny 1080p.mp4', 'Big Buck Bunny 1080p.mp4', false)
testGeneric('null', null, false)
testGeneric('empty string', '', false)

// ── filenameFromUrl ─────────────────────────────────────────────────────────

function testUrl(desc, url, expected) {
  assert.equal(filenameFromUrl(url), expected, desc)
  pass++
}

testUrl('simple path', 'https://cdn.com/video/movie.mp4', 'movie.mp4')
testUrl('ignores query', 'https://cdn.com/video/movie.mp4?sig=secret', 'movie.mp4')
testUrl('no path', 'https://example.com/', '')
testUrl('path without ext', 'https://example.com/download?id=1', 'download')
testUrl('decoded unicode', 'https://cdn.com/日本語.mkv', '日本語.mkv')

// ── removeSiteSuffix ────────────────────────────────────────────────────────

function testSuffix(desc, title, expected) {
  assert.equal(removeSiteSuffix(title), expected, desc)
  pass++
}

testSuffix('YouTube suffix', 'My Video - YouTube', 'My Video')
testSuffix('Facebook suffix', 'Hello | Facebook', 'Hello')
testSuffix('Reddit em-dash', 'Title – Reddit', 'Title')
testSuffix('no suffix', 'No suffix here', 'No suffix here')
testSuffix('null', null, '')
testSuffix('empty', '', '')

// ── resolveFilename — scoring ───────────────────────────────────────────────

function testResolve(desc, opts, expectedFilename, expectedSource) {
  const result = resolveFilename(opts)
  assert.equal(result.filename, expectedFilename, desc + ' filename')
  assert.equal(result.source, expectedSource, desc + ' source')
  pass++
}

// Custom filename absolute priority
testResolve('custom filename wins over everything',
  { customFilename: 'My Movie.mkv', requestUrl: 'https://cdn.com/playlist.m3u8', finalUrl: 'https://cdn.com/playlist.m3u8', type: 'hls', quality: '1080p' },
  'My Movie.mkv', SOURCES.CUSTOM_FILENAME)

// Content-Disposition beats URL
testResolve('CD filename beats URL',
  { contentDisposition: 'attachment; filename="movie.mp4"', requestUrl: 'https://cdn.com/video.m3u8', finalUrl: 'https://cdn.com/video.m3u8', type: 'video' },
  'movie.mp4', SOURCES.CD_FILENAME)

// filename* beats filename
testResolve('filename* beats filename',
  { contentDisposition: 'attachment; filename*=UTF-8\'\'Movie.mkv; filename="old.mp4"', requestUrl: 'https://cdn.com/x.m3u8', finalUrl: 'https://cdn.com/x.m3u8', type: 'hls' },
  'Movie.mkv', SOURCES.CD_FILENAME_STAR)

// Final URL beats request URL
testResolve('final URL beats request URL',
  { requestUrl: 'https://example.com/download?id=1', finalUrl: 'https://cdn.com/files/movie-final.mp4', type: 'video' },
  'movie-final.mp4', SOURCES.FINAL_URL)

// Download attribute beats URL
testResolve('download attr beats URL',
  { downloadAttr: 'Manual Produk.pdf', requestUrl: 'https://cdn.com/download?id=1', finalUrl: 'https://cdn.com/download?id=1', type: 'document' },
  'Manual Produk.pdf', SOURCES.DOWNLOAD_ATTR)

// Page metadata title beats generic URL
testResolve('page metadata beats generic HLS URL',
  { requestUrl: 'https://cdn.com/1080.m3u8', finalUrl: 'https://cdn.com/1080.m3u8', type: 'hls', quality: '1080p',
    pageMetadata: { title: 'Big Buck Bunny' } },
  'Big Buck Bunny 1080p.mkv', SOURCES.PAGE_TITLE)

// OG title beats page title
testResolve('og:title beats page title',
  { requestUrl: 'https://cdn.com/master.m3u8', finalUrl: 'https://cdn.com/master.m3u8', type: 'hls', quality: '1080p',
    pageMetadata: { title: 'Page Title', ogTitle: 'OG Movie Name' } },
  'OG Movie Name 1080p.mkv', SOURCES.OG_TITLE)

// Media title beats OG title
testResolve('media title beats og:title',
  { requestUrl: 'https://cdn.com/master.m3u8', finalUrl: 'https://cdn.com/master.m3u8', type: 'hls', quality: '1080p',
    pageMetadata: { title: 'Page Title', ogTitle: 'OG Movie', mediaTitle: 'Media Movie' } },
  'Media Movie 1080p.mkv', SOURCES.MEDIA_TITLE)

// HLS non-generic name: extension swapped to .mkv, quality appended
// (finalUrl === requestUrl here, but FINAL_URL scores higher)
testResolve('non-generic HLS name keeps name with .mkv',
  { requestUrl: 'https://cdn.com/lecture-notes.mp4', finalUrl: 'https://cdn.com/lecture-notes.mp4', type: 'hls', quality: '720p' },
  'lecture-notes.mkv', SOURCES.FINAL_URL)

// DASH behaves identically to HLS
testResolve('DASH generic → page title + .mkv',
  { requestUrl: 'https://cdn.com/manifest.mpd', finalUrl: 'https://cdn.com/manifest.mpd', type: 'dash', quality: '1080p',
    pageMetadata: { title: 'Big Buck Bunny' } },
  'Big Buck Bunny 1080p.mkv', SOURCES.PAGE_TITLE)

// DASH non-generic: extension swapped
testResolve('DASH non-generic → .mkv',
  { requestUrl: 'https://cdn.com/movie.mpd', finalUrl: 'https://cdn.com/movie.mpd', type: 'dash', quality: '1080p' },
  'movie.mkv', SOURCES.FINAL_URL)

// All null → 'captured-file' fallback
testResolve('all null → captured-file fallback',
  { type: 'video' },
  'captured-file', SOURCES.FALLBACK)

// Unicode preserved
testResolve('Unicode filename preserved',
  { requestUrl: 'https://cdn.com/Film%20日本語%201080p.mp4', finalUrl: 'https://cdn.com/Film%20日本語%201080p.mp4', type: 'video' },
  'Film 日本語 1080p.mp4', SOURCES.FINAL_URL)

// Content-Disposition filename* with unicode
testResolve('CD filename* unicode',
  { contentDisposition: `attachment; filename*=UTF-8''Film%20%E6%97%A5%E6%9C%AC%E8%AA%9E%201080p.mp4`, type: 'video' },
  'Film 日本語 1080p.mp4', SOURCES.CD_FILENAME_STAR)

// ── Regression: explicit custom filename never overwritten for HLS ──────────

function testCustomFilenameImmutable(desc, opts) {
  const result = resolveFilename(opts)
  assert.equal(result.filename, opts.customFilename, desc + ' filename')
  assert.equal(result.source, SOURCES.CUSTOM_FILENAME, desc + ' source')
  pass++
}

testCustomFilenameImmutable('custom filename survives HLS generic',
  { customFilename: 'My Movie.mkv', requestUrl: 'https://cdn.com/1080.m3u8', finalUrl: 'https://cdn.com/1080.m3u8', type: 'hls', quality: '1080p' })

testCustomFilenameImmutable('custom filename survives HLS generic with metadata',
  { customFilename: 'My Custom Movie.mkv', requestUrl: 'https://cdn.com/master.m3u8', finalUrl: 'https://cdn.com/master.m3u8', type: 'hls', pageMetadata: { title: 'Big Buck Bunny' } })

testCustomFilenameImmutable('custom filename survives video',
  { customFilename: 'My Video.mp4', requestUrl: 'https://cdn.com/playlist.m3u8', finalUrl: 'https://cdn.com/playlist.m3u8', type: 'video' })

testCustomFilenameImmutable('custom filename with CD header',
  { customFilename: 'User Name.mp4', contentDisposition: 'attachment; filename="server-name.mkv"', requestUrl: 'https://cdn.com/x.m3u8', finalUrl: 'https://cdn.com/x.m3u8', type: 'video' })

console.log(`filename-resolver: ${pass} checks passed`)