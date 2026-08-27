/**
 * Generate extension icons from frontend/public/maskable-icon.svg.
 * Requires `sharp` (install once: `npm install --no-save sharp` at repo root).
 * Run: `node extensions/browser-capture/scripts/generate-icons.mjs`
 */
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const svg = path.join(root, 'frontend/public/maskable-icon.svg')
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icons')

for (const size of [16, 32, 48, 128]) {
  await sharp(svg).resize(size, size).png().toFile(path.join(outDir, `icon${size}.png`))
  console.log(`generated icon${size}.png`)
}
