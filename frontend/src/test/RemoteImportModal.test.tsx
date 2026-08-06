import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemoteImportModal } from '@/components/drive/RemoteImportModal'
import * as RemoteImports from '@/lib/remoteImports'

/**
 * Frontend behaviour tests for backend-owned filename detection (spec §7/§8).
 *
 * The measurements rely on a mocked probe endpoint (jsdom has no real network,
 * and the whole point of the design is that the browser never talks to the
 * remote). The 9 scenarios:
 *   1. shows the detecting indicator while a probe is in flight,
 *   2. populates the File Name field from a header-detected probe,
 *   3. shows "Detected from URL" for a URL-path source,
 *   4. does NOT overwrite a manually edited name when a probe lands late,
 *   5. re-probes when the URL changes,
 *   6. probe failure shows the manual-entry hint and does not disable submit,
 *   7. a cancelled/stale response never overwrites a newer probe,
 *   8. submit sends the detected name when the user did not type one,
 *   9. submit sends the custom name when the user typed one (and never the
 *      server name).
 */

const ACCOUNTS = [{ id: 'acc-1', provider: 's3', email: 'a@b.c', status: 'connected' }]
const FOLDERS = [{ id: 'root', name: 'My Drive' }]

/** A complete, valid probe payload with only the fields we care about set. */
function makeProbeResult(overrides: Partial<RemoteImports.ProbeResult> = {}): RemoteImports.ProbeResult {
  return {
    originalUrl: '',
    finalUrl: '',
    fileName: 'file.bin',
    fileNameSource: 'final-url-path',
    mimeType: null,
    contentLength: null,
    supportsRange: false,
    ...overrides,
  }
}

function renderModal() {
  return render(
    <RemoteImportModal open accounts={ACCOUNTS} folders={FOLDERS} onClose={() => {}} onCreated={() => {}} defaultFolderId="f-1" />,
  )
}

async function typeUrl(text: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/file url/i), text)
  return user
}

/** Promise the modal's probe call resolves with (kept pending until released). */
function deferredProbe(): { promise: Promise<{ data: RemoteImports.ProbeResult }>; resolve: (v: { data: RemoteImports.ProbeResult }) => void } {
  let resolve!: (v: { data: RemoteImports.ProbeResult }) => void
  const promise = new Promise<{ data: RemoteImports.ProbeResult }>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.spyOn(RemoteImports, 'probeRemoteUrl').mockImplementation(() => new Promise(() => {}))
  vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RemoteImportModal probe behaviour', () => {
  it('shows "Detecting file name..." while a probe is in flight', async () => {
    renderModal()
    await typeUrl('https://example.com/a.mkv')
    // Debounce is committed — pending probe is never resolved.
    expect(await screen.findByText('Detecting file name...')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/detecting file name/i)).toBeInTheDocument()
  })

  it('populates the File Name field from a header-detected probe', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'movie.mkv', fileNameSource: 'content-disposition-filename', mimeType: 'video/x-matroska', contentLength: 10, supportsRange: true }) })
    renderModal()
    await typeUrl('https://example.com/dl?id=1')
    await waitFor(() => expect(screen.getByDisplayValue('movie.mkv')).toBeInTheDocument())
    expect(screen.getByText(/detected from server header/i)).toBeInTheDocument()
  })

  it('shows "Detected from URL" for a URL-path source', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'ubuntu.iso', fileNameSource: 'final-url-path', mimeType: 'application/x-iso9660-image' }) })
    renderModal()
    await typeUrl('https://example.com/ubuntu.iso')
    await waitFor(() => expect(screen.getByDisplayValue('ubuntu.iso')).toBeInTheDocument())
    expect(screen.getByText(/detected from url/i)).toBeInTheDocument()
  })

  it('does NOT overwrite a manually edited name when a probe lands late', async () => {
    const { promise, resolve } = deferredProbe()
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockImplementationOnce(() => promise)

    renderModal()
    await typeUrl('https://example.com/one.txt')
    await waitFor(() => expect(probe).toHaveBeenCalled())
    // User overrides the file name while the probe is still pending.
    const field = screen.getByLabelText(/file name/i)
    const user = userEvent.setup()
    await user.clear(field)
    await user.type(field, 'my-custom-name.txt')
    expect(field).toHaveValue('my-custom-name.txt')
    // The probe lands late — it must not clobber the manual name.
    resolve({ data: makeProbeResult({ fileName: 'one.txt', fileNameSource: 'content-disposition-filename' }) })
    await waitFor(() => expect(field).toHaveValue('my-custom-name.txt'))
    expect(field).not.toHaveValue('one.txt')
  })

  it('re-probes when the URL changes', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'first.bin' }) })
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'second.bin' }) })
    renderModal()
    await typeUrl('https://example.com/first.bin')
    await waitFor(() => expect(screen.getByDisplayValue('first.bin')).toBeInTheDocument())
    const urlField = screen.getByLabelText(/file url/i)
    const user = userEvent.setup()
    await user.clear(urlField)
    await user.type(urlField, 'https://example.com/second.bin')
    await waitFor(() => expect(screen.getByDisplayValue('second.bin')).toBeInTheDocument())
  })

  it('probe failure shows the manual-entry hint and does not disable submit', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockRejectedValueOnce(new Error('boom'))
    const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
    renderModal()
    await typeUrl('https://example.com/fail.bin')
    await waitFor(() => expect(screen.getAllByText(/file name could not be detected/i).length).toBeGreaterThan(0))
    expect(screen.getByRole('button', { name: /start import/i })).not.toBeDisabled()
    // Manual entry is possible and starts the import.
    await userEvent.type(screen.getByLabelText(/file name/i), 'fallback.bin')
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    await waitFor(() => expect(create).toHaveBeenCalled())
  })

  it('a cancelled response never replaces a newer probe', async () => {
    const { promise, resolve } = deferredProbe()
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockImplementationOnce(() => promise)
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'new.bin' }) })
    renderModal()
    await typeUrl('https://example.com/old.bin')
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    const urlField = screen.getByLabelText(/file url/i)
    const user = userEvent.setup()
    await user.clear(urlField)
    await user.type(urlField, 'https://example.com/new.bin')
    await waitFor(() => expect(screen.getByDisplayValue('new.bin')).toBeInTheDocument())
    // The old probe resolving after the new one must be ignored.
    resolve({ data: makeProbeResult({ fileName: 'old.bin' }) })
    await waitFor(() => expect(screen.getByDisplayValue('new.bin')).toBeInTheDocument())
  })

  it('sends the detected name to the backend when the user did not edit', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'auto.bin', fileNameSource: 'content-disposition-filename' }) })
    const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
    renderModal()
    await typeUrl('https://example.com/auto.bin')
    await waitFor(() => expect(screen.getByDisplayValue('auto.bin')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /start import/i }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({ fileName: 'auto.bin', detectedFileName: 'auto.bin' })
  })

  it('sends the custom name (never the detected) when the user edited', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockResolvedValueOnce({ data: makeProbeResult({ fileName: 'skip.bin', fileNameSource: 'content-disposition-filename' }) })
    const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
    renderModal()
    await typeUrl('https://example.com/skip.bin')
    await waitFor(() => expect(screen.getByDisplayValue('skip.bin')).toBeInTheDocument())
    const field = screen.getByLabelText(/file name/i)
    const user = userEvent.setup()
    await user.clear(field)
    await user.type(field, 'custom.bin')
    await user.click(screen.getByRole('button', { name: /start import/i }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({ fileName: 'custom.bin', detectedFileName: 'skip.bin' })
  })
})
