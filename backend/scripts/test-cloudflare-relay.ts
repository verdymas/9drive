/**
 * Cloudflare relay end-to-end integration test (NO Playwright, NO frontend).
 *
 * Provisions a REAL temporary 9Drive relay Worker through the production
 * Cloudflare driver, then exercises the REAL production stack against it:
 *
 *   CloudflareRemoteFetchTransport (serializer + HMAC)
 *     → deployed worker.mjs (parser + relay)
 *     → TEST_REMOTE_IMPORT_URL (upstream)
 *
 * and the Remote Import application path:
 *
 *   probeRemoteUrl(workerId) → createSecureFetcherForWorkerId → transport
 *
 * plus HLS master/variant/segment fetches through the SAME worker transport.
 *
 * Usage (docker backend container — creds via -e ONLY, never committed):
 *
 *   docker compose exec -T \
 *     -e TEST_CLOUDFLARE_ACCOUNT_ID="<account-id>" \
 *     -e TEST_CLOUDFLARE_API_TOKEN="<api-token>" \
 *     -e TEST_CLOUDFLARE_WORKER_NAME="9drive-relay-test-<suffix>" \
 *     -e TEST_REMOTE_IMPORT_URL="http://content.jwplatform.com/manifests/vM7nH0Kl.m3u8" \
 *     backend npm run test:cloudflare-relay
 *
 * Env:
 *   TEST_CLOUDFLARE_ACCOUNT_ID  (required)
 *   TEST_CLOUDFLARE_API_TOKEN   (required; never printed)
 *   TEST_CLOUDFLARE_WORKER_NAME (optional; a unique name is generated)
 *   TEST_REMOTE_IMPORT_URL      (optional; default jwplatform HLS sample)
 *
 * The temporary Worker is ALWAYS removed in `finally` (deprovision + DB row).
 */
import crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { cloudflareWorkerDriver } from '../src/modules/remote-fetch-workers/drivers/cloudflare.js'
import { registerDriver } from '../src/modules/remote-fetch-workers/driver-registry.js'
import { CloudflareRemoteFetchTransport } from '../src/modules/remote-fetch-workers/transports/cloudflare-transport.js'
import {
  RELAY_PROTOCOL_VERSION,
  serializeRelayRequest,
} from '../src/modules/remote-fetch-workers/relay-protocol.js'
import { createSecureFetcherForWorkerId, type SecureRemoteFetcher } from '../src/modules/remote-imports/secure-fetcher.js'
import { probeRemoteUrl } from '../src/modules/remote-imports/probe.js'
import { fetchManifest, parseManifest } from '../src/modules/remote-imports/hls/manifest.js'
import { fetchMediaPlaylistSegments } from '../src/modules/remote-imports/hls/materialize.js'
import { downloadByteRange, downloadResource } from '../src/modules/remote-imports/hls/materializer.js'
import { prisma } from '../src/config/prisma.js'
import { encryptText, randomToken } from '../src/utils/crypto.js'
import type { RemoteFetchTransport } from '../src/modules/remote-fetch-workers/types.js'

// ────────────────────────────────────────────────────────────────────────────
// Safe env config (values are never printed)
// ────────────────────────────────────────────────────────────────────────────

const TEST_ACCOUNT_ID = process.env.TEST_CLOUDFLARE_ACCOUNT_ID
const TEST_API_TOKEN = process.env.TEST_CLOUDFLARE_API_TOKEN
const TEST_WORKER_NAME = process.env.TEST_CLOUDFLARE_WORKER_NAME
const TEST_REMOTE_IMPORT_URL =
  process.env.TEST_REMOTE_IMPORT_URL ?? 'http://content.jwplatform.com/manifests/vM7nH0Kl.m3u8'

// Register the driver so the production resolver
// (createSecureFetcherForWorkerId → driver-registry) can find it in this
// process — same registration the app does via remote-fetch-workers/index.ts.
registerDriver(cloudflareWorkerDriver)

// ────────────────────────────────────────────────────────────────────────────
// Console capture — the direct-route leak detector (safe: URL host only)
// ────────────────────────────────────────────────────────────────────────────

