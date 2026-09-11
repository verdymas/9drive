import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  busboy: vi.fn(),
  env: { MAX_UPLOAD_BYTES: 5, UPLOAD_TEMP_DIR: './tmp', TOKEN_ENCRYPTION_KEY: 'test-encryption-key' },
}))

vi.mock('busboy', () => ({ default: h.busboy }))
vi.mock('../../config/env.js', () => ({ env: h.env }))

import { processMultipartUpload } from './multipart-upload.service.js'

describe('processMultipartUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.busboy.mockImplementation(() => new EventEmitter())
  })

  it('returns the compatibility error when parsing finishes without a file part', async () => {
    const parser = new EventEmitter() as EventEmitter & { emit: EventEmitter['emit'] }
    h.busboy.mockReturnValue(parser)
    const request = {
      headers: { 'content-type': 'multipart/form-data; boundary=test' },
      once: vi.fn(),
      pipe: vi.fn(() => queueMicrotask(() => parser.emit('finish'))),
      unpipe: vi.fn(),
      resume: vi.fn(),
    }

    await expect(processMultipartUpload(request as any, 'user-1')).resolves.toEqual({
      status: 400,
      body: { code: 'UPLOAD_FILE_REQUIRED', message: 'file field required.' },
    })
    expect(request.unpipe).toHaveBeenCalledWith(parser)
    expect(request.resume).toHaveBeenCalled()
  })
})
