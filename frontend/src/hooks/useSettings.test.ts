import { describe, expect, it } from 'vitest'
import { initialS3Form, providerLabel } from './useSettings'

describe('useSettings account boundary', () => {
  it('keeps provider labels and a clean S3 form at the hook boundary', () => {
    expect(providerLabel('google_drive')).toBe('Google Drive')
    expect(providerLabel('s3')).toBe('S3 Storage')
    expect(providerLabel('telegram')).toBe('Telegram Drive')
    expect(initialS3Form).toMatchObject({ region: 'us-east-1', forcePathStyle: false, quotaBytes: '' })
  })
})
