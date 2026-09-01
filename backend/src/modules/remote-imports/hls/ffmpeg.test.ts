/**
 * Tests for the HLS remux stream selection (§Phase 2–6 of the remux fix).
 *
 * Two layers:
 *  - Unit: `selectRemuxStreams` / `summarizeStreamSelection` /
 *    `SUPPORTED_STREAM_MAP_ARGS` — pure, no binaries, always run.
 *  - Integration (real FFmpeg): `runFfmpegConcatTsCopy` on generated MPEG-TS
 *    fixtures — normal (video+audio), data-stream regression (video+audio+data),
 *    and audio-only. Guarded by `describe.runIf(hasFfmpeg)`; skips cleanly when
 *    the env-configured ffmpeg/ffprobe binaries are absent.
 *
 * Subtitle preservation (Test 4 of the spec) is asserted at the unit level
 * (`subtitle → selected` + the `0:s?` map arg). A real TS subtitle fixture
 * (DVB/teletext) is not reliably generatable across FFmpeg builds, so there is
 * deliberately no flaky integration fixture for it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { env } from '../../../config/env.js'
import { runFfmpegConcatTsCopy, runFfprobe, selectRemuxStreams, summarizeStreamSelection, SUPPORTED_STREAM_MAP_ARGS } from './ffmpeg.js'

const hasFfmpeg = () =>
  new Promise<boolean>((resolve) => {
    const child = spawn(env.REMOTE_IMPORT_FFMPEG_PATH, ['-version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })

/** Run the env-configured ffmpeg; rejects with the stderr tail on failure. */
function runFfmpegCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.REMOTE_IMPORT_FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`))))
  })
}

/** ffprobe JSON of a file (autodetects container — TS fixtures and MKV output). */
async function probeStreams(filePath: string): Promise<Array<{ codec_type?: string; codec_name?: string; index?: number }>> {
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(env.REMOTE_IMPORT_FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`ffprobe failed (${code}): ${stderr.slice(-500)}`))))
  })
  return (JSON.parse(stdout).streams ?? []) as Array<{ codec_type?: string; codec_name?: string; index?: number }>
}

// ── Unit: stream selection (no binaries). ────────────────────────────────────
describe('selectRemuxStreams', () => {
  it('selects video, audio and subtitle streams', () => {
    const result = selectRemuxStreams([
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'dvb_teletext' },
    ])
    expect(result.map((s) => s.selected)).toEqual([true, true, true])
    expect(result.every((s) => s.reason === undefined)).toBe(true)
  })

  it('skips data streams as unsupported for Matroska', () => {
    const result = selectRemuxStreams([
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'data', codec_name: 'unknown' },
    ])
    expect(result[2]).toMatchObject({ index: 2, codecType: 'data', codecName: 'unknown', selected: false, reason: 'unsupported_for_matroska' })
    expect(result.filter((s) => s.selected).length).toBe(2)
  })

  it('skips attachment, unknown and missing codec types', () => {
    const result = selectRemuxStreams([
      { index: 0, codec_type: 'attachment', codec_name: 'ttf' },
      { index: 1, codec_type: undefined, codec_name: undefined },
      { index: 2 },
    ])
    expect(result.every((s) => s.selected === false)).toBe(true)
    expect(result.every((s) => s.reason === 'unsupported_for_matroska')).toBe(true)
  })

  it('preserves ffprobe stream indexes and falls back to position', () => {
    const result = selectRemuxStreams([{ codec_type: 'video' }, { index: 7, codec_type: 'audio' }])
    expect(result[0].index).toBe(0)
    expect(result[1].index).toBe(7)
  })

  it('returns [] for no streams', () => {
    expect(selectRemuxStreams([])).toEqual([])
  })
})

describe('SUPPORTED_STREAM_MAP_ARGS', () => {
  it('maps exactly video, audio and subtitles — no blanket -map 0', () => {
    expect(SUPPORTED_STREAM_MAP_ARGS).toEqual(['-map', '0:v?', '-map', '0:a?', '-map', '0:s?'])
  })
})

describe('summarizeStreamSelection', () => {
  it('renders selected/skipped counts', () => {
    const probe = {
      inputBasename: 'concat-payload.ts',
      mode: 'rawts' as const,
      format: 'mpegts',
      durationSeconds: 10,
      videoCodec: 'h264',
      audioCodec: 'aac',
      ok: true,
      streams: selectRemuxStreams([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'data', codec_name: 'unknown' },
      ]),
    }
    expect(summarizeStreamSelection(probe)).toBe('[streams] selected=2/3 skipped=1')
  })

  it('returns "" for null, failed or empty probes', () => {
    expect(summarizeStreamSelection(null)).toBe('')
    expect(summarizeStreamSelection({ inputBasename: 'x', mode: 'rawts', format: null, durationSeconds: null, videoCodec: null, audioCodec: null, streams: [], ok: false, reason: 'probe-failed' })).toBe('')
    expect(summarizeStreamSelection({ inputBasename: 'x', mode: 'rawts', format: 'mpegts', durationSeconds: null, videoCodec: null, audioCodec: null, streams: [], ok: true })).toBe('')
  })
})

// ── Integration: real FFmpeg concat-copy remux. ──────────────────────────────
describe.runIf(hasFfmpeg)('runFfmpegConcatTsCopy (real ffmpeg)', () => {
  let fixtureDir: string
  let jobDir: string
  let cleanups: string[] = []

  afterAll(async () => {
    await Promise.all(cleanups.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  const newJobDir = async (): Promise<string> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '9drive-remux-test-'))
    cleanups.push(dir)
    return dir
  }

  const makeTs = async (job: string, name: string, args: string[]): Promise<string> => {
    const out = path.join(job, name)
    await runFfmpegCli(args)
    return out
  }

  it('Test 1: normal HLS (video h264 + audio aac) remuxes to MKV', async () => {
    jobDir = await newJobDir()
    const tsPath = await makeTs(jobDir, 'normal.ts', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-f', 'mpegts', '-y', path.join(jobDir, 'normal.ts'),
    ])
    const result = await runFfmpegConcatTsCopy([tsPath], path.join(jobDir, 'output.mkv.part'), 'mkv', jobDir)
    const outStreams = await probeStreams(result.outputPath)
    expect(outStreams.filter((s) => s.codec_type === 'video').length).toBe(1)
    expect(outStreams.filter((s) => s.codec_type === 'audio').length).toBe(1)
  })

  it('Test 2: HLS with a data stream remuxes — the data stream is skipped', async () => {
    jobDir = await newJobDir()
    // Video + audio + a raw-data stream, muxed into one MPEG-TS.
    const tsPath = path.join(jobDir, 'withdata.ts')
    const junkPath = path.join(jobDir, 'junk.bin')
    await fsp.writeFile(junkPath, Buffer.alloc(188 * 10, 0x47))
    await runFfmpegCli([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-f', 'data', '-i', junkPath,
      '-map', '0:v', '-map', '1:a', '-map', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:d', 'copy',
      '-f', 'mpegts', '-y', tsPath,
    ])
    const inputStreams = await probeStreams(tsPath)
    const dataIn = inputStreams.filter((s) => s.codec_type === 'data')
    // The data stream must be present for this to be a real regression test; if
    // the muxer/build cannot carry bin_data, skip rather than false-fail.
    if (dataIn.length === 0) {
      console.warn('skipping: ffmpeg build did not carry the data stream into the TS fixture')
      return
    }
    const result = await runFfmpegConcatTsCopy([tsPath], path.join(jobDir, 'output.mkv.part'), 'mkv', jobDir)
    const outStreams = await probeStreams(result.outputPath)
    expect(outStreams.filter((s) => s.codec_type === 'video').length).toBe(1)
    expect(outStreams.filter((s) => s.codec_type === 'audio').length).toBe(1)
    expect(outStreams.filter((s) => s.codec_type === 'data').length).toBe(0)
  })

  it('Test 3: audio-only HLS remuxes to an audio MKV', async () => {
    jobDir = await newJobDir()
    const tsPath = await makeTs(jobDir, 'audioonly.ts', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'aac',
      '-f', 'mpegts', '-y', path.join(jobDir, 'audioonly.ts'),
    ])
    const result = await runFfmpegConcatTsCopy([tsPath], path.join(jobDir, 'output.mkv.part'), 'mkv', jobDir)
    const outStreams = await probeStreams(result.outputPath)
    expect(outStreams.filter((s) => s.codec_type === 'audio').length).toBe(1)
    expect(outStreams.filter((s) => s.codec_type === 'video').length).toBe(0)
  })
})
