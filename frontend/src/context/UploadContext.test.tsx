import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UploadProvider, useUpload } from './UploadContext'
import * as Api from '@/lib/api'

/**
 * Behaviour tests for the batch-upload space preflight (multi-file uploads).
 *
 * The upload flow uses `apiFetch` (preflight + resumable init) and raw `fetch`
 * (chunk PUT). Both are mocked; the File objects are small enough (1 byte) that
 * a single chunk covers them, so a mocked 200 on the chunk PUT completes the
 * upload.
 */

// jsdom File type compat: type as unknown and cast for the slice() usage.
function makeFile(name: string, size = 1): File {
  const content = new ArrayBuffer(size)
  const view = new Uint8Array(content)
  view.fill(65)
  return new File([content], name, { type: 'application/octet-stream' })
}

/** A minimal chunk-PUT response that uploadSingleFileResumable accepts. */
function chunkResponse(offset: number, status: 'uploading' | 'completed' = 'uploading') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status, offset: String(offset) }),
  } as Response
}

function renderHarness() {
  function Harness() {
    const { uploadFiles, uploadProgress } = useUpload()
    return (
      <div>
        <button
          onClick={() => uploadFiles([makeFile('a.bin'), makeFile('b.bin')], null, 'acc-1')}
          data-testid="trigger"
        >
          upload
        </button>
        <div data-testid="progress">{JSON.stringify(uploadProgress)}</div>
      </div>
    )
  }
  const utils = render(<UploadProvider><Harness /></UploadProvider>)
  return { ...utils, trigger: () => userEvent.click(screen.getByTestId('trigger')) }
}

let initCalls: Array<{ fileName: string; targetAccountId?: string }> = []

