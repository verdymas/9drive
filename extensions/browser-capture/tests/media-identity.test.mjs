/**
 * Media Identity tests — pure Node, no browser.
 *
 * Covers:
 *   - JSON-LD parsing (multiple scripts, @graph, missing fields, XSS attempts)
 *   - ISO 8601 duration parser
 *   - Generic-stem detection (expanded set + numeric patterns)
 *   - extractMediaIdentity() scoring with the four spec regression cases
 *   - mediaIdentityToPageMetadata() compatibility shape
 *   - formatDebugReport() safe output (no URLs, no bodies)
 *   - resolveFromMediaIdentity() integration with the existing resolver
 */

import assert from 'node:assert/strict'
import {
  IDENTITY_SOURCES,
  IDENTITY_SCORES,
  isGenericName,
  parseJsonLdVideoObjects,
  extractMediaIdentity,
  mediaIdentityToPageMetadata,
  formatDebugReport,
  filenameBasename,
} from '../src/media-identity.js'
import { resolveFromMediaIdentity, resolveFilename, SOURCES } from '../src/filename-resolver.js'

let pass = 0
function ok(label) { pass++ }

// ── IDENTITY_SOURCES — stable identifiers ──────────────────────────────────

assert.equal(IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_NAME, 'jsonld-videoobject-name')
assert.equal(IDENTITY_SOURCES.OG_TITLE, 'og-title')
assert.equal(IDENTITY_SOURCES.PAGE_TITLE, 'page-title')
ok('IDENTITY_SOURCES constants match the plan')

// ── Scoring order is monotonic in the documented priority ─────────────────

const priority = [
  IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_NAME,        // 100
  IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_HEADLINE,    // 95
  IDENTITY_SOURCES.PLAYER_CONFIG_TITLE,            // 92
  IDENTITY_SOURCES.PLAYER_CONFIG_NAME,             // 88
  IDENTITY_SOURCES.API_METADATA_TITLE,             // 85
  IDENTITY_SOURCES.API_METADATA_NAME,              // 82
  IDENTITY_SOURCES.DOM_VIDEO_TITLE,                // 75
  IDENTITY_SOURCES.DOM_VIDEO_ARIA_LABEL,           // 72
  IDENTITY_SOURCES.DOM_VIDEO_DATA_TITLE,           // 70
  IDENTITY_SOURCES.DOM_VIDEO_DATA_NAME,            // 70
  IDENTITY_SOURCES.OG_TITLE,                       // 65
  IDENTITY_SOURCES.OG_VIDEO_TITLE,                 // 65
  IDENTITY_SOURCES.TWITTER_TITLE,                  // 60
  IDENTITY_SOURCES.MEDIA_TITLE,                    // 60
  IDENTITY_SOURCES.PAGE_TITLE,                     // 45
  IDENTITY_SOURCES.URL_BASENAME_NON_GENERIC,       // 25
  IDENTITY_SOURCES.URL_BASENAME_GENERIC,           // 5
]
for (let i = 1; i < priority.length; i++) {
  const prev = IDENTITY_SCORES[priority[i - 1]]
  const cur = IDENTITY_SCORES[priority[i]]
  assert.ok(prev >= cur, `priority order broken: ${priority[i - 1]}=${prev} < ${priority[i]}=${cur}`)
}
ok('scoring table is monotonic in declared priority')

// ── Generic name detection (expanded set) ─────────────────────────────────

assert.equal(isGenericName('master.m3u8'), true)
assert.equal(isGenericName('index.mpd'), true)
assert.equal(isGenericName('1080.mp4'), true)
assert.equal(isGenericName('1080p.mp4'), true)
assert.equal(isGenericName('4k.mp4'), true)
assert.equal(isGenericName('movie.mp4'), true, 'media-related stems rejected')
assert.equal(isGenericName('trailer.mp4'), true, 'trailer is generic')
assert.equal(isGenericName('sample.mp4'), true, 'sample is generic')
assert.equal(isGenericName('episode.mp4'), true, 'episode is generic')
assert.equal(isGenericName('v123.m3u8'), true, 'Vimeo-style v<n> generic')
assert.equal(isGenericName('1234.m3u8'), true, 'bare-numeric generic')
assert.equal(isGenericName('a12.m3u8'), true, 'short alphanumeric generic')
assert.equal(isGenericName('vod/stream/index.m3u8'), true, 'CDN-tree pattern generic')
assert.equal(isGenericName('live/master.m3u8'), true)
assert.equal(isGenericName('Big Buck Bunny 1080p.mp4'), false, 'real title preserved')
assert.equal(isGenericName('lecture-notes.mp4'), false)
assert.equal(isGenericName(null), false, 'null safe')
assert.equal(isGenericName(''), false, 'empty safe')
ok('generic name detection (expanded)')

