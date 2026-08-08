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
    sourceType: 'direct_file',
    hls: null,
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

  describe('HLS sources', () => {
    const hlsMaster = (overrides: Partial<RemoteImports.ProbeHlsSummary> = {}): RemoteImports.ProbeHlsSummary => ({
      sourceType: 'hls_master',
      playlistType: 'vod',
      isFinite: true,
      variants: [
        { id: 'v-low', label: '360p · 0.8 Mbps', bandwidth: 800000, averageBandwidth: 700000, width: 640, height: 360, frameRate: null, codecs: ['avc1.4d001e'], audioGroup: null },
        { id: 'v-high', label: '1080p · 5.8 Mbps', bandwidth: 6000000, averageBandwidth: 5200000, width: 1920, height: 1080, frameRate: 25, codecs: ['avc1.640028'], audioGroup: null },
      ],
      audioTracks: [
        { id: 'a-en', language: 'en', name: 'English', isDefault: true, isAutoSelect: true, groupId: 'audio' },
        { id: 'a-id', language: 'id', name: 'Indonesian', isDefault: false, isAutoSelect: true, groupId: 'audio' },
      ],
      durationSeconds: 5423.5,
      detectedInBody: false,
      ...overrides,
    })

    it('renders the HLS section with Quality, Audio, and Output Format when the probe says HLS', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      probe.mockResolvedValueOnce({
        data: makeProbeResult({
          fileName: 'movie.mkv',
          fileNameSource: 'final-url-path',
          sourceType: 'hls_master',
          mimeType: 'application/vnd.apple.mpegurl',
          hls: hlsMaster(),
        }),
      })
      renderModal()
      await typeUrl('https://example.com/master.m3u8')
      await waitFor(() => expect(screen.getByText(/hls video/i)).toBeInTheDocument())
      // Quality + Audio selectors are present (multiple variants/tracks).
      expect(screen.getByLabelText(/quality/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/audio track/i)).toBeInTheDocument()
      // Output Format is always shown for HLS.
      expect(screen.getByLabelText(/output format/i)).toBeInTheDocument()
      // No recording input for a finite source.
      expect(screen.queryByLabelText(/recording duration/i)).not.toBeInTheDocument()
    })

    it('submits the selected HLS options with the create request', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      probe.mockResolvedValueOnce({
        data: makeProbeResult({
          fileName: 'movie.mkv',
          sourceType: 'hls_master',
          hls: hlsMaster(),
        }),
      })
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal()
      await typeUrl('https://example.com/master.m3u8')
      await waitFor(() => expect(screen.getByText(/hls video/i)).toBeInTheDocument())
      const quality = screen.getByLabelText(/quality/i)
      const user = userEvent.setup()
      await user.selectOptions(quality, 'v-high')
      const format = screen.getByLabelText(/output format/i)
      await user.selectOptions(format, 'mkv')
      await user.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0].hls).toMatchObject({
        sourceType: 'hls_master',
        variantId: 'v-high',
        outputContainer: 'mkv',
        audioTrackId: undefined,
        recordingDurationSeconds: undefined,
      })
    })

    it('blocks submission when the typed extension contradicts the selected output container', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      probe.mockResolvedValueOnce({
        data: makeProbeResult({
          fileName: 'movie.mkv',
          sourceType: 'hls_master',
          hls: hlsMaster(),
        }),
      })
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal()
      await typeUrl('https://example.com/master.m3u8')
      await waitFor(() => expect(screen.getByText(/hls video/i)).toBeInTheDocument())
      // Select MP4 output, then type an explicit .mkv name (contradiction).
      const user = userEvent.setup()
      await user.selectOptions(screen.getByLabelText(/output format/i), 'mp4')
      const field = screen.getByLabelText(/file name/i)
      await user.clear(field)
      await user.type(field, 'Movie.mkv')
      await user.click(screen.getByRole('button', { name: /start import/i }))
      // The mismatch error blocks the request; the typed name is not sent.
      expect(screen.getByText('The file name extension (.mkv) must match the selected output format (MP4).')).toBeInTheDocument()
      expect(create).not.toHaveBeenCalled()
      // Fixing the name to match unblocks submission.
      await user.clear(field)
      await user.type(field, 'Movie.mp4')
      await user.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0]).toMatchObject({ fileName: 'Movie.mp4' })
    })

    it('requires a recording duration for a live source and sends it', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      probe.mockResolvedValueOnce({
        data: makeProbeResult({
          fileName: 'live-recording.mkv',
          sourceType: 'hls_media',
          hls: hlsMaster({ sourceType: 'hls_media', playlistType: 'live', isFinite: false, durationSeconds: null }),
        }),
      })
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal()
      await typeUrl('https://example.com/live.m3u8')
      await waitFor(() => expect(screen.getByText(/live hls stream detected/i)).toBeInTheDocument())
      const recording = screen.getByLabelText(/recording duration/i)
      // Empty duration → submit blocked with a clear error.
      await userEvent.click(screen.getByRole('button', { name: /start import/i }))
      expect(screen.getByText('Recording duration is required for a live HLS stream.')).toBeInTheDocument()
      expect(create).not.toHaveBeenCalled()
      // A valid duration → sent with the request.
      const user = userEvent.setup()
      await user.type(recording, '1800')
      await user.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0].hls).toMatchObject({ sourceType: 'hls_media', isLive: true, recordingDurationSeconds: 1800 })
    })
  })
})
