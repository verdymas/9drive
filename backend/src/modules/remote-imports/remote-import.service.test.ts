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

  it('passes HLS fields through unchanged and stays JSON-safe', () => {
    const row = {
      id: 'import-4',
      totalBytes: null,
      downloadedBytes: 0n,
      uploadedBytes: 0n,
      sourceType: 'hls_media',
      hlsPlaylistType: 'vod',
      hlsVariantId: null,
      hlsVariantBandwidth: null,
      hlsVariantWidth: null,
      hlsVariantHeight: null,
      hlsAudioTrackId: null,
      hlsAudioTrackLanguage: 'en',
      hlsOutputContainer: 'mkv',
      hlsIsLive: false,
      hlsRecordingDurationSeconds: null,
      hlsMediaDurationSeconds: 1234.5,
      hlsSegmentCount: 42,
      hlsCompletedSegmentCount: 42,
      remuxProgress: 0.55,
      outputDurationSeconds: 1234.5,
      outputCodecSummary: 'h264, aac',
    }
    const serialized = serializeRemoteImport(row)
    expect(serialized.sourceType).toBe('hls_media')
    expect(serialized.hlsPlaylistType).toBe('vod')
    expect(serialized.hlsMediaDurationSeconds).toBe(1234.5)
    expect(serialized.hlsSegmentCount).toBe(42)
    expect(serialized.hlsCompletedSegmentCount).toBe(42)
    expect(serialized.remuxProgress).toBe(0.55)
    expect(serialized.hlsOutputContainer).toBe('mkv')
    expect(serialized.hlsIsLive).toBe(false)
    expect(() => JSON.stringify(serialized)).not.toThrow()
  })
})