beforeEach(() => {
  initCalls = []
  vi.spyOn(Api, 'apiFetch').mockImplementation(async (path: string, options?: RequestInit) => {
    const url = String(path)
    if (url.includes('/uploads/resumable/init')) {
      const body = JSON.parse(String((options?.body as string) ?? '{}'))
      initCalls.push({ fileName: body.fileName, targetAccountId: body.targetAccountId })
      return { sessionId: `session-${initCalls.length}`, provider: 'google_drive' }
    }
    if (url.includes('/uploads/resumable/preflight')) {
      return {
        plans: [
          { fileName: 'a.bin', accountId: 'acc-a', provider: 'google_drive', reason: null },
          { fileName: 'b.bin', accountId: 'acc-b', provider: 'google_drive', reason: null },
        ],
        totalBytes: '2',
        totalRoutedBytes: '2',
        unroutedBytes: '0',
      }
    }
    throw new Error(`unexpected apiFetch path: ${url}`)
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => chunkResponse(1, 'completed'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UploadContext batch preflight', () => {
  it('calls the preflight endpoint once for a multi-file batch', async () => {
    const preflightSpy = vi.spyOn(Api, 'apiFetch')
    renderHarness()
    await userEvent.click(screen.getByTestId('trigger'))
    await waitFor(() => {
      expect(preflightSpy).toHaveBeenCalledWith(
        '/uploads/resumable/preflight',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"fileName":"a.bin"'),
        }),
      )
    })
    const preflightCalls = preflightSpy.mock.calls.filter(([path]) => String(path).includes('/preflight'))
    expect(preflightCalls).toHaveLength(1)
  })

  it('passes the planned accountId as the targetAccountId for each init call', async () => {
    renderHarness()
    await userEvent.click(screen.getByTestId('trigger'))
    await waitFor(() => expect(initCalls.length).toBe(2))
    expect(initCalls).toEqual([
      { fileName: 'a.bin', targetAccountId: 'acc-a' },
      { fileName: 'b.bin', targetAccountId: 'acc-b' },
    ])
  })

  it('marks a file with no plan as error up-front and does not init it', async () => {
    // Preflight routes a.bin, but b.bin has no space.
    vi.spyOn(Api, 'apiFetch').mockImplementation(async (path: string, options?: RequestInit) => {
      const url = String(path)
      if (url.includes('/uploads/resumable/init')) {
        const body = JSON.parse(String((options?.body as string) ?? '{}'))
        initCalls.push({ fileName: body.fileName, targetAccountId: body.targetAccountId })
        return { sessionId: `session-${initCalls.length}`, provider: 'google_drive' }
      }
      if (url.includes('/uploads/resumable/preflight')) {
        return {
          plans: [
            { fileName: 'a.bin', accountId: 'acc-a', provider: 'google_drive', reason: null },
            { fileName: 'b.bin', accountId: null, provider: null, reason: 'insufficient' },
          ],
          totalBytes: '2',
          totalRoutedBytes: '1',
          unroutedBytes: '1',
        }
      }
      throw new Error(`unexpected apiFetch path: ${url}`)
    })

    renderHarness()
    await userEvent.click(screen.getByTestId('trigger'))
    await waitFor(() => expect(initCalls.length).toBe(1))
    expect(initCalls[0]).toMatchObject({ fileName: 'a.bin' })
    // b.bin skipped without an init call; overall status is partial.
    await waitFor(() => {
      const progress = JSON.parse(screen.getByTestId('progress').textContent ?? '{}')
      const b = progress.files.find((f: { name: string }) => f.name === 'b.bin')
      expect(b.status).toBe('error')
      expect(b.errorMessage).toContain('Not enough space')
      expect(progress.status).toBe('partial')
    })
  })

  it('continues uploading without plans when the preflight itself fails', async () => {
    vi.spyOn(Api, 'apiFetch').mockImplementation(async (path: string, options?: RequestInit) => {
      const url = String(path)
      if (url.includes('/uploads/resumable/init')) {
        const body = JSON.parse(String((options?.body as string) ?? '{}'))
        initCalls.push({ fileName: body.fileName, targetAccountId: body.targetAccountId })
        return { sessionId: `session-${initCalls.length}`, provider: 'google_drive' }
      }
      if (url.includes('/uploads/resumable/preflight')) {
        throw new Error('preflight down')
      }
      throw new Error(`unexpected apiFetch path: ${url}`)
    })

    renderHarness()
    await userEvent.click(screen.getByTestId('trigger'))
    await waitFor(() => expect(initCalls.length).toBe(2))
    // Falls back to the caller's targetAccountId (acc-1) for both files.
    expect(initCalls.every((call) => call.targetAccountId === 'acc-1')).toBe(true)
  })

  it('surfaces a reroute notice when the pinned account is full and the server routes elsewhere', async () => {
    // Pin to acc-pinned; the server routes the file to acc-routed instead.
    function PinnedHarness() {
      const { uploadFiles, uploadProgress } = useUpload()
      return (
        <div>
          <button
            onClick={() => uploadFiles([makeFile('pinned.bin')], null, 'acc-pinned', 'acc-pinned@example.com')}
            data-testid="trigger-pinned"
          >
            upload pinned
          </button>
          <div data-testid="progress-pinned">{JSON.stringify(uploadProgress)}</div>
        </div>
      )
    }
    vi.spyOn(Api, 'apiFetch').mockImplementation(async (path: string) => {
      if (String(path).includes('/uploads/resumable/init')) {
        return { sessionId: 'session-1', provider: 'google_drive', targetAccountId: 'acc-routed', targetAccountEmail: 'acc-routed@example.com' }
      }
      throw new Error(`unexpected apiFetch path: ${path}`)
    })

    render(<UploadProvider><PinnedHarness /></UploadProvider>)
    await userEvent.click(screen.getByTestId('trigger-pinned'))
    await waitFor(() => {
      const progress = JSON.parse(screen.getByTestId('progress-pinned').textContent ?? '{}')
      expect(progress.files[0].errorMessage).toContain('No space on acc-pinned@example.com')
      expect(progress.files[0].errorMessage).toContain('acc-routed@example.com')
      expect(progress.files[0].status).toBe('done')
    })
  })

  it('skips the preflight for a single-file upload', async () => {
    function SingleHarness() {
      const { uploadFiles } = useUpload()
      return (
        <button
          onClick={() => uploadFiles([makeFile('single.bin')], null, undefined)}
          data-testid="trigger-single"
        >
          single
        </button>
      )
    }
    const apiSpy = vi.spyOn(Api, 'apiFetch')
    render(<UploadProvider><SingleHarness /></UploadProvider>)
    await userEvent.click(screen.getByTestId('trigger-single'))
    await waitFor(() => expect(initCalls.length).toBe(1))
    const preflightCalls = apiSpy.mock.calls.filter(([path]) => String(path).includes('/preflight'))
    expect(preflightCalls).toHaveLength(0)
  })
})
