import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'

import { telegramDownloadToReadable } from './telegram.service.js'

/** A fake openTelegramDocument result. `onReturn` fires when the async
 *  generator is finished (normally or via return()) — proves client abort
 *  propagates into the source iterable. */
function fakeDownload(chunks: Buffer[], onReturn: () => void) {
  return {
    stream: (async function* () {
      try {
        for (const chunk of chunks) yield chunk
      } finally {
        onReturn()
      }
    })(),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function collect(readable: Readable): Promise<Buffer[]> {
  const out: Buffer[] = []
  for await (const chunk of readable) out.push(chunk as Buffer)
  return out
}

const KB = 1024

describe('telegramDownloadToReadable', () => {
  it('trims mid-chunk to the exact requested byte count', async () => {
    const download = fakeDownload([Buffer.alloc(512 * KB), Buffer.alloc(512 * KB)], () => undefined)
    const readable = telegramDownloadToReadable(download, 512 * KB + 100)

    const chunks = await collect(readable)

    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    expect(total).toBe(512 * KB + 100)
    expect(chunks[0].length).toBe(512 * KB)
    expect(chunks[1].length).toBe(100)
    expect(download.close).toHaveBeenCalledTimes(1)
  })

  it('passes chunks through untouched at an exact chunk boundary', async () => {
    const download = fakeDownload([Buffer.alloc(512 * KB), Buffer.alloc(512 * KB)], () => undefined)
    const readable = telegramDownloadToReadable(download, 1024 * KB)

    const chunks = await collect(readable)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].length).toBe(512 * KB)
    expect(chunks[1].length).toBe(512 * KB)
    expect(download.close).toHaveBeenCalledTimes(1)
  })

  it('streams everything when no limit is given', async () => {
    const download = fakeDownload([Buffer.alloc(3 * KB), Buffer.alloc(5 * KB)], () => undefined)
    const readable = telegramDownloadToReadable(download)

    const chunks = await collect(readable)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].length).toBe(3 * KB)
    expect(chunks[1].length).toBe(5 * KB)
    expect(download.close).toHaveBeenCalledTimes(1)
  })

  it('stops the source generator and disconnects on client abort', async () => {
    let returned = false
    const download = fakeDownload([Buffer.alloc(512 * KB), Buffer.alloc(512 * KB), Buffer.alloc(512 * KB)], () => {
      returned = true
    })
    const readable = telegramDownloadToReadable(download, 1024 * KB)

    const iterator = readable[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toBeDefined()
    expect(returned).toBe(false)

    readable.destroy()
    await new Promise<void>((resolve) => readable.once('close', () => resolve()))

    expect(returned).toBe(true)
    expect(download.close).toHaveBeenCalledTimes(1)
  })

  it('surfaces a mid-stream error and disconnects once', async () => {
    const download = {
      stream: (async function* () {
        yield Buffer.alloc(1024)
        throw new Error('telegram exploded')
      })(),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const readable = telegramDownloadToReadable(download)

    await expect(collect(readable)).rejects.toThrow('telegram exploded')
    expect(download.close).toHaveBeenCalledTimes(1)
  })
})
