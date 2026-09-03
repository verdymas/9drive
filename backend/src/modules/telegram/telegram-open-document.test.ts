/**
 * openTelegramDocument offset/limit passthrough tests.
 *
 * Verifies that the WebDAV-range support added to `openTelegramDocument`
 * forwards `{ offset, limit }` into teleproto's `iterDownload` so a byte
 * window (Jellyfin seek / Range GET) can be streamed without downloading the
 * whole document, while existing callers that pass no opts still get the whole
 * file (offset 0, no limit).
 *
 * `openTelegramDocument` lives in telegram.service.ts, whose internal
 * `createTelegramClient` / `resolveConfiguredChannel` calls are lexical and
 * cannot be intercepted by mocking the module itself. Instead we mock the
 * `teleproto` package so the real `createTelegramClient` constructs a fake
 * connected client, and provide real encrypted config via `encryptText`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptText } from '../../utils/crypto.js'
import type { TelegramClient } from 'teleproto'

const h = vi.hoisted(() => {
  const fakeClient = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => [
      // Production checks `message.document` (not `media.document`).
      { id: 42, document: { id: 1n }, media: { className: 'MessageMediaDocument', document: { id: 1n } } },
    ]),
    iterDownload: vi.fn(() => (async function* () {})()),
    getInputEntity: vi.fn(async () => ({})),
    getEntity: vi.fn(async () => ({ id: -100123, title: 'storage', broadcast: true, megagroup: false })),
  }
  class FakeTelegramClient {
    connect = fakeClient.connect
    disconnect = fakeClient.disconnect
    getMessages = fakeClient.getMessages
    iterDownload = fakeClient.iterDownload
    getInputEntity = fakeClient.getInputEntity
    getEntity = fakeClient.getEntity
    constructor(public session: unknown, public apiId: number, public apiHash: string) {}
  }
  return { fakeClient, FakeTelegramClient }
})

// Mock the underlying MTProto package so the REAL createTelegramClient in
// telegram.service.ts builds a FakeTelegramClient instead of a real socket
// connection.
vi.mock('teleproto', () => ({
  TelegramClient: h.FakeTelegramClient,
  sessions: { StringSession: class StringSession {} },
}))

// Imported AFTER the mock is registered.
const { openTelegramDocument } = await import('./telegram.service.js')

const config = {
  apiIdEncrypted: encryptText('12345'),
  apiHashEncrypted: encryptText('api-hash'),
  sessionEncrypted: encryptText('session-string'),
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks wipes default implementations — restore the ones the
  // production code relies on.
  h.fakeClient.connect.mockResolvedValue(undefined)
  h.fakeClient.disconnect.mockResolvedValue(undefined)
  h.fakeClient.getMessages.mockResolvedValue([
    { id: 42, document: { id: 1n }, media: { className: 'MessageMediaDocument', document: { id: 1n } } },
  ])
  h.fakeClient.iterDownload.mockReturnValue((async function* () {})())
  h.fakeClient.getInputEntity.mockResolvedValue({})
  h.fakeClient.getEntity.mockResolvedValue({ id: -100123, title: 'storage', broadcast: true, megagroup: false })
})

describe('openTelegramDocument', () => {
  it('passes offset and limit into iterDownload for a byte range', async () => {
    await openTelegramDocument(config, 'telegram://-100123/42', { offset: 10, limit: 100 })

    expect(h.fakeClient.iterDownload).toHaveBeenCalledWith(
      expect.objectContaining({ className: 'MessageMediaDocument' }),
      { requestSize: 512 * 1024, offset: 10, limit: 100 },
    )
  })

  it('defaults to offset 0 and no limit when opts are omitted (existing callers)', async () => {
    await openTelegramDocument(config, 'telegram://-100123/42')

    expect(h.fakeClient.iterDownload).toHaveBeenCalledWith(
      expect.objectContaining({ className: 'MessageMediaDocument' }),
      { requestSize: 512 * 1024, offset: 0, limit: undefined },
    )
  })

  it('connects the client and returns a close() that disconnects it', async () => {
    const download = await openTelegramDocument(config, 'telegram://-100123/42', { offset: 5, limit: 50 })

    expect(h.fakeClient.connect).toHaveBeenCalled()
    expect(h.fakeClient.getMessages).toHaveBeenCalled()

    await download.close()
    expect(h.fakeClient.disconnect).toHaveBeenCalled()
  })

  it('throws TELEGRAM_FILE_NOT_FOUND and disconnects when the message has no document', async () => {
    h.fakeClient.getMessages.mockResolvedValue([{ id: 42, media: null }])

    await expect(openTelegramDocument(config, 'telegram://-100123/42')).rejects.toMatchObject({
      code: 'TELEGRAM_FILE_NOT_FOUND',
      status: 404,
    })
    // The short-lived client is disconnected on the error path.
    expect(h.fakeClient.disconnect).toHaveBeenCalled()
  })
})
