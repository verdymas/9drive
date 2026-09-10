import { describe, expect, it } from 'vitest'
import {
  metaForMultipartFile,
  multipartUploadResponse,
  parseMultipartBatchMeta,
  type MultipartUploadMeta,
} from './multipart-upload-contract.js'

describe('multipart upload contract helpers', () => {
  const completed = { id: 'file-1', name: 'report.txt', sizeBytes: '3' }

  it('uses fields received before a single file as its declared metadata', () => {
    const result = metaForMultipartFile(
      null,
      { sizeBytes: 3n, fileName: 'report.txt', mimeType: 'text/plain', folderId: 'folder-1' },
      'file',
      { filename: 'ignored.txt', mimeType: 'application/octet-stream' },
    )

    expect(result).toEqual({ fieldName: 'file', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 3n, folderId: 'folder-1' })
  })

  it('uses filesMeta by multipart field name for a batch', () => {
    const batch = parseMultipartBatchMeta(JSON.stringify([
      { fieldName: 'file-0', fileName: 'first.txt', mimeType: 'text/plain', sizeBytes: '3', folderId: 'folder-1' },
      { fieldName: 'file-1', fileName: 'second.txt', mimeType: 'text/plain', sizeBytes: 4 },
    ]))

    expect(metaForMultipartFile(batch, {}, 'file-1', { filename: 'ignored.txt', mimeType: 'application/octet-stream' }))
      .toEqual({ fieldName: 'file-1', fileName: 'second.txt', mimeType: 'text/plain', sizeBytes: 4n, folderId: undefined })
  })

  it('preserves the legacy single-file success response', () => {
    expect(multipartUploadResponse(null, [completed], [])).toEqual({ status: 201, body: { file: completed } })
  })

  it('returns the first failure as the all-failed response while retaining failure details', () => {
    const failed = [{ fileName: 'report.txt', code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' }]

    expect(multipartUploadResponse(null, [], failed)).toEqual({
      status: 400,
      body: { code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.', failed },
    })
  })

  it('uses the batch response shape when filesMeta was supplied, including mixed outcomes', () => {
    const batch: MultipartUploadMeta[] = [{ fieldName: 'file-0', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: 3n }]
    const failed = [{ fileName: 'bad.txt', code: 'UPLOAD_FAILED', message: 'provider unavailable' }]

    expect(multipartUploadResponse(batch, [completed], failed)).toEqual({ status: 201, body: { files: [completed], failed } })
  })
})