const capturedLines: string[] = []
const origLog = console.log
const origError = console.error
function capture() {
  console.log = (...args: unknown[]) => {
    capturedLines.push(args.map(String).join(' '))
    origLog(...args)
  }
  console.error = (...args: unknown[]) => {
    capturedLines.push(args.map(String).join(' '))
    origError(...args)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Compact PASS/FAIL reporter (§23)
// ────────────────────────────────────────────────────────────────────────────

const results: Array<{ name: string; pass: boolean; detail?: string }> = []
function report(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail })
}
function printResults() {
  origLog('\nCloudflare Relay Integration Test\n--------------------------------')
  for (const r of results) {
    const pad = r.name.length < 28 ? '.'.repeat(28 - r.name.length) : ' '
    origLog(`${r.name}${pad} ${r.pass ? 'PASS' : 'FAIL'}`)
    if (!r.pass && r.detail) origLog(`  reason: ${r.detail}`)
  }
  const failed = results.filter((r) => !r.pass)
  origLog('--------------------------------')
  origLog(failed.length === 0 ? 'ALL TESTS PASSED' : `${failed.length} TEST(S) FAILED`)
  return failed.length === 0 ? 0 : 1
}

// ────────────────────────────────────────────────────────────────────────────
// Phases
// ────────────────────────────────────────────────────────────────────────────

async function phaseCredentials(workerName: string): Promise<void> {
  if (!TEST_ACCOUNT_ID || !TEST_API_TOKEN) {
    report('validate credentials', false, 'Cloudflare test credentials not configured (TEST_CLOUDFLARE_ACCOUNT_ID / TEST_CLOUDFLARE_API_TOKEN)')
    throw new Error('credentials not configured')
  }
  await cloudflareWorkerDriver.validateConfig({
    endpointUrl: null,
    config: { accountId: TEST_ACCOUNT_ID, apiToken: TEST_API_TOKEN, workerName },
    correlationId: 'relay-test',
  })
  report('validate credentials', true)
}

async function phaseProvision(workerName: string, secret: string): Promise<string> {
  const correlationId = 'relay-test-provision'
  const result = await cloudflareWorkerDriver.provision({
    config: { accountId: TEST_ACCOUNT_ID!, apiToken: TEST_API_TOKEN!, workerName },
    secret,
    correlationId,
  })
  // Safe: protocol version only — never the endpoint query, never the secret.
  origLog(`[relay-test] provision PASS protocol=${result.protocolVersion ?? 'unknown'} worker=${workerName}`)
  report('provision worker', true)
  return result.endpointUrl
}

async function phaseHealth(endpointUrl: string, secret: string): Promise<void> {
  // A freshly-enabled workers.dev route can take a while to converge after
  // provision (observed: GET /health → CF 404/1042 for a cold route). Retry
  // with backoff over ~90s — the real deployment converges; a persistent
  // failure is reported as FAIL.
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const probe = await cloudflareWorkerDriver.testConnection({
        endpointUrl,
        authType: 'hmac',
        secret,
        correlationId: 'relay-test-health',
      })
      const caps = probe.capabilities ?? {}
      origLog(
        `[relay-test] health PASS protocol=${probe.protocolVersion ?? 'unknown'} status=${probe.status} streaming=${Boolean(caps.streaming)} rangeRequests=${Boolean(caps.rangeRequests)} hls=${Boolean(caps.hls)}`,
      )
      report('health check', true)
      return
    } catch (error) {
      lastError = error
      const code = error instanceof Error ? (error as Error & { code?: string }).code : 'network'
      if (attempt < 10) {
        origLog(`[relay-test] health retry attempt=${attempt} code=${code} waiting ${attempt * 2}s`)
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
      }
    }
  }
  const safe = lastError instanceof Error ? (lastError as Error & { code?: string }).code ?? lastError.message : String(lastError)
  report('health check', false, safe.slice(0, 200))
  throw lastError
}

