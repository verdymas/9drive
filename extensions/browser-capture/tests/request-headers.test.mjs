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

test('captures the browser-equivalence allowlist from the matching requestId', () => {
  const tracker = new RequestHeaderTracker()
  const headers = [
    { name: 'sec-ch-ua-platform', value: '"Windows"' },
    { name: 'User-Agent', value: 'Mozilla/5.0 Chrome/155' },
    { name: 'sec-ch-ua', value: '"Google Chrome";v="155"' },
    { name: 'sec-ch-ua-mobile', value: '?0' },
    { name: 'Sec-Fetch-Site', value: 'cross-site' },
    { name: 'Sec-Fetch-Mode', value: 'no-cors' },
    { name: 'Sec-Fetch-Dest', value: 'video' },
    { name: 'Sec-Fetch-Storage-Access', value: 'active' },
    { name: 'Referer', value: 'https://site.example/post/1.html' },
    { name: 'Accept-Encoding', value: 'identity' },
    { name: 'Accept-Language', value: 'en-US,en;q=0.9' },
    { name: 'Cookie', value: 'session=abc' },
  ]
  tracker.record('req-1', 'https://media.example/video.mp4', headers)
  assert.deepEqual(tracker.snapshot('req-1', 'https://media.example/video.mp4'), {
    secChUaPlatform: '"Windows"',
    userAgent: 'Mozilla/5.0 Chrome/155',
    secChUa: '"Google Chrome";v="155"',
    secChUaMobile: '?0',
    secFetchSite: 'cross-site',
    secFetchMode: 'no-cors',
    secFetchDest: 'video',
    secFetchStorageAccess: 'active',
    referer: 'https://site.example/post/1.html',
    acceptEncoding: 'identity',
    acceptLanguage: 'en-US,en;q=0.9',
    cookie: 'session=abc',
  })
  // Another requestId never sees these headers.
  assert.equal(tracker.snapshot('req-2', 'https://media.example/video.mp4'), null)
})

test('strips transport-controlled, authorization and range headers', () => {
  const tracker = new RequestHeaderTracker()
  tracker.record('req-1', 'https://media.example/video.mp4', [
    { name: 'Connection', value: 'keep-alive' },
    { name: 'Host', value: 'media.example' },
    { name: 'Content-Length', value: '123' },
    { name: 'Authorization', value: 'Bearer secret' },
    { name: 'Range', value: 'bytes=5-10' },
    { name: 'X-Custom', value: 'evil' },
    { name: 'User-Agent', value: 'Browser' },
  ])
  assert.deepEqual(tracker.snapshot('req-1', 'https://media.example/video.mp4'), { userAgent: 'Browser' })
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
