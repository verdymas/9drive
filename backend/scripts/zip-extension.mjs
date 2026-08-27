/**
 * Build-time zip of the Browser Capture extension.
 *
 * tsc (dev via tsx, prod via build) does not emit static assets, and the
 * download route serves a pre-built file rather than zipping on every request.
 * Run as part of `npm run build` (or `npm run zip:extension`) — always
 * overwrites the existing zip with fresh content.
 */
import { createWriteStream, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver')

const scriptDir = dirname(fileURLToPath(import.meta.url))
// In Docker: scripts/ is at /app/scripts/, extensions/ is at /app/extensions/ → ../
// In dev:  scripts/ is at backend/scripts/, extensions/ is at repo-root/extensions/ → ../../
const root = existsSync(join(scriptDir, '..', 'extensions'))
  ? join(scriptDir, '..')
  : join(scriptDir, '..', '..')
const extDir = join(root, 'extensions', 'browser-capture')
const outPath = join(root, 'extensions', '9drive-browser-capture-ext.zip')

if (!existsSync(extDir)) {
  console.error('[zip:extension] source dir not found:', extDir)
  process.exit(1)
}

const output = createWriteStream(outPath)
const archive = new ZipArchive({ zlib: { level: 9 } })
archive.on('warning', (err) => console.warn('[zip:extension]', err.message))
archive.on('error', (err) => {
  console.error('[zip:extension] failed:', err.message)
  process.exit(1)
})
archive.pipe(output)
// Exclude tests/ and any stray node_modules from the packaged extension.
archive.glob('**/*', { cwd: extDir, ignore: ['tests/**', 'node_modules/**'] })
await archive.finalize()
await new Promise((resolve) => output.on('close', resolve))
console.log(`[zip:extension] created ${outPath} (${archive.pointer()} bytes)`)
