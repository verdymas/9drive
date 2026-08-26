import { describe, expect, it, vi, beforeEach } from 'vitest'
import { verifyOutput } from './verify.js'

// ── Mocks ────────────────────────────────────────────────────────────────────
// The verifyOutput imports `fsp` from 'node:fs/promises' via the module-level
// import at the top of verify.ts. Vitest hoists vi.mock before imports, so
// any module that imports 'node:fs/promises' during the test sees our mock.
// Note: verify.ts uses `import fsp from 'node:fs/promises'` — the mock must
// expose a `default` export.
vi.mock('node:fs/promises', () => {
  return {
    default: {
      stat: vi.fn(async () => ({ size: 100, isFile: () => true })),
    },
    stat: vi.fn(async () => ({ size: 100, isFile: () => true })),
  }
})

const h = vi.hoisted(() => {
  let streams: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> = []
  return {
    setStreams: (s: typeof streams) => { streams = s },
    ffprobeResult: () => ({
      format: { format_name: 'matroska', duration: '10.0', size: '100' },
      streams,
    }),
  }
})

vi.mock('./ffmpeg.js', () => ({
  runFfprobe: vi.fn(async () => h.ffprobeResult()),
}))

describe('verifyOutput expectAudio soft-fail', () => {
  beforeEach(() => {
    h.setStreams([])
  })

  it('accepts a video-only output when audio is expected (warns, does not fail)', async () => {
    h.setStreams([{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await verifyOutput('/tmp/video-only.mkv', { expectVideo: true, expectAudio: true })
    expect(result.hasVideo).toBe(true)
    expect(result.hasAudio).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('still rejects an output with no video stream', async () => {
    h.setStreams([{ codec_type: 'audio', codec_name: 'aac' }])
    await expect(verifyOutput('/tmp/audio-only.mkv', { expectVideo: true, expectAudio: false }))
      .rejects.toThrow('no video stream')
  })
})