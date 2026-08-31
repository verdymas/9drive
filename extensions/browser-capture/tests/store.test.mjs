/**
 * Store tests — Phase 12 deduplication behavior. Plain assert-based, runnable
 * with `node tests/store.test.mjs` (no framework; same convention as the other
 * extension tests). `chrome.storage.local` is mocked with an in-memory map.
 */
import assert from 'node:assert/strict'

const memory = new Map()

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === null) return Object.fromEntries(memory)
        if (Array.isArray(key)) {
          const out = {}
          for (const k of key) out[k] = memory.get(k)
          return out
        }
        return { [key]: memory.get(key) }
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) memory.set(k, v)
      },
    },
  },
}

const { addCapture, allCaptures, displayUrlOf, pruneAgainstServer } = await import('../src/store.js')

let pass = 0
const base = {
  url: 'https://cdn.com/video.mp4?token=abc',
  type: 'video',
  filename: 'video.mp4',
  status: 'detected',
}

// ── displayUrlOf ────────────────────────────────────────────────────────────

assert.equal(displayUrlOf('https://cdn.com/a.mp4?token=1#frag'), 'https://cdn.com/a.mp4')
assert.equal(displayUrlOf('https://cdn.com/b.m3u8?t=xyz'), 'https://cdn.com/b.m3u8')
pass += 2

// ── Repeated detection refreshes the SAME card (no duplicates) ──────────────

const first = await addCapture({ ...base, url: 'https://cdn.com/video.mp4?token=abc' })
assert.ok(first.id, 'first detection creates a card')
assert.equal((await allCaptures()).length, 1)

// Same display URL, different signed token → same id, refreshed url/metadata.
const second = await addCapture({ ...base, url: 'https://cdn.com/video.mp4?token=xyz', filename: 'renamed.mp4' })
assert.equal(second.id, first.id, 're-detection reuses the same card')
assert.equal(second.url, 'https://cdn.com/video.mp4?token=xyz', 'refreshed with the new signed URL')
assert.equal(second.filename, 'renamed.mp4', 'fresher metadata applied')
assert.equal((await allCaptures()).length, 1, 'still exactly one card')
pass += 4

// ── Different type → separate card ──────────────────────────────────────────

const other = await addCapture({ ...base, url: 'https://cdn.com/video.mp4?token=abc', type: 'document' })
assert.notEqual(other.id, first.id, 'type is part of the dedup identity')
assert.equal((await allCaptures()).length, 2)
pass += 2

// ── Consumed captures do not silently reappear ──────────────────────────────

const { updateCapture } = await import('../src/store.js')
await updateCapture(first.id, { status: 'submitted' })
const after = await addCapture({ ...base, url: 'https://cdn.com/video.mp4?token=qqq' })
assert.equal(after, null, 'consumed capture does not reappear on re-detection')
pass += 1

// A genuinely NEW literal URL (different display path) is a new event.
const fresh = await addCapture({ ...base, url: 'https://cdn.com/video2.mp4?token=abc' })
assert.ok(fresh && fresh.id !== first.id, 'different display URL creates a new card')
pass += 1

// ── pruneAgainstServer matches on display URLs ──────────────────────────────

const kept = await pruneAgainstServer(['https://cdn.com/video.mp4?token=whatever'])
const urls = kept.map((c) => displayUrlOf(c.url))
assert.ok(urls.includes('https://cdn.com/video.mp4'), 'pending set matched by display URL')
pass += 1

console.log(`store: ${pass} checks passed`)
