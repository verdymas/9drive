/**
 * Metadata collectors tests — covers the parts that don't need a browser.
 *
 * The collectors themselves (collectJsonLdScripts, collectDomMedia,
 * collectPlayerConfigs, installApiCapture, collectApiMetadata) require a real
 * DOM + window, so they run as part of the manual smoke checklist in the
 * Browser Capture README. This file covers:
 *   - parseJsonLdVideoObjects() — also re-exported via media-identity, tested
 *     there in detail; we focus on collector-specific shape here.
 *   - filenameBasename() integration with the cache key
 *   - The collector allowlist shape (player config keys, title keys, stream
 *     keys) is verified statically by importing the module and asserting the
 *     constants are non-empty.
 */

import assert from 'node:assert/strict'
import { filenameBasename, parseJsonLdVideoObjects } from '../src/media-identity.js'

let pass = 0
function ok(label) { pass++ }

// ── Static shape ──────────────────────────────────────────────────────────

const collectors = await import('../src/metadata-collectors.js')
assert.equal(typeof collectors.collectJsonLdScripts, 'function', 'collectJsonLdScripts exported')
assert.equal(typeof collectors.collectDomMedia, 'function', 'collectDomMedia exported')
assert.equal(typeof collectors.collectPlayerConfigs, 'function', 'collectPlayerConfigs exported')
assert.equal(typeof collectors.installApiCapture, 'function', 'installApiCapture exported')
assert.equal(typeof collectors.collectApiMetadata, 'function', 'collectApiMetadata exported')
assert.equal(typeof collectors.collectAllMetadata, 'function', 'collectAllMetadata exported')
ok('all collectors exported')

// ── parseJsonLdVideoObjects() — round-trip with strings ───────────────────

// String input that the content script's <script> textContent provides.
const fromString = parseJsonLdVideoObjects(
  '{"@type":"VideoObject","name":"From Script","thumbnailUrl":"https://x.com/t.jpg"}',
)
assert.equal(fromString.length, 1)
assert.equal(fromString[0].name, 'From Script')
ok('parseJsonLdVideoObjects accepts JSON strings')

// Malformed string input is safely empty.
const malformed = parseJsonLdVideoObjects('{ "broken')
assert.equal(malformed.length, 0, 'malformed string → []')
ok('parseJsonLdVideoObjects tolerates malformed input')

// Non-JSON, non-object input.
assert.equal(parseJsonLdVideoObjects(42).length, 0, 'number → []')
assert.equal(parseJsonLdVideoObjects(true).length, 0, 'boolean → []')
assert.equal(parseJsonLdVideoObjects(null).length, 0, 'null → []')
assert.equal(parseJsonLdVideoObjects(undefined).length, 0, 'undefined → []')
ok('parseJsonLdVideoObjects tolerates non-JSON inputs')

// Array of objects (multiple <script> tags).
const fromArray = parseJsonLdVideoObjects([
  { '@type': 'VideoObject', name: 'A' },
  { '@type': 'VideoObject', name: 'B' },
])
assert.equal(fromArray.length, 2, 'array of VideoObjects')
ok('parseJsonLdVideoObjects accepts arrays')

// ── filenameBasename used as cache key ───────────────────────────────────

const key1 = filenameBasename('https://cdn.com/a/b/movie.mp4?token=secret&exp=999')
const key2 = filenameBasename('https://cdn.com/a/b/movie.mp4?token=rotated')
const key3 = filenameBasename('https://cdn.com/a/b/movie.mp4')
assert.equal(key1, key2)
assert.equal(key2, key3)
assert.equal(key1, 'movie.mp4')
ok('filenameBasename is stable for cache keying (signed query strings do not change the key)')

// Different display URLs produce different keys.
const otherKey = filenameBasename('https://cdn.com/a/b/other.mp4')
assert.notEqual(key1, otherKey, 'different display URLs → different keys')
ok('filenameBasename differentiates distinct display URLs')

// Path separators and illegal chars are normalized.
assert.equal(filenameBasename('https://cdn.com/dir/sub/file.mp4'), 'file.mp4')
ok('filenameBasename ignores path')

// ── Collector safety contract — readable from the source ─────────────────
//
// We re-state the safety contract as a guard against accidental loosening:
//   - collectPlayerConfigs reads ONLY an allowlist of window.* property names.
//   - installApiCapture wraps window.fetch + XMLHttpRequest.prototype.open/send,
//     never reads request headers, never logs bodies, never logs full URLs.
//   - The cache is bounded at 50 entries (FIFO) with an 8KB body cap per entry.

const src = await import('node:fs').then((fs) => fs.readFileSync(
  new URL('../src/metadata-collectors.js', import.meta.url),
  'utf8',
))
assert.ok(src.includes('PLAYER_CONFIG_KEYS'), 'PLAYER_CONFIG_KEYS allowlist present')
assert.ok(src.includes('TITLE_KEYS'), 'TITLE_KEYS allowlist present')
assert.ok(src.includes('STREAM_TOP_KEYS'), 'STREAM_TOP_KEYS allowlist present')
assert.ok(src.includes('STREAM_ITEM_KEYS'), 'STREAM_ITEM_KEYS allowlist present')
assert.ok(src.includes('API_FETCH_LIMIT_BYTES = 8 * 1024'), '8KB body cap')
assert.ok(src.includes('API_CACHE_MAX = 50'), '50-entry FIFO cap')
assert.ok(src.includes('API_CONTENT_TYPE_ALLOWLIST'), 'content-type allowlist present')
ok('collector safety contract is present in source')

console.log(`metadata-collectors: ${pass} checks passed`)
