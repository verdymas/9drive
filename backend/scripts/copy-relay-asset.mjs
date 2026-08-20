/**
 * Production build companion: tsc emits TS/JS only, so the relay's static
 * `worker.mjs` asset must be copied next to the compiled output. tsx (dev)
 * reads the asset from src — this only matters for `dist` runs.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcAsset = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules', 'remote-fetch-workers', 'drivers', 'cloudflare-relay', 'worker.mjs')
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'modules', 'remote-fetch-workers', 'drivers', 'cloudflare-relay')
const distAsset = join(distDir, 'worker.mjs')

if (!existsSync(srcAsset)) {
  console.error('[worker:cloudflare] build: relay asset missing:', srcAsset)
  process.exit(1)
}
mkdirSync(distDir, { recursive: true })
cpSync(srcAsset, distAsset)
console.log('[worker:cloudflare] build: relay asset copied to', distAsset)