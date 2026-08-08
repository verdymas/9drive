import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatDisplayUrl, hlsActivityLine, hlsSummaryLine, progressPercent } from '@/pages/RemoteImportsPage'
import { formatDuration } from '@/components/drive/RemoteImportModal'
import { Button } from '@/components/ui/button'
import {
  CONVERT_RETRYABLE_CODES,
  accountLabel,
  bytesOf,
  elapsedSecondsSince,
  formatShortDuration,
  isConvertRetryable,
  percentOf,
  type RemoteImportItem,
} from '@/lib/remoteImports'

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
  uploadTotalBytes: null,
  uploadProgress: 0,
  queuedAt: null,
  retryRequestedAt: null,
  heartbeatAt: null,
  retryFromStage: null,
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

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('measures the upload against uploadTotalBytes (final output size) when present', () => {
    // HLS: source totalBytes 1 GB, output 500 MB — the bar must move against
    // the OUTPUT size, never the source total (which would read 6% etc.).
    expect(
      progressPercent(
        item({ stage: 'uploading', totalBytes: '1073741824', uploadTotalBytes: '536870912', downloadedBytes: '1073741824', uploadedBytes: '268435456' }),
      ),
    ).toBe(50)
  })

  it('falls back to totalBytes when uploadTotalBytes is absent (older rows)', () => {
    expect(progressPercent(item({ stage: 'uploading', totalBytes: '1000', uploadTotalBytes: null, uploadedBytes: '250' }))).toBe(25)
  })

  it('clamps below 100 until the active stage finishes', () => {
    expect(progressPercent(item({ stage: 'downloading', downloadedBytes: '999', uploadedBytes: '0' }))).toBe(99)
    expect(progressPercent(item({ stage: 'uploading', downloadedBytes: '1000', uploadedBytes: '999' }))).toBe(99)
  })

  it('never goes negative', () => {
    expect(progressPercent(item({ stage: 'downloading', downloadedBytes: '-5', uploadedBytes: '0' }))).toBe(0)
  })
})

describe('bytesOf / percentOf', () => {
  it('parses byte strings to numbers, NaN and negative to 0', () => {
    expect(bytesOf('512')).toBe(512)
    expect(bytesOf('12.5')).toBe(12.5)
    expect(bytesOf('')).toBe(0)
    expect(bytesOf(null)).toBe(0)
    expect(bytesOf('-5')).toBe(0)
    expect(bytesOf('not-a-number')).toBe(0)
  })

  it('clamps percent to [0, 100]', () => {
    expect(percentOf('500', '1000')).toBe(50)
    expect(percentOf('1500', '1000')).toBe(100)
    expect(percentOf('-5', '1000')).toBe(0)
    expect(percentOf('250', '0')).toBe(0)
  })
})

describe('accountLabel', () => {
  it('prefers displayName, then email, then a provider fallback', () => {
    expect(accountLabel(item({ connectedAccount: { id: 'a', provider: 'google_drive', email: 'a@example.com', displayName: 'Alice' } }))).toBe('Alice')
    expect(accountLabel(item({ connectedAccount: { id: 'a', provider: 's3', email: 'a@example.com', displayName: null } }))).toBe('a@example.com')
    expect(accountLabel(item({ connectedAccount: { id: 'a', provider: 's3', email: null, displayName: null } }))).toBe('S3')
    expect(accountLabel(item({ connectedAccount: null }))).toBe('storage')
  })
})

describe('elapsedSecondsSince / formatShortDuration', () => {
  it('computes elapsed seconds from an ISO timestamp', () => {
    const t = Date.now()
    expect(elapsedSecondsSince(new Date(t - 90_000).toISOString(), t)).toBe(90)
    expect(elapsedSecondsSince(null, t)).toBe(0)
    expect(elapsedSecondsSince('garbage', t)).toBe(0)
  })

  it('formats short durations like the "waiting 2m 3s" label', () => {
    expect(formatShortDuration(3)).toBe('3s')
    expect(formatShortDuration(123)).toBe('2m 3s')
    expect(formatShortDuration(3_723)).toBe('1h 2m')
  })
})

describe('formatDuration', () => {
  it('formats seconds as h:mm:ss', () => {
    expect(formatDuration(12)).toBe('0:00:12')
    expect(formatDuration(5423.5)).toBe('1:30:24')
    expect(formatDuration(3600)).toBe('1:00:00')
  })

  it('handles null / invalid inputs', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })
})

