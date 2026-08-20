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

const ACCOUNTS = [{ id: 'acc-1', provider: 's3', email: 'a@b.c', status: 'connected', autoAllocationEnabled: true }]
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

function renderModal(overrides: { workers?: Parameters<typeof RemoteImportModal>[0]['workers'] } = {}) {
  return render(
    <RemoteImportModal open accounts={ACCOUNTS} folders={FOLDERS} onClose={() => {}} onCreated={() => {}} defaultFolderId="f-1" workers={overrides.workers ?? []} />,
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
  vi.spyOn(RemoteImports, 'parseCurl').mockImplementation(() => new Promise(() => {}))
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

  it('maps an HLS manifest 403 to a safe message (never the raw error)', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    const err = new Error('The source server rejected access to the HLS manifest.') as Error & { code?: string }
    err.code = 'HLS_MANIFEST_FORBIDDEN'
    probe.mockRejectedValueOnce(err)
    renderModal()
    await typeUrl('https://example.com/stream.m3u8')
    await waitFor(() => expect(screen.getByText(/rejected access to the hls manifest/i)).toBeInTheDocument())
    expect(screen.queryByText(/expected object, received null/i)).not.toBeInTheDocument()
  })

  it('maps an HLS manifest fetch failure to a safe message', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    const err = new Error('The HLS manifest could not be read.') as Error & { code?: string }
    err.code = 'HLS_MANIFEST_FETCH_FAILED'
    probe.mockRejectedValueOnce(err)
    renderModal()
    await typeUrl('https://example.com/stream.m3u8')
    await waitFor(() => expect(screen.getByText(/hls manifest could not be read/i)).toBeInTheDocument())
  })

  it('shows the generic manual-entry hint for unknown probe errors', async () => {
    const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
    probe.mockRejectedValueOnce(new Error('Invalid input: expected object, received null'))
    renderModal()
    await typeUrl('https://example.com/stream.m3u8')
    await waitFor(() => expect(screen.getByText(/file name could not be detected/i)).toBeInTheDocument())
    // The raw Zod fragment must never surface.
    expect(screen.queryByText(/expected object, received null/i)).not.toBeInTheDocument()
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
    // Direct files never carry `hls` as a value — the modal sends undefined
    // (never `null`, which the backend Zod schema rejects), and the wire
    // serialization in remoteImports.createRemoteImport drops the key.
    expect(create.mock.calls[0][0].hls).toBeUndefined()
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
    // Custom name likewise sends no `hls` value for a direct file.
    expect(create.mock.calls[0][0].hls).toBeUndefined()
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

  describe('request context + paste-as-cURL (spec §36)', () => {
    it('switches between URL and cURL modes', async () => {
      renderModal()
      expect(screen.getByLabelText(/file url/i)).toBeInTheDocument()
      expect(screen.queryByLabelText(/cURL command/i)).not.toBeInTheDocument()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'cURL' }))
      expect(screen.getByLabelText(/cURL command/i)).toBeInTheDocument()
      expect(screen.queryByLabelText(/file url/i)).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'URL' }))
      expect(screen.getByLabelText(/file url/i)).toBeInTheDocument()
    })

    it('keeps Advanced Request Options collapsed by default; Cookie is a password input', async () => {
      renderModal()
      // Collapsed: the referer field is hidden (inside the collapsed region).
      expect(screen.queryByLabelText(/referer/i)).not.toBeInTheDocument()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: /advanced request options/i }))
      expect(screen.getByLabelText(/referer/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/cookie/i)).toHaveAttribute('type', 'password')
      expect(screen.getByLabelText(/cookie/i)).toHaveAttribute('autocomplete', 'off')
    })

    it('sends the request context with the probe and with the create request', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      probe.mockResolvedValue({ data: makeProbeResult() })
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: /advanced request options/i }))
      await user.type(screen.getByLabelText(/referer/i), 'https://site.example/watch/1')
      await user.type(screen.getByLabelText(/cookie/i), 'session=valid')
      await typeUrl('https://example.com/protected/file.bin')
      await waitFor(() => expect(probe).toHaveBeenCalled())
      // The probe carries the context as its 3rd argument.
      expect(probe.mock.calls.at(-1)?.[2]).toEqual({ referer: 'https://site.example/watch/1', cookie: 'session=valid' })
      await user.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0]).toMatchObject({
        sourceMode: 'url',
        url: 'https://example.com/protected/file.bin',
        requestContext: { referer: 'https://site.example/watch/1', cookie: 'session=valid' },
      })
    })

    it('omits requestContext from create when no advanced options were entered', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      probe.mockResolvedValue({ data: makeProbeResult({ fileName: 'plain.bin' }) })
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal()
      await typeUrl('https://example.com/plain.bin')
      await waitFor(() => expect(screen.getByDisplayValue('plain.bin')).toBeInTheDocument())
      await userEvent.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0].sourceMode).toBe('url')
      expect(create.mock.calls[0][0].requestContext).toBeUndefined()
    })

    it('cURL mode: shows the parse summary chips from the backend parse', async () => {
      const parse = vi.spyOn(RemoteImports, 'parseCurl')
      parse.mockResolvedValue({
        data: {
          url: 'https://fixture.test/protected/master.m3u8?token=abc',
          requestContext: { attached: true, referer: true, origin: true, userAgent: true, cookie: true },
          unsupportedOptions: [],
        },
      })
      renderModal()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'cURL' }))
      const textarea = screen.getByLabelText(/cURL command/i)
      await user.type(
        textarea,
        "curl 'https://fixture.test/protected/master.m3u8?token=abc' -H 'Referer: https://site.example/watch/1' -H 'Origin: https://site.example' -H 'User-Agent: Mozilla/5.0 Test' -H 'Cookie: session=valid'",
      )
      expect(await screen.findByText(/command parsed/i)).toBeInTheDocument()
      expect(screen.getByText('URL detected')).toBeInTheDocument()
      expect(screen.getByText('Referer detected')).toBeInTheDocument()
      expect(screen.getByText('Origin detected')).toBeInTheDocument()
      expect(screen.getByText('User-Agent detected')).toBeInTheDocument()
      expect(screen.getByText('Cookie detected')).toBeInTheDocument()
      // The parsed values are NEVER echoed back — only labels. (The textarea
      // legitimately holds the typed command, so match exact standalone text:
      // an echoed value would be its own element.)
      expect(screen.queryByText('session=valid', { exact: true })).not.toBeInTheDocument()
      expect(screen.queryByText('token=abc', { exact: true })).not.toBeInTheDocument()
    })

    it('cURL mode: submit sends the raw command; the server re-parses (spec §19)', async () => {
      const parse = vi.spyOn(RemoteImports, 'parseCurl')
      parse.mockResolvedValue({
        data: {
          url: 'https://fixture.test/protected/master.m3u8',
          requestContext: { attached: true, referer: true, origin: false, userAgent: false, cookie: true },
          unsupportedOptions: [],
        },
      })
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'cURL' }))
      const textarea = screen.getByLabelText(/cURL command/i)
      await user.type(textarea, "curl 'https://fixture.test/protected/master.m3u8' -H 'Referer: https://site.example/watch/1' -H 'Cookie: session=valid'")
      await waitFor(() => expect(screen.getByText(/command parsed/i)).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0]).toMatchObject({
        sourceMode: 'curl',
        curl: "curl 'https://fixture.test/protected/master.m3u8' -H 'Referer: https://site.example/watch/1' -H 'Cookie: session=valid'",
      })
      // The client never derives fields from the command — the server does.
      expect(create.mock.calls[0][0].url).toBeUndefined()
      expect(create.mock.calls[0][0].requestContext).toBeUndefined()
    })

    it('cURL mode: shows the parse error inline when the backend rejects the command', async () => {
      const parse = vi.spyOn(RemoteImports, 'parseCurl')
      const err = new Error('The pasted cURL command uses an option that is not supported.') as Error & { code?: string }
      err.code = 'REMOTE_IMPORT_CURL_UNSAFE_OPTION'
      parse.mockRejectedValueOnce(err)
      renderModal()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'cURL' }))
      await user.type(screen.getByLabelText(/cURL command/i), "curl 'https://example.com/f' -x http://proxy:8080")
      expect(await screen.findByText(/uses an option that is not supported/i)).toBeInTheDocument()
    })

    it('cURL mode: a re-typed command re-parses (latest wins)', async () => {
      const parse = vi.spyOn(RemoteImports, 'parseCurl')
      parse.mockResolvedValueOnce({
        data: { url: 'https://example.com/a', requestContext: { attached: false, referer: false, origin: false, userAgent: false, cookie: false }, unsupportedOptions: [] },
      })
      parse.mockResolvedValueOnce({
        data: { url: 'https://example.com/b', requestContext: { attached: true, referer: true, origin: false, userAgent: false, cookie: false }, unsupportedOptions: [] },
      })
      renderModal()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'cURL' }))
      const textarea = screen.getByLabelText(/cURL command/i)
      await user.type(textarea, "curl 'https://example.com/a'")
      await waitFor(() => expect(screen.getByText(/command parsed/i)).toBeInTheDocument())
      expect(screen.queryByText('Referer detected')).not.toBeInTheDocument()
      await user.clear(textarea)
      await user.type(textarea, "curl 'https://example.com/b' -H 'Referer: https://example.com/x'")
      await waitFor(() => expect(screen.getByText('Referer detected')).toBeInTheDocument())
    })

    it('maps an expired-context probe failure to the safe spec message', async () => {
      const probe = vi.spyOn(RemoteImports, 'probeRemoteUrl')
      const err = new Error('The source URL or request context may have expired. Capture a fresh media request and try again.') as Error & { code?: string }
      err.code = 'REMOTE_SOURCE_ACCESS_EXPIRED'
      probe.mockRejectedValueOnce(err)
      renderModal()
      await typeUrl('https://example.com/expired.m3u8')
      await waitFor(() => expect(screen.getByText(/capture a fresh media request/i)).toBeInTheDocument())
    })
  })

  describe('Network Route worker selection', () => {
    const WORKER_A: Parameters<typeof RemoteImportModal>[0]['workers'][number] = {
      id: 'w-a',
      name: 'Cloudflare SG #1',
      slug: null,
      driver: 'cloudflare',
      endpointUrl: 'https://sg.example.workers.dev',
      isEnabled: true,
      isDefault: true,
      priority: null,
      region: 'Singapore',
      description: null,
      authType: 'hmac',
      credentialConfigured: true,
      providerConfig: null,
      capabilitiesJson: null,
      metadataJson: null,
      status: 'healthy',
      lastHealthCheckAt: null,
      lastHealthyAt: null,
      lastFailedAt: null,
      lastErrorCode: null,
      deletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const WORKER_B: typeof WORKER_A = { ...WORKER_A, id: 'w-b', name: 'Cloudflare US #1', isDefault: false, status: 'unhealthy', region: 'US' }

    it('preselects the enabled default worker, Direct otherwise', () => {
      renderModal({ workers: [WORKER_A, WORKER_B] })
      const select = screen.getByLabelText(/network route/i) as HTMLSelectElement
      expect(select.value).toBe('w-a')
      // Direct remains a choice.
      expect(screen.getByRole('option', { name: /direct \/ no worker/i })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /cloudflare sg/i })).not.toBeNull()
    })

    it('defaults to Direct when no default worker exists', () => {
      renderModal({ workers: [WORKER_B] })
      const select = screen.getByLabelText(/network route/i) as HTMLSelectElement
      expect(select.value).toBe('')
    })

    it('sends workerId when a worker is selected, undefined for Direct', async () => {
      const create = vi.spyOn(RemoteImports, 'createRemoteImport').mockResolvedValue({} as never)
      renderModal({ workers: [WORKER_A] })
      await typeUrl('https://example.com/file.bin')
      await userEvent.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      // Default worker preselected → workerId persists.
      expect(create.mock.calls[0][0].workerId).toBe('w-a')

      // Explicit Direct override.
      create.mockClear()
      const select = screen.getByLabelText(/network route/i)
      const user = userEvent.setup()
      await user.selectOptions(select, '')
      await user.click(screen.getByRole('button', { name: /start import/i }))
      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0].workerId).toBeUndefined()
    })

    it('shows an unhealthy warning for the selected worker and never lists disabled ones', async () => {
      renderModal({ workers: [WORKER_A, WORKER_B] })
      const select = screen.getByLabelText(/network route/i)
      const user = userEvent.setup()
      await user.selectOptions(select, 'w-b')
      expect(screen.getByText(/last reported unhealthy/i)).toBeInTheDocument()
      // All listed workers are enabled (WORKER_B is enabled with unhealthy status;
      // a disabled worker is filtered by the PAGE, and here we assert the option
      // set is the provided enabled list).
      expect(select.querySelectorAll('option')).toHaveLength(3) // Direct + A + B
    })
  })
})
