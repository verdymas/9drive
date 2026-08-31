/**
 * Capture filter tests — plain assert-based (same convention as the other
 * extension tests). Run with `node tests/filters.test.mjs`.
 */
import assert from 'node:assert/strict'
import { CAPTURE_TYPES, DEFAULT_FILTERS, isTypeAllowed } from '../src/filters.js'

let pass = 0

// ── DEFAULT_FILTERS shape ───────────────────────────────────────────────────

assert.deepEqual(CAPTURE_TYPES, ['video', 'hls', 'dash', 'audio', 'documents', 'images', 'other'])
assert.equal(DEFAULT_FILTERS.video, true)
assert.equal(DEFAULT_FILTERS.hls, true)
assert.equal(DEFAULT_FILTERS.dash, true)
assert.equal(DEFAULT_FILTERS.audio, true)
assert.equal(DEFAULT_FILTERS.documents, true)
assert.equal(DEFAULT_FILTERS.images, false)
assert.equal(DEFAULT_FILTERS.other, false)
pass += 8

// ── isTypeAllowed with defaults: useful media allowed, images/other suppressed

for (const t of ['hls', 'dash', 'video', 'audio', 'document']) {
  assert.equal(isTypeAllowed(t), true, `${t} allowed by default`)
}
for (const t of ['image', 'archive', 'other']) {
  assert.equal(isTypeAllowed(t), false, `${t} blocked by default`)
}
assert.equal(isTypeAllowed('unknown'), false, 'unknown type never allowed')
pass += 9

// ── Archives live under the "Other Files" toggle ────────────────────────────

assert.equal(isTypeAllowed('archive', { other: true }), true)
assert.equal(isTypeAllowed('other', { other: true }), true)
assert.equal(isTypeAllowed('archive', { other: false }), false)
pass += 3

// ── Images + Other opt-in ────────────────────────────────────────────────────

assert.equal(isTypeAllowed('image', { images: true }), true)
assert.equal(isTypeAllowed('image', { images: false }), false)
assert.equal(isTypeAllowed('other', { other: true }), true)
pass += 3

// ── Partial filters merge over defaults ────────────────────────────────────

assert.equal(isTypeAllowed('image', {}), false, 'empty filters still respect defaults')
assert.equal(isTypeAllowed('video', {}), true, 'empty filters keep video allowed')
assert.equal(isTypeAllowed('document', { images: true }), true, 'irrelevant overrides do not flip defaults')
pass += 3

// ── Falsy / null-safe ───────────────────────────────────────────────────────

assert.equal(isTypeAllowed('image', null), false, 'null filters → defaults applied')
assert.equal(isTypeAllowed('image', undefined), false)
pass += 2

console.log(`filters: ${pass} checks passed`)