async function phaseDbRow(workerName: string, endpointUrl: string, secret: string): Promise<string> {
  const row = await prisma.remoteFetchWorker.create({
    data: {
      name: `relay-test ${workerName}`,
      driver: 'cloudflare',
      endpointUrl,
      authType: 'hmac',
      secretEncrypted: encryptText(secret),
      status: 'healthy',
      isEnabled: true,
    },
  })
  origLog(`[relay-test] db row workerId=${row.id}`)
  return row.id
}

/** Safe payload-shape snapshot of the PRODUCTION serializer output (§7). */
function phaseContractSnapshot(): void {
  for (const [method, headers] of [
    ['HEAD', {} as Record<string, string>],
    ['GET', {} as Record<string, string>],
    ['GET', { Range: 'bytes=0-1023' } as Record<string, string>],
  ] as const) {
    const raw = serializeRelayRequest({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      url: TEST_REMOTE_IMPORT_URL,
      method,
      headers,
    })
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = Object.keys(parsed).sort()
    const bodyPresent = 'body' in parsed
    const hdrs = (parsed.headers ?? {}) as Record<string, unknown>
    origLog(
      `[relay-test] protocol=${RELAY_PROTOCOL_VERSION} relayMethod=POST upstreamMethod=${method} ` +
        `payloadKeys=${keys.join(',')} protocolVersionType=${typeof parsed.protocolVersion} urlType=${typeof parsed.url} ` +
        `methodType=${typeof parsed.method} headersType=${typeof parsed.headers} headersCount=${Object.keys(hdrs).length} ` +
        `bodyPresent=${bodyPresent} bodyType=${typeof parsed.body} targetHost=${new URL(TEST_REMOTE_IMPORT_URL).hostname}`,
    )
  }
}

async function phaseTransport(endpointUrl: string, secret: string, workerId: string): Promise<void> {
  const transport: RemoteFetchTransport = new CloudflareRemoteFetchTransport({
    endpointUrl,
    secret,
    workerId,
    driver: 'cloudflare',
  })
  const relayHost = (() => {
    try {
      return new URL(endpointUrl).hostname
    } catch {
      return endpointUrl
    }
  })()

  // HEAD ─────────────────────────────────────────────────────────────────────
  try {
    const head = await transport.request({ method: 'HEAD', url: TEST_REMOTE_IMPORT_URL, headers: {} })
    const ok = head.status < 400
    origLog(`[relay-test] relay HEAD status=${head.status} relayHost=${relayHost} targetHost=${new URL(TEST_REMOTE_IMPORT_URL).hostname}`)
    report('relay HEAD', ok, ok ? undefined : `status=${head.status}`)
    if (!ok) return
  } catch (error) {
    const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : 'unknown'
    report('relay HEAD', false, safe.slice(0, 200))
    return
  }

  // GET (bounded — never buffer a full media response) ─────────────────────
  try {
    const get = await transport.request({ method: 'GET', url: TEST_REMOTE_IMPORT_URL, headers: {}, maxBytes: 1024 * 1024 })
    let bytes = 0
    const iterable = typeof get.body === 'string' ? (async function* () { yield Buffer.from(get.body as string) })() : (get.body as AsyncIterable<Uint8Array>)
    for await (const chunk of iterable) {
      bytes += (chunk as Uint8Array).byteLength
      if (bytes > 1024 * 1024) break
    }
    const ok = get.status < 400 && bytes >= 0
    origLog(`[relay-test] relay GET status=${get.status} bodyBytes=${bytes} contentType=${(get.headers['content-type'] ?? '').slice(0, 60)}`)
    report('relay GET', ok, ok ? undefined : `status=${get.status}`)
    if (!ok) return
  } catch (error) {
    const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : 'unknown'
    report('relay GET', false, safe.slice(0, 200))
    return
  }

  // Range GET bytes=0-1023 ───────────────────────────────────────────────────
  try {
    const range = await transport.request({ method: 'GET', url: TEST_REMOTE_IMPORT_URL, headers: { Range: 'bytes=0-1023' }, range: 'bytes=0-1023' })
    let bytes = 0
    const iterable = typeof range.body === 'string' ? (async function* () { yield Buffer.from(range.body as string) })() : (range.body as AsyncIterable<Uint8Array>)
    for await (const chunk of iterable) {
      bytes += (chunk as Uint8Array).byteLength
      if (bytes > 1024 * 1024) break
    }
    const ok = range.status === 206 || range.status === 200
    origLog(
      `[relay-test] relay Range GET status=${range.status} bodyBytes=${bytes} ` +
        `contentRange=${range.headers['content-range'] ?? 'none'} contentType=${(range.headers['content-type'] ?? '').slice(0, 60)}`,
    )
    report('relay Range GET', ok, ok ? undefined : `status=${range.status}`)
  } catch (error) {
    const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : 'unknown'
    report('relay Range GET', false, safe.slice(0, 200))
  }
}

