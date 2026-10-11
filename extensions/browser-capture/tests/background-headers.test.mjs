import test from 'node:test'
import assert from 'node:assert/strict'

// Captured browser headers win; page URL is only a Referer fallback and
// Origin is never synthesized when the browser did not send one.
test('submits captured browser headers with captured referer winning', async () => {
  const listeners = {}
  const event = (name) => ({ addListener(fn, _filter, options) { (listeners[name] ??= []).push({ fn, options }) } })
  const storage = { '9drive.config': { baseUrl: 'https://app.example', deviceToken: 'device-token' } }
  const posts = []
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.1.0' }), onInstalled: event('installed'), onMessage: event('message') },
    webRequest: { onBeforeRequest: event('before'), onBeforeSendHeaders: event('send'), onHeadersReceived: event('headers'), onCompleted: event('completed'), onErrorOccurred: event('error') },
    storage: {
      local: { get: async (key) => key === null ? { ...storage } : Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, storage[k]])), set: async (patch) => Object.assign(storage, patch) },
      session: { get: async () => ({}) },
    },
    contextMenus: { create() {}, onClicked: event('menu') },
    alarms: { create() {}, onAlarm: event('alarm') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  }
  globalThis.fetch = async (_url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, text: async () => JSON.stringify({ id: 'remote-1' }) } }
  // Cache-busting query: each test re-evaluates the module against its own
  // mocked chrome object (Node caches by specifier).
  await import('../src/background.js?headers-1')
  const url = 'https://media.example/video.mp4'
  const details = { requestId: 'one', url, type: 'media', originUrl: 'https://page.example/watch' }
  listeners.before[0].fn(details)
  listeners.send[0].fn({
    ...details,
    requestHeaders: [
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
      { name: 'Range', value: 'bytes=5-10' },
      { name: 'Authorization', value: 'Bearer secret' },
    ],
  })
  await listeners.headers[0].fn({ ...details, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const ctx = posts[0].requestContext
  assert.equal(ctx.secFetchDest, 'video')
  assert.equal(ctx.secFetchSite, 'cross-site')
  assert.equal(ctx.secFetchMode, 'no-cors')
  assert.equal(ctx.secFetchStorageAccess, 'active')
  assert.equal(ctx.secChUaPlatform, '"Windows"')
  assert.equal(ctx.secChUaMobile, '?0')
  assert.equal(ctx.acceptEncoding, 'identity')
  assert.equal(ctx.acceptLanguage, 'en-US,en;q=0.9')
  // Captured Referer wins over the page URL; Origin is never synthesized.
  assert.equal(ctx.referer, 'https://site.example/post/1.html')
  assert.equal(ctx.origin, undefined)
  // Captured Range / Authorization never cross the wire.
  assert.equal('range' in ctx, false)
  assert.equal('authorization' in ctx, false)
  assert.equal(JSON.stringify(posts[0]).includes('Bearer secret'), false)
})

test('falls back to the page URL referer without inventing origin', async () => {
  const listeners = {}
  const event = (name) => ({ addListener(fn, _filter, options) { (listeners[name] ??= []).push({ fn, options }) } })
  const storage = { '9drive.config': { baseUrl: 'https://app.example', deviceToken: 'device-token' } }
  const posts = []
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.1.0' }), onInstalled: event('installed'), onMessage: event('message') },
    webRequest: { onBeforeRequest: event('before'), onBeforeSendHeaders: event('send'), onHeadersReceived: event('headers'), onCompleted: event('completed'), onErrorOccurred: event('error') },
    storage: {
      local: { get: async (key) => key === null ? { ...storage } : Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, storage[k]])), set: async (patch) => Object.assign(storage, patch) },
      session: { get: async () => ({}) },
    },
    contextMenus: { create() {}, onClicked: event('menu') },
    alarms: { create() {}, onAlarm: event('alarm') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  }
  globalThis.fetch = async (_url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, text: async () => JSON.stringify({ id: 'remote-1' }) } }
  await import('../src/background.js?headers-2')
  const url = 'https://media.example/clip.mp4'
  const details = { requestId: 'two', url, type: 'media', originUrl: 'https://page.example/watch/2' }
  listeners.before[0].fn(details)
  listeners.send[0].fn({ ...details, requestHeaders: [{ name: 'User-Agent', value: 'Browser' }] })
  await listeners.headers[0].fn({ ...details, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(posts[0].requestContext.referer, 'https://page.example/watch/2')
  assert.equal(posts[0].requestContext.origin, undefined)
})
