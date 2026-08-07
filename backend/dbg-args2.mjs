import { spawn } from 'node:child_process'
// Real payload: concat the real fixture segments, then run the EXACT args
const jobDir = 'D:/01. Verdymas/Project/9drive/backend/scratch-dbg2'
import fs from 'node:fs'
fs.mkdirSync(jobDir, { recursive: true })
const segDir = 'C:/Users/Lenovo/AppData/Local/Temp/9drive-realconv'
const parts = [segDir + '/seg0.ts', segDir + '/seg1.ts']
const payloadPath = jobDir + '/concat-payload.ts'
fs.writeFileSync(payloadPath, Buffer.concat(parts.map(p => fs.readFileSync(p))))
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
const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr?.on('data', (c) => { stderr += c.toString() })
child.on('close', (code) => {
  console.log('EXIT', code)
  console.log(stderr.slice(-1200))
  console.log('exists out:', fs.existsSync(outputPartPath.replace(/\.part$/, '')))
  fs.rmSync(jobDir, { recursive: true, force: true })
})