// ── JSON-LD parsing ────────────────────────────────────────────────────────

// Single VideoObject.
const single = parseJsonLdVideoObjects({
  '@type': 'VideoObject',
  name: 'Big Buck Bunny',
  headline: 'A Big Buck Bunny Film',
  thumbnailUrl: 'https://example.com/bbb.jpg',
  description: 'A short film.',
  duration: 'PT10M30S',
})
assert.equal(single.length, 1, 'single VideoObject')
assert.equal(single[0].name, 'Big Buck Bunny')
assert.equal(single[0].headline, 'A Big Buck Bunny Film')
ok('JSON-LD: single VideoObject')

// @graph container.
const graph = parseJsonLdVideoObjects({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'Acme' },
    { '@type': 'VideoObject', name: 'Movie A' },
    { '@type': 'VideoObject', name: 'Movie B', headline: 'B headline' },
  ],
})
assert.equal(graph.length, 2, 'two VideoObjects from @graph')
assert.deepEqual(graph.map((g) => g.name), ['Movie A', 'Movie B'])
ok('JSON-LD: @graph container')

// Nested @graph (recursive).
const nested = parseJsonLdVideoObjects({
  '@graph': [
    {
      '@graph': [
        { '@type': 'VideoObject', name: 'Nested movie' },
        { '@type': 'WebSite' },
      ],
    },
  ],
})
assert.equal(nested.length, 1, 'nested @graph')
assert.equal(nested[0].name, 'Nested movie')
ok('JSON-LD: nested @graph')

// Subtypes: Movie / TVClip / ShortFilm count.
const subs = parseJsonLdVideoObjects([
  { '@type': 'Movie', name: 'Movie 1' },
  { '@type': 'TVClip', name: 'Clip 1' },
  { '@type': 'ShortFilm', name: 'Short 1' },
  { '@type': 'WebPage' },
])
assert.equal(subs.length, 3, 'subtypes recognized')
ok('JSON-LD: subtypes')

// Malformed JSON strings are skipped silently.
const malformed = parseJsonLdVideoObjects('{ not valid json')
assert.equal(malformed.length, 0, 'malformed input → []')
ok('JSON-LD: malformed input')

// XSS / control character safety.
const dirty = parseJsonLdVideoObjects({
  '@type': 'VideoObject',
  name: '<script>alert(1)</script>',
  description: 'Multi\nline\tdescription with \r chars',
})
assert.equal(dirty.length, 1)
assert.equal(dirty[0].name, '<script>alert(1)</script>', 'name kept as-is, caller sanitizes for display')
ok('JSON-LD: control chars not stripped by parser (caller responsibility)')

// Cyclic JSON-LD object — must not infinite loop.
const a = { '@type': 'VideoObject', name: 'A' }
a.self = a
const cyclic = parseJsonLdVideoObjects(a)
assert.equal(cyclic.length, 1)
assert.equal(cyclic[0].name, 'A')
ok('JSON-LD: cyclic safety')

// ── ISO 8601 duration ─────────────────────────────────────────────────────

const id = extractMediaIdentity({
  jsonLd: [{ '@type': 'VideoObject', name: 'X', duration: 'PT1H30M5S' }],
})
assert.equal(id.duration, (1 * 3600) + (30 * 60) + 5, 'PT1H30M5S')
ok('ISO 8601 duration: PT1H30M5S')

assert.equal(extractMediaIdentity({ jsonLd: [{ '@type': 'VideoObject', name: 'X', duration: 'PT2M' }] }).duration, 120, 'PT2M')
assert.equal(extractMediaIdentity({ jsonLd: [{ '@type': 'VideoObject', name: 'X', duration: 'PT45S' }] }).duration, 45, 'PT45S')
assert.equal(extractMediaIdentity({ jsonLd: [{ '@type': 'VideoObject', name: 'X', duration: 'PT1H' }] }).duration, 3600, 'PT1H')
assert.equal(extractMediaIdentity({ jsonLd: [{ '@type': 'VideoObject', name: 'X', duration: 'not a duration' }] }).duration, null, 'invalid → null')

// Numeric durations pass through.
assert.equal(extractMediaIdentity({ jsonLd: [{ '@type': 'VideoObject', name: 'X', duration: 90 }] }).duration, 90, 'numeric duration')
ok('ISO 8601 duration: edge cases')

// ── extractMediaIdentity — scoring precedence ─────────────────────────────

// JSON-LD > og:title > page title.
const precedence = extractMediaIdentity({
  jsonLd: [{ '@type': 'VideoObject', name: 'From JSON-LD' }],
  pageMetadata: { title: 'From document.title', ogTitle: 'From og:title' },
})
assert.equal(precedence.title, 'From JSON-LD')
assert.equal(precedence.identity.selectedSource, IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_NAME)
assert.equal(precedence.identity.selectedConfidence, 100)
ok('precedence: JSON-LD > og:title > page title')

// Player config > og:title (no JSON-LD).
const playerFirst = extractMediaIdentity({
  playerConfigs: [{ source: 'playerConfig', title: 'From Player' }],
  pageMetadata: { title: 'From document.title', ogTitle: 'From og:title' },
})
assert.equal(playerFirst.title, 'From Player')
assert.equal(playerFirst.identity.selectedSource, IDENTITY_SOURCES.PLAYER_CONFIG_TITLE)
ok('precedence: player > og:title')

// API metadata > DOM video > og:title.
const apiFirst = extractMediaIdentity({
  apiMetadata: [{ source: 'fetch', title: 'From API', name: 'title' }],
  videoElements: [{ title: 'From <video>' }],
  pageMetadata: { ogTitle: 'From og:title' },
})
assert.equal(apiFirst.title, 'From API')
assert.equal(apiFirst.identity.selectedSource, IDENTITY_SOURCES.API_METADATA_TITLE)
ok('precedence: api > dom > og:title')

// DOM <video title> > og:title.
const domFirst = extractMediaIdentity({
  videoElements: [{ title: 'From <video title>' }],
  pageMetadata: { ogTitle: 'From og:title' },
})
assert.equal(domFirst.title, 'From <video title>')
assert.equal(domFirst.identity.selectedSource, IDENTITY_SOURCES.DOM_VIDEO_TITLE)
ok('precedence: dom > og:title')

// Generic URL basename loses to everything.
const genericBeatsNothing = extractMediaIdentity({
  finalUrl: 'https://cdn.com/master.m3u8',
  requestUrl: 'https://cdn.com/master.m3u8',
  type: 'hls',
})
assert.equal(genericBeatsNothing.identity.selectedSource, IDENTITY_SOURCES.URL_BASENAME_GENERIC)
assert.equal(genericBeatsNothing.title, 'master.m3u8', 'still surfaces the basename when nothing else is present')
ok('generic URL basename surfaces as last-resort')

// Non-generic URL basename beats generic but loses to metadata.
const nonGeneric = extractMediaIdentity({
  finalUrl: 'https://cdn.com/lecture-notes.m3u8',
  requestUrl: 'https://cdn.com/lecture-notes.m3u8',
  pageMetadata: { title: 'Big Buck Bunny' },
  type: 'hls',
})
assert.equal(nonGeneric.title, 'Big Buck Bunny', 'metadata wins over non-generic URL basename')
ok('metadata beats non-generic URL basename')

// All null → fallback.
const empty = extractMediaIdentity({})
assert.equal(empty.title, null)
assert.equal(empty.identity.selectedSource, IDENTITY_SOURCES.FALLBACK)
ok('empty input → fallback')

// ── spec regression cases (verbatim from the prompt) ──────────────────────

// HLS — master.m3u8 + VideoObject.name + 1080p → "Movie Name 1080p.mkv"
const hlsSpec = resolveFromMediaIdentity(
  extractMediaIdentity({
    jsonLd: [{ '@type': 'VideoObject', name: 'Movie Name' }],
    finalUrl: 'https://cdn.com/master.m3u8',
    requestUrl: 'https://cdn.com/master.m3u8',
    type: 'hls',
    quality: '1080p',
  }),
  { type: 'hls', quality: '1080p' },
)
assert.equal(hlsSpec.filename, 'Movie Name 1080p.mkv', 'HLS spec')
assert.equal(hlsSpec.source, IDENTITY_SOURCES.JSONLD_VIDEOOBJECT_NAME, 'HLS spec source')
ok('spec: HLS → JSON-LD name + 1080p.mkv')

// Direct MP4 — Content-Disposition "Movie.mp4" → "Movie.mp4"
const directSpec = resolveFromMediaIdentity(
  null,
  { contentDisposition: 'attachment; filename="Movie.mp4"', finalUrl: 'https://x.com/cdn', requestUrl: 'https://x.com/cdn', type: 'video' },
)
assert.equal(directSpec.filename, 'Movie.mp4', 'Direct MP4 spec')
ok('spec: direct MP4 via Content-Disposition')

