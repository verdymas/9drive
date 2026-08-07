import { spawn } from 'node:child_process'
// Recreate the EXACT args runFfmpegConcatTsCopy builds, with a Windows-space
// path, to reproduce "Trailing option(s)" / "At least one output file".
const jobDir = 'D:/01. Verdymas/Project/9drive/backend/scratch-dbg'
import fs from 'node:fs'
fs.mkdirSync(jobDir, { recursive: true })
// write two tiny fake TS files (not real TS — just to see arg parsing)
fs.writeFileSync(jobDir + '/video-000001.ts', Buffer.alloc(188, 0x47))
fs.writeFileSync(jobDir + '/video-000002.ts', Buffer.alloc(188, 0x47))
const payloadPath = jobDir + '/concat-payload.ts'
fs.writeFileSync(payloadPath, Buffer.concat([Buffer.alloc(188, 0x47), Buffer.alloc(188, 0x47)]))
const outputPartPath = jobDir + '/output.mkv.part'
const args = [
  '-nostdin', '-hide_banner', '-loglevel', 'warning',
  '-progress', 'pipe:1',
  '-protocol_whitelist', 'file,crypto',
  '-analyzeduration', '200M', '-probesize', '200M',
  '-f', 'mpegts',
  '-i', payloadPath,
  '-map', '0', '-c', 'copy',
  '-f', 'matroska',
  '-y',
  outputPartPath,
]
console.log('ARGS:', JSON.stringify(args, null, 1))
const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr?.on('data', (c) => { stderr += c.toString() })
child.on('close', (code) => {
  console.log('EXIT', code)
  console.log(stderr.slice(-1200))
  fs.rmSync(jobDir, { recursive: true, force: true })
})
