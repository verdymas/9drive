import { describe, expect, it } from 'vitest'
import { buildFilesQuery } from './useAllFiles'

describe('useAllFiles query boundary', () => {
  it('preserves folder, text, and advanced file filters in the API path', () => {
    const params = new URLSearchParams({
      kind: 'video',
      accountId: 'account-1',
      minSize: '1048576',
      maxSize: '10485760',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-31T00:00:00.000Z',
    })

    expect(buildFilesQuery('folder-1', 'demo file', params)).toBe(
      '/files?folderId=folder-1&q=demo+file&kind=video&accountId=account-1&minSize=1048576&maxSize=10485760&startDate=2026-01-01T00%3A00%3A00.000Z&endDate=2026-01-31T00%3A00%3A00.000Z',
    )
  })
})
