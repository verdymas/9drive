import { describe, expect, it } from 'vitest'
import { serializeRemoteImport } from './remote-import.service.js'

describe('serializeRemoteImport', () => {
  it('coerces every BigInt byte field to a string', () => {
    const row = {
      id: 'import-1',
      fileName: 'movie.mkv',
      totalBytes: 12345678901234567890n,
      downloadedBytes: 2048n,
      uploadedBytes: 2048n,
    }
    expect(serializeRemoteImport(row)).toMatchObject({
      totalBytes: '12345678901234567890',
      downloadedBytes: '2048',
      uploadedBytes: '2048',
    })
    expect(typeof serializeRemoteImport(row).totalBytes).toBe('string')
  })

  it('serializes a null totalBytes as null', () => {
    const serialized = serializeRemoteImport({ id: 'import-2', totalBytes: null, downloadedBytes: 0n, uploadedBytes: 0n })
    expect(serialized.totalBytes).toBeNull()
  })

  it('defines a JSON-safe payload with a nested file relation (regression: sizeBytes BigInt)', () => {
    const row = {
      id: 'import-3',
      totalBytes: null,
      downloadedBytes: 100n,
      uploadedBytes: 100n,
      file: { id: 'file-1', name: 'movie.mkv', sizeBytes: 100n },
    }
    const serialized = serializeRemoteImport(row)
    expect(serialized.file?.sizeBytes).toBe('100')
    expect(() => JSON.stringify(serialized)).not.toThrow()
    expect(JSON.parse(JSON.stringify(serialized)).file.sizeBytes).toBe('100')
  })
})