describe('hlsActivityLine', () => {
  it('shows segment counts while downloading a finite VOD', () => {
    expect(hlsActivityLine(item({ sourceType: 'hls_media', stage: 'segments', hlsIsLive: false, hlsSegmentCount: 420, hlsCompletedSegmentCount: 128 }))).toBe('Downloading HLS segments · 128 / 420')
  })

  it('shows elapsed vs target duration while recording live', () => {
    expect(hlsActivityLine(item({ sourceType: 'hls_media', stage: 'segments', hlsIsLive: true, hlsMediaDurationSeconds: 1112, hlsRecordingDurationSeconds: 3600 }))).toBe('Recording live stream · 0:18:32 / 1:00:00')
  })

  it('shows remux progress during remuxing', () => {
    expect(hlsActivityLine(item({ sourceType: 'hls_media', stage: 'remuxing', remuxProgress: 0.74 }))).toBe('Remuxing media · 74%')
  })

  it('is null for non-HLS imports', () => {
    expect(hlsActivityLine(item({ stage: 'segments' }))).toBeNull()
  })
})

describe('hlsSummaryLine', () => {
  it('combines quality, language, container and duration', () => {
    expect(hlsSummaryLine(item({ sourceType: 'hls_master', hlsVariantHeight: 1080, hlsAudioTrackLanguage: 'en', hlsOutputContainer: 'mkv', hlsMediaDurationSeconds: 5423.5 }))).toBe('HLS video · 1080p · en · MKV · 1:30:24')
  })

  it('includes the recording target for live sources', () => {
    expect(hlsSummaryLine(item({ sourceType: 'hls_media', hlsIsLive: true, hlsRecordingDurationSeconds: 3600 }))).toBe('HLS video · rec 1:00:00')
  })

  it('falls back to a neutral label with no metadata', () => {
    expect(hlsSummaryLine(item({ sourceType: 'hls_master' }))).toBe('HLS video')
  })
})

describe('isConvertRetryable', () => {
  it('is true for a failed HLS import with a remux/verify error code', () => {
    for (const code of CONVERT_RETRYABLE_CODES) {
      expect(isConvertRetryable(item({ status: 'failed', sourceType: 'hls_master', errorCode: code }))).toBe(true)
    }
  })

  it('is false for a failed HLS import with any other error code', () => {
    expect(isConvertRetryable(item({ status: 'failed', sourceType: 'hls_media', errorCode: 'HLS_INVALID_MANIFEST' }))).toBe(false)
    expect(isConvertRetryable(item({ status: 'failed', sourceType: 'hls_media', errorCode: 'HLS_SEGMENT_DOWNLOAD_FAILED' }))).toBe(false)
    expect(isConvertRetryable(item({ status: 'failed', sourceType: 'hls_media', errorCode: null }))).toBe(false)
  })

  it('is false for a non-failed or non-HLS import even with a retryable code', () => {
    expect(isConvertRetryable(item({ status: 'processing', sourceType: 'hls_master', errorCode: 'HLS_REMUX_FAILED' }))).toBe(false)
    expect(isConvertRetryable(item({ status: 'failed', sourceType: null, errorCode: 'HLS_REMUX_FAILED' }))).toBe(false)
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

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      if (path.startsWith('/remote-imports')) {
        return {
          items: [
            item({
              id: 'with-ctx',
              fileName: 'protected.mkv',
              status: 'completed',
              requestContext: { attached: true, referer: true, origin: false, userAgent: false, cookie: true },
            }),
            item({ id: 'plain', fileName: 'plain.bin', status: 'completed' }),
          ],
          cursor: null,
        }
      }
      if (path.startsWith('/connected-accounts')) return { accounts: [] }
      if (path.startsWith('/folders')) return { folders: [] }
      return {}
    }),
  }
})

describe('request-context badge (spec §36)', () => {
  it('shows "Request context attached" when the row carries attached context, and never values', async () => {
    const { RemoteImportsPage } = await import('@/pages/RemoteImportsPage')
    render(<RemoteImportsPage />)
    expect(await screen.findByText('Request context attached')).toBeInTheDocument()
    expect(screen.getByText('protected.mkv')).toBeInTheDocument()
    // Values are never rendered — only the boolean summary drives the badge.
    expect(screen.queryByText(/session=/)).not.toBeInTheDocument()
    expect(screen.queryByText(/cookie/i)).not.toBeInTheDocument()
  })
})
