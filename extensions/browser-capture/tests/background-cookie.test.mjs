import test from 'node:test'
import assert from 'node:assert/strict'

test('submits the observed Cookie without saving or showing it locally', async () => {
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
  await import('../src/background.js')
  assert.deepEqual(listeners.send[0].options, ['requestHeaders', 'extraHeaders'])
  const url = 'https://media.example/video.mp4'
  const details = { requestId: 'one', url, type: 'media', originUrl: 'https://page.example/watch' }
  listeners.before[0].fn(details)
  listeners.send[0].fn({ ...details, requestHeaders: [{ name: 'Cookie', value: 'session=private-value' }, { name: 'User-Agent', value: 'Browser UA' }] })
  await listeners.headers[0].fn({ ...details, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(posts[0].requestContext.cookie, 'session=private-value')
  assert.equal(posts[0].requestContext.userAgent, 'Browser UA')
  assert.equal(JSON.stringify(storage['9drive.captures']).includes('private-value'), false)
  listeners.completed[0].fn(details)
  listeners.before[0].fn(details)
  listeners.send[0].fn({ ...details, requestHeaders: [{ name: 'User-Agent', value: 'Browser UA' }] })
  await listeners.headers[0].fn({ ...details, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(posts[1].requestContext.cookie, undefined)
  const popup = await new Promise((resolve) => listeners.message.at(-1).fn({ type: 'getState' }, {}, resolve))
  assert.equal(JSON.stringify(popup).includes('private-value'), false)
})
