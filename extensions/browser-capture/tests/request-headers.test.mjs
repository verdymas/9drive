import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestHeaderTracker } from '../src/request-headers.js'

test('matches request id and redirect URL without mixing concurrent requests', () => {
  const tracker = new RequestHeaderTracker()
  tracker.record('a', 'https://a.example/first', [{ name: 'Cookie', value: 'a=1' }])
  tracker.record('b', 'https://b.example/file', [{ name: 'Cookie', value: 'b=2' }])
  tracker.record('a', 'https://a.example/final', [{ name: 'Cookie', value: 'a=2' }, { name: 'User-Agent', value: 'Browser' }])
  assert.deepEqual(tracker.snapshot('a', 'https://a.example/final'), { cookie: 'a=2', userAgent: 'Browser' })
  assert.deepEqual(tracker.snapshot('a', 'https://a.example/first'), { cookie: 'a=1' })
  assert.equal(tracker.snapshot('a', 'https://b.example/file'), null)
  assert.deepEqual(tracker.snapshot('b', 'https://b.example/file'), { cookie: 'b=2' })
  tracker.clear('a')
  assert.equal(tracker.snapshot('a', 'https://a.example/final'), null)
})

test('missing Cookie, expiry, and capacity pruning', () => {
  let now = 0
  const tracker = new RequestHeaderTracker({ now: () => now, ttlMs: 10, maxEntries: 2 })
  tracker.record('a', 'https://a.example', [{ name: 'User-Agent', value: 'Browser' }])
  assert.deepEqual(tracker.snapshot('a', 'https://a.example'), { userAgent: 'Browser' })
  tracker.record('b', 'https://b.example', [{ name: 'Cookie', value: 'b=1' }])
  tracker.record('c', 'https://c.example', [{ name: 'Cookie', value: 'c=1' }])
  assert.equal(tracker.snapshot('a', 'https://a.example'), null)
  now = 11
  assert.equal(tracker.snapshot('b', 'https://b.example'), null)
})
