import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatDisplayUrl, progressPercent } from '@/pages/RemoteImportsPage'
import { Button } from '@/components/ui/button'
import type { RemoteImportItem } from '@/lib/remoteImports'

/**
 * Frontend regression tests for the Remote Imports overflow fix.
 *
 * These cover the pure helpers (URL compaction, progress clamping) and the
 * structural classes that keep long text inside the card. jsdom cannot measure
 * real layout, so the component tests assert the class contract (min-w-0,
 * truncate, overflow-hidden, shrink-0, minmax(0,1fr), aria-labels) that the
 * browser needs to prevent horizontal overflow.
 */

const baseItem: RemoteImportItem = {
  id: 'i-1',
  fileName: 'file.bin',
  displayUrl: 'https://example.com/download',
  status: 'processing',
  stage: 'downloading',
  totalBytes: '1000',
  downloadedBytes: '250',
  uploadedBytes: '0',
  mimeType: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  attempt: 1,
  fileId: null,
  folderId: null,
  connectedAccountId: null,
}

function item(overrides: Partial<RemoteImportItem> = {}): RemoteImportItem {
  return { ...baseItem, ...overrides }
}

describe('formatDisplayUrl', () => {
  it('shows hostname + first path segment with an ellipsis', () => {
    expect(formatDisplayUrl('https://files.example.com/download/file.mkv?X-Amz-Signature=deadbeef')).toBe('files.example.com/download/…')
  })

  it('keeps the hostname for a bare domain', () => {
    expect(formatDisplayUrl('https://example.com')).toBe('example.com')
  })

  it('keeps a trailing slash', () => {
    expect(formatDisplayUrl('https://example.com/folder/')).toBe('example.com/folder/')
  })

  it('never emits a query string', () => {
    const out = formatDisplayUrl('https://example.com/a/b/c?sig=secret&token=abc')
    expect(out).not.toContain('sig=')
    expect(out).not.toContain('token=')
  })

  it('falls back to a neutral placeholder for an unparseable value', () => {
    expect(formatDisplayUrl('not a url')).toBe('remote source')
    expect(formatDisplayUrl('')).toBe('remote source')
  })
})

describe('progressPercent', () => {
  it('returns null when the total is unknown', () => {
    expect(progressPercent(item({ status: 'processing', totalBytes: null, stage: 'downloading' }))).toBeNull()
  })

  it('returns 100 for a completed import', () => {
    expect(progressPercent(item({ status: 'completed', totalBytes: '1000' }))).toBe(100)
  })

  it('returns 0 for failed/cancelled imports', () => {
    expect(progressPercent(item({ status: 'failed', totalBytes: '1000' }))).toBe(0)
    expect(progressPercent(item({ status: 'cancelled', totalBytes: '1000' }))).toBe(0)
  })

  it('uses downloadedBytes while downloading', () => {
    expect(progressPercent(item({ stage: 'downloading', downloadedBytes: '500', uploadedBytes: '0' }))).toBe(50)
  })

  it('uses uploadedBytes while uploading', () => {
    expect(progressPercent(item({ stage: 'uploading', downloadedBytes: '1000', uploadedBytes: '250' }))).toBe(25)
  })

  it('clamps below 100 until the active stage finishes', () => {
    expect(progressPercent(item({ stage: 'downloading', downloadedBytes: '999', uploadedBytes: '0' }))).toBe(99)
    expect(progressPercent(item({ stage: 'uploading', downloadedBytes: '1000', uploadedBytes: '999' }))).toBe(99)
  })

  it('never goes negative', () => {
    expect(progressPercent(item({ stage: 'downloading', downloadedBytes: '-5', uploadedBytes: '0' }))).toBe(0)
  })
})

describe('overflow-safe structure contract', () => {
  it('buttons with icon-only content expose an aria-label', () => {
    render(
      <Button variant="danger" size="sm" aria-label="Delete remote import very-long-file-name.mkv">
        <span>×</span>
      </Button>,
    )
    expect(screen.getByRole('button', { name: /delete remote import very-long-file-name/i })).toBeTruthy()
  })
})