async function phaseProbe(workerId: string): Promise<{ finalUrl: string; sourceType: string } | null> {
  try {
    const result = await probeRemoteUrl(TEST_REMOTE_IMPORT_URL, 'relay-test-probe', undefined, { workerId })
    // Safe: never the signed query — host + classification only.
    origLog(`[relay-test] probe PASS sourceType=${result.sourceType} fileName=${result.fileName} host=${new URL(result.finalUrl).hostname}`)
    report('Remote Import probe', true)
    return { finalUrl: result.sourceUrlForFetch, sourceType: result.sourceType }
  } catch (error) {
    const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : 'unknown'
    report('Remote Import probe', false, safe.slice(0, 300))
    return null
  }
}

async function phaseHls(fetcher: SecureRemoteFetcher, probe: { finalUrl: string; sourceType: string }): Promise<void> {
  if (probe.sourceType === 'direct_file') {
    origLog('[relay-test] HLS master ............ N/A (source is a direct file)')
    origLog('[relay-test] HLS variant ........... N/A (source is a direct file)')
    report('HLS master', true, 'N/A (direct file source)')
    report('HLS variant', true, 'N/A (direct file source)')
    return
  }

  const tmpDir = await mkdtemp(join(tmpdir(), '9drive-relay-test-'))
  try {
    // Master manifest through the worker transport.
    const masterUrl = probe.finalUrl
    const master = await fetchManifest(masterUrl, 1024 * 1024, undefined, fetcher)
    const info = parseManifest(master.body, master.finalUrl)
    if (info.sourceType !== 'master') {
      // Media playlist directly — still a valid HLS source.
      origLog(`[relay-test] HLS master PASS playlistType=${info.sourceType} (media playlist — no variant step)`)
      report('HLS master', true)
      report('HLS variant', true, 'N/A (media playlist source)')
      return
    }
    origLog(`[relay-test] HLS master PASS type=${info.sourceType} playlistType=${info.playlistType} variants=${info.variants.length}`)
    report('HLS master', true)

    // Variant playlist through the same worker transport.
    if (info.variants.length === 0) {
      report('HLS variant', false, 'master playlist has no variants')
      return
    }
    const childPlaylistUrl = info.variants[0].childPlaylistUrl
    const variant = await fetchMediaPlaylistSegments(childPlaylistUrl, undefined, fetcher)
    origLog(`[relay-test] HLS variant PASS segments=${variant.segments.length} host=${new URL(childPlaylistUrl).hostname} playlistType=${variant.segments.length > 0 ? 'media' : 'unknown'}`)
    report('HLS variant', true)

    // First media segment (bounded Range through the worker transport).
    const first = variant.segments[0]
    if (!first) {
      report('HLS segment', true, 'N/A (no segments)')
      return
    }
    const segPath = join(tmpDir, 'first-segment.ts')
    try {
      await downloadByteRange(first.uri, 0, 1023, segPath, { fetcher, requestContext: undefined })
      origLog(`[relay-test] HLS segment PASS range=bytes=0-1023 uriHost=${new URL(first.uri).hostname}`)
    } catch (rangeError) {
      // Upstream may ignore Range (200). Fall back to a bounded full fetch.
      const code = (rangeError as Error & { code?: string }).code
      if (code === 'HLS_SEGMENT_RANGE_INVALID') {
        await downloadResource(first.uri, segPath, { maxBytes: 1024n * 1024n, kind: 'segment', fetcher })
        origLog(`[relay-test] HLS segment PASS boundedGet (upstream ignores Range) uriHost=${new URL(first.uri).hostname}`)
      } else {
        report('HLS segment', false, code ?? String(rangeError).slice(0, 200))
        return
      }
    }
    report('HLS segment', true)
  } catch (error) {
    const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : 'unknown'
    report('HLS master', false, safe.slice(0, 300))
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function phaseDirectRouteLeak(): void {
  const leaked = capturedLines.filter((line) => /route=direct/.test(line))
  if (leaked.length > 0) {
    report('direct-route leak', false, `${leaked.length} direct-route request(s) detected while a worker was selected`)
    return
  }
  const workerLines = capturedLines.filter((line) => /route=worker/.test(line))
  origLog(`[relay-test] direct-route leak PASS (0 direct requests; ${workerLines.length} worker-route requests)`)
  report('direct-route leak', true)
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  capture()
  const workerName = TEST_WORKER_NAME ?? `9drive-relay-test-${crypto.randomBytes(4).toString('hex')}`
  const relaySecret = randomToken(32) // never printed

  /** Run one phase; a thrown error becomes a FAIL row for that phase. */
  async function runPhase(name: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (error) {
      const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : String(error)
      // The phase's own report may have already recorded PASS/FAIL; only add a
      // row when it hasn't (e.g. a fatal outside a self-reporting phase).
      if (!results.some((r) => r.name === name)) report(name, false, safe.slice(0, 200))
      return false
    }
  }

  let endpointUrl = ''
  let workerRowId = ''
  let cleanupOk = true
  let cleanupDetail = ''

  try {
    await runPhase('validate credentials', async () => {
      await phaseCredentials(workerName)
    })
    await runPhase('provision worker', async () => {
      endpointUrl = await phaseProvision(workerName, relaySecret)
    })
    await runPhase('health check', async () => {
      if (!endpointUrl) throw new Error('no endpoint to health-check')
      await phaseHealth(endpointUrl, relaySecret)
    })
    await runPhase('db row', async () => {
      if (!endpointUrl) throw new Error('no endpoint for db row')
      workerRowId = await phaseDbRow(workerName, endpointUrl, relaySecret)
    })
    phaseContractSnapshot()
    await runPhase('Remote Import probe', async () => {
      if (!workerRowId) throw new Error('no worker row for probe')
      // The production fetcher (resolver → driver → transport) for probe + HLS.
      const fetcher = await createSecureFetcherForWorkerId(workerRowId, { sourceUrl: TEST_REMOTE_IMPORT_URL })
      await phaseTransport(endpointUrl, relaySecret, workerRowId)
      const probe = await phaseProbe(workerRowId)
      if (probe) {
        await phaseHls(fetcher, probe)
      }
    })
  } catch (error) {
    const safe = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : String(error)
    origLog(`[relay-test] fatal: ${safe.slice(0, 300)}`)
  } finally {
    try {
      if (endpointUrl) {
        await cloudflareWorkerDriver.deprovision({
          config: { accountId: TEST_ACCOUNT_ID!, apiToken: TEST_API_TOKEN!, workerName },
          correlationId: 'relay-test-cleanup',
        })
        origLog(`[relay-test] cleanup PASS worker=${workerName} removed from Cloudflare`)
      }
      if (workerRowId) {
        await prisma.remoteFetchWorker.deleteMany({ where: { id: workerRowId } })
        origLog(`[relay-test] cleanup PASS db row removed`)
      }
    } catch (cleanupError) {
      cleanupOk = false
      cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      origError(`[relay-test] cleanup FAILED: ${cleanupDetail}`)
    }
  }

  // Direct-route leak check runs on the FULL captured window: with a worker
  // selected, any `route=direct` request is a leak (probe must start at worker).
  phaseDirectRouteLeak()

  report('cleanup', cleanupOk, cleanupOk ? undefined : cleanupDetail.slice(0, 300))

  return printResults()
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    origError('[relay-test] harness crashed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })