/**
 * Build-time zip of the self-hosted VPS relay.
 *
 * Packages `src/modules/remote-fetch-workers/drivers/vps-relay/` into
 * `backend/artifacts/9drive-vps-relay.zip` with the ZIP root as the Docker
 * build context (Dockerfile beside server.js). Run as part of
 * `npm run build` (or `npm run zip:vps-relay`) — always overwrites.
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver')

const scriptDir = dirname(fileURLToPath(import.meta.url))
const backendDir = join(scriptDir, '..')
const srcDir = join(backendDir, 'src', 'modules', 'remote-fetch-workers', 'drivers', 'vps-relay')
const artifactsDir = join(backendDir, 'artifacts')
const outPath = join(artifactsDir, '9drive-vps-relay.zip')

if (!existsSync(srcDir)) {
  console.error('[zip:vps-relay] source dir not found:', srcDir)
  process.exit(1)
}

for (const required of ['Dockerfile', 'server.js', 'package.json', '.env.example', 'README.md', '.dockerignore']) {
  if (!existsSync(join(srcDir, required))) {
    console.error('[zip:vps-relay] required file missing:', required)
    process.exit(1)
  }
}

mkdirSync(artifactsDir, { recursive: true })

const output = createWriteStream(outPath)
const archive = new ZipArchive({ zlib: { level: 9 } })
archive.on('warning', (err) => console.warn('[zip:vps-relay]', err.message))
archive.on('error', (err) => {
  console.error('[zip:vps-relay] failed:', err.message)
  process.exit(1)
})
archive.pipe(output)
// ZIP root = Docker build context. Exclude tests/dev files; never include
// node_modules or secrets (there are none in the source dir by construction).
archive.glob('**/*', { cwd: srcDir, dot: true, ignore: ['node_modules/**', '.env', '**/*.test.ts', '**/*.test.js'] })
await archive.finalize()
await new Promise((resolve) => output.on('close', resolve))
console.log(`[zip:vps-relay] created ${outPath} (${archive.pointer()} bytes)`)
