// Phase 4 boot smoke (re-runnable): compiles are in ./backend/dist, so run
// `cd backend && npm run build` first, then `node <this file>` from the repo
// root. Verifies each process type starts and serves real HTTP, and that the
// all-in-one control plane keeps auth-before-service semantics — without
// requiring a working MySQL/Redis (it only hits routes that short-circuit
// before any dependency).
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const baseEnv = {
  ...process.env,
  DATABASE_URL: 'mysql://root@localhost:3306/9drive_smoke', // intentionally unused by these probes
  FRONTEND_URL: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'smoke-test-secret-value-1234567890ab',
  TOKEN_ENCRYPTION_KEY: 'smoke-test-encryption-key-32chars!',
  UPLOAD_TEMP_DIR: './smoke-upload-tmp',
  REDIS_URL: 'redis://127.0.0.1:6399', // intentionally unreachable; media probes never touch queues
  APP_PORT: '4102',
}

async function fetchT(url, ms = 3000) {
  try { return await fetch(url, { signal: AbortSignal.timeout(ms) }) } catch { return { status: 0 } }
}

async function waitForListener(url, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await fetchT(url, 500)).status !== 0) return
    await delay(150)
  }
  throw new Error('no response from ' + url)
}

async function smoke(label, entry, env, checks) {
  console.log('== ' + label)
  const child = spawn('node', [entry], { cwd: 'backend', env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tail = []
  child.stdout.on('data', (d) => tail.push(d.toString()))
  child.stderr.on('data', (d) => tail.push(d.toString()))
  let failed = false
  try {
    await checks(child, tail)
    console.log('   OK')
  } catch (error) {
    failed = true
    console.log('   FAIL:', error.message)
    console.log('   output:', tail.join('').slice(-1200))
    process.exitCode = 1
  } finally {
    child.kill()
    await delay(250)
    if (!child.killed) child.kill('SIGKILL')
  }
  return !failed
}

const mediaOk = await smoke('media plane (flag on): serves media routes, no control routes', 'dist/media-server.js', { MEDIA_SERVER_ENABLED: 'true', MEDIA_SERVER_PORT: '4101' }, async () => {
  const health = await waitForListener('http://127.0.0.1:4101/health', 15000)
  const body = await (await fetchT('http://127.0.0.1:4101/health')).json?.().catch?.(() => null) ?? await (await fetchT('http://127.0.0.1:4101/health')).json?.()
  void health
  if (!body || body.status !== 'ok' || body.plane !== 'media') throw new Error('bad health body: ' + JSON.stringify(body))
  if ((await fetchT('http://127.0.0.1:4101/files/f-1/download')).status !== 401) throw new Error('download without auth must 401')
  if ((await fetchT('http://127.0.0.1:4101/webdav/status')).status !== 200) throw new Error('webdav status route missing')
  if ((await fetchT('http://127.0.0.1:4101/folders')).status !== 404) throw new Error('control route leaked into media plane')
})

const offOk = await smoke('media plane (flag off): exits 0 without listening', 'dist/media-server.js', { MEDIA_SERVER_ENABLED: 'false', MEDIA_SERVER_PORT: '4103' }, async (child) => {
  const code = await new Promise((resolve) => child.on('exit', resolve))
  if (code !== 0) throw new Error('exit code ' + code)
  if ((await fetchT('http://127.0.0.1:4103/health', 500)).status !== 0) throw new Error('flag-off media plane is listening')
})

const allInOneOk = await smoke('all-in-one: control + media semantics on one port', 'dist/server.js', { APP_PORT: '4102' }, async () => {
  // /health intentionally unprobed here: it awaits BullMQ, which never
  // resolves against an unreachable Redis (pre-existing design; covered by
  // unit tests). These routes short-circuit on auth BEFORE any DB/Redis work.
  const up = await waitForListener('http://127.0.0.1:4102/files/f-1/download', 15000)
  void up
  if ((await fetchT('http://127.0.0.1:4102/files/f-1/download')).status !== 401) throw new Error('download must be 401 without auth')
  if ((await fetchT('http://127.0.0.1:4102/folders')).status !== 401) throw new Error('control route missing/unauthenticated behavior')
})

console.log(mediaOk && offOk && allInOneOk ? 'SMOKE PASSED' : 'SMOKE FAILED')