// Player metadata — { title: "Movie Name", stream: "master.m3u8" } → "Movie Name.mkv"
const playerSpec = resolveFromMediaIdentity(
  extractMediaIdentity({
    playerConfigs: [{ source: 'videoData', title: 'Movie Name' }],
    finalUrl: 'https://cdn.com/master.m3u8',
    requestUrl: 'https://cdn.com/master.m3u8',
    type: 'hls',
  }),
  { type: 'hls' },
)
assert.equal(playerSpec.filename, 'Movie Name.mkv', 'Player metadata spec')
assert.equal(playerSpec.source, IDENTITY_SOURCES.PLAYER_CONFIG_TITLE, 'Player metadata spec source')
ok('spec: player metadata → "Movie Name.mkv"')

// User override — customFilename = "My Movie.mkv" → "My Movie.mkv"
const overrideSpec = resolveFromMediaIdentity(
  extractMediaIdentity({
    jsonLd: [{ '@type': 'VideoObject', name: 'Movie Name' }],
    finalUrl: 'https://cdn.com/master.m3u8',
    requestUrl: 'https://cdn.com/master.m3u8',
    type: 'hls',
    quality: '1080p',
  }),
  { customFilename: 'My Movie.mkv', type: 'hls', quality: '1080p' },
)
assert.equal(overrideSpec.filename, 'My Movie.mkv', 'User override spec')
assert.equal(overrideSpec.source, SOURCES.CUSTOM_FILENAME, 'User override source')
ok('spec: user override wins')

// ── mediaIdentityToPageMetadata — compatibility shape ─────────────────────

const compat = mediaIdentityToPageMetadata(extractMediaIdentity({
  jsonLd: [{ '@type': 'VideoObject', name: 'Big Buck Bunny' }],
  pageMetadata: { title: 'Big Buck Bunny - Site', ogTitle: 'Big Buck Bunny' },
}))
assert.equal(compat.mediaTitle, 'Big Buck Bunny', 'mediaTitle flows from identity.title')
assert.equal(compat.title, 'Big Buck Bunny - Site', 'legacy title kept')
assert.equal(compat.ogTitle, 'Big Buck Bunny', 'legacy og:title kept')
ok('mediaIdentityToPageMetadata compatibility')

// ── formatDebugReport — safe output ───────────────────────────────────────

const identity = extractMediaIdentity({
  jsonLd: [{ '@type': 'VideoObject', name: 'Big Buck Bunny' }],
  pageMetadata: { ogTitle: 'Big Buck Bunny' },
  finalUrl: 'https://secret.cdn.com/abc?token=supersecret/videos/12345/master.m3u8',
  type: 'hls',
  quality: '1080p',
})
const report = formatDebugReport(identity, {
  resourceType: 'hls',
  finalUrlHost: 'secret.cdn.com',
  quality: '1080p',
  filename: 'Big Buck Bunny 1080p.mkv',
})
assert.ok(!report.includes('token=supersecret'), 'never logs query strings')
assert.ok(!report.includes('12345'), 'never logs path segments beyond host')
assert.ok(report.includes('resourceType=hls'), 'tags present')
assert.ok(report.includes('selected=jsonld-videoobject-name'), 'selected source present')
assert.ok(report.includes('Big Buck Bunny'), 'candidate value present')
ok('formatDebugReport safety')

// ── filenameBasename — basic correctness ─────────────────────────────────

assert.equal(filenameBasename('https://cdn.com/video/movie.mp4'), 'movie.mp4')
assert.equal(filenameBasename('https://cdn.com/movie.mp4?sig=zzz'), 'movie.mp4', 'query ignored')
assert.equal(filenameBasename('https://example.com/'), '', 'root path → empty')
ok('filenameBasename')

// ── resolveFilename (legacy) untouched — pageMetadata flow still works ───

const legacy = resolveFilename({
  finalUrl: 'https://cdn.com/master.m3u8',
  requestUrl: 'https://cdn.com/master.m3u8',
  type: 'hls',
  quality: '1080p',
  pageMetadata: { ogTitle: 'Big Buck Bunny' },
})
assert.equal(legacy.filename, 'Big Buck Bunny 1080p.mkv', 'legacy resolver still scores og:title')
ok('legacy resolveFilename still works')

console.log(`media-identity: ${pass} checks passed`)
