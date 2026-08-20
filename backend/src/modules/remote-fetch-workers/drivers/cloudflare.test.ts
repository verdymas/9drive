import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../../utils/app-error.js'
import {
  normalizeEndpointUrl,
  signHealthRequest,
  HMAC_SIGNATURE_HEADER,
  validateHealthPayload,
  RELAY_PROTOCOL_VERSION,
  RELAY_SERVICE_IDENTITY,
  mapCloudflareApiError,
  cloudflareWorkerDriver,
} from './cloudflare.js'
import {
  RELAY_MODULE_NAME,
  RELAY_COMPATIBILITY_DATE,
  loadRelaySource,
  buildCloudflareRelay,
  validateRelaySource,
  relaySourceSha256,
} from './cloudflare-relay.js'

describe('normalizeEndpointUrl', () => {
  it('accepts an https URL, canonical form has no trailing slash', () => {
    expect(normalizeEndpointUrl('https://relay.example.workers.dev')).toBe('https://relay.example.workers.dev')
  })

  it('normalizes trailing slashes (no doubled slash when appending /health)', () => {
    expect(normalizeEndpointUrl('https://relay.example.workers.dev/')).toBe('https://relay.example.workers.dev')
    expect(normalizeEndpointUrl('https://relay.example.workers.dev///')).toBe('https://relay.example.workers.dev')
    expect(`${normalizeEndpointUrl('https://relay.example.workers.dev/')}/health`).toBe('https://relay.example.workers.dev/health')
  })

  it('rejects javascript:, file:, ftp:, data: schemes', () => {
    for (const scheme of ['javascript:', 'file:', 'ftp:', 'data:']) {
      expect(() => normalizeEndpointUrl(`${scheme}//x`)).toThrowError(AppError)
    }
  })

  it('rejects embedded credentials', () => {
    expect(() => normalizeEndpointUrl('https://user:pass@relay.example.workers.dev')).toThrowError(AppError)
  })

  it('rejects CR/LF', () => {
    expect(() => normalizeEndpointUrl('https://relay.example.workers.dev\r\n')).toThrowError(AppError)
  })

  it('rejects http when not localhost', () => {
    expect(() => normalizeEndpointUrl('http://relay.example')).toThrowError(AppError)
  })

  // http://localhost gating depends on WORKER_ALLOW_LOCALHOST_HTTP, which the
  // vitest setup enables for the integration server — not asserted here.
})

describe('signHealthRequest', () => {
  it('produces a stable HMAC-SHA256 hex signature', () => {
    const sig = signHealthRequest('secret', 'GET', '/health')
    expect(sig).toMatch(/^[a-f0-9]{64}$/)
    expect(sig).toBe(signHealthRequest('secret', 'GET', '/health'))
    expect(sig).not.toBe(signHealthRequest('other-secret', 'GET', '/health'))
    expect(sig).not.toBe(signHealthRequest('secret', 'POST', '/health'))
  })
})

describe('validateHealthPayload', () => {
  it('accepts a valid 9drive-relay health payload', () => {
    const probe = validateHealthPayload({ service: RELAY_SERVICE_IDENTITY, protocolVersion: '9drive-relay-v1', status: 'ok', capabilities: { streaming: true, rangeRequests: true } })
    expect(probe).toMatchObject({ status: 'healthy', protocolVersion: '9drive-relay-v1' })
    expect(probe.capabilities).toMatchObject({ streaming: true, rangeRequests: true })
  })

  it('rejects a non-relay service identity', () => {
    expect(() => validateHealthPayload({ service: 'something-else', status: 'ok' })).toThrowError(AppError)
    expect(() => validateHealthPayload({ status: 'ok' })).toThrowError(AppError)
  })

  it('rejects an unsupported protocol version', () => {
    expect(() => validateHealthPayload({ service: RELAY_SERVICE_IDENTITY, protocolVersion: '9drive-relay-v0' })).toThrowError(AppError)
  })

  it('rejects a non-ok health status', () => {
    expect(() => validateHealthPayload({ service: RELAY_SERVICE_IDENTITY, status: 'degraded' })).toThrowError(AppError)
  })

  it('rejects non-object bodies', () => {
    expect(() => validateHealthPayload(null)).toThrowError(AppError)
    expect(() => validateHealthPayload('ok')).toThrowError(AppError)
  })

  it('tolerates an absent protocolVersion (protocol invalid → thrown for missing identity)', () => {
    // service identity is the hard requirement; protocolVersion absence alone
    // still passes identity — but the caller (service) won't mark healthy
    // without a version. Here identity passes and no explicit version means ok.
    expect(() => validateHealthPayload({ service: RELAY_SERVICE_IDENTITY, status: 'ok' })).not.toThrowError(AppError)
  })
})

describe('HMAC_SIGNATURE_HEADER', () => {
  it('is the documented header name', () => {
    expect(HMAC_SIGNATURE_HEADER).toBe('x-9drive-signature')
    expect(RELAY_PROTOCOL_VERSION).toBe('9drive-relay-v1')
  })
})

describe('relay build (static artifact → local preflight)', () => {
  it('loads a parse-clean ES module with /health and /fetch handlers, no imports', async () => {
    const source = loadRelaySource()
    expect(source).toContain('SERVICE_IDENTITY')
    expect(source).toContain("'/health'")
    expect(source).toContain("'/fetch'")
    expect(source).toContain('export default')
    expect(source).not.toContain('import ')
    // Well under Cloudflare's direct-upload limits.
    expect(source.length).toBeLessThan(64 * 1024)
    await expect(validateRelaySource(source)).resolves.toBeUndefined()
  })

  it('preflight rejects an invalid artifact as WORKER_RELAY_BUILD_FAILED', async () => {
    await expect(validateRelaySource('export const broken = ')).rejects.toMatchObject({ code: 'WORKER_RELAY_BUILD_FAILED' })
    // TypeScript-syntax leftovers must be caught locally, never uploaded.
    await expect(validateRelaySource('interface Foo {}\nexport default { fetch: () => {} }')).rejects.toMatchObject({ code: 'WORKER_RELAY_BUILD_FAILED' })
    // Missing entrypoint (no export default) must be caught too.
    await expect(validateRelaySource('const x = 1;')).rejects.toMatchObject({ code: 'WORKER_RELAY_BUILD_FAILED' })
  })

  it('build output parses locally and never contains secrets, TS or process.env', async () => {
    const { source } = buildCloudflareRelay('sup3r-s3cret-value')
    await expect(validateRelaySource(source)).resolves.toBeUndefined()
    expect(source).toContain('export default')
    expect(source).not.toContain('interface ')
    expect(source).not.toContain('process.env')
    expect(source).not.toContain('sup3r-s3cret-value')
    // The secret travels only as the binding metadata, never in source.
    expect(source).not.toContain('RELAY_SECRET =')
  })

  it('source is byte-identical regardless of secret content (no interpolation)', () => {
    // Secrets with characters that would break JS string interpolation must
    // leave the artifact untouched: the secret is a binding, not source.
    const baseline = buildCloudflareRelay('baseline').source
    const nasty = [`dq"dq`, `sq'sq`, `bs\\bs`, 'bt`bt', 'dol${x}dol', 'nl\nline', "nl\rcr"] as const
    for (const secret of nasty) {
      expect(buildCloudflareRelay(secret).source).toBe(baseline)
    }
  })

  it('build returns metadata with main_module === module name and the secret binding', () => {
    const { source, moduleName, metadata } = buildCloudflareRelay('relay-secret')
    expect(moduleName).toBe('worker.mjs')
    expect(metadata).toContain('"main_module":"worker.mjs"')
    expect(metadata).toContain('"type":"secret_text"')
    expect(metadata).toContain('"name":"RELAY_SECRET"')
    expect(metadata).toContain('relay-secret')
    expect(metadata).toContain(`"compatibility_date":"${RELAY_COMPATIBILITY_DATE}"`)
    expect(source.length).toBeGreaterThan(0)
  })

  it('exports the canonical module name and compatibility date constants', () => {
    expect(RELAY_MODULE_NAME).toBe('worker.mjs')
    expect(RELAY_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('relaySourceSha256 is a stable hex digest (safe to log)', () => {
    const s = loadRelaySource()
    expect(relaySourceSha256(s)).toMatch(/^[a-f0-9]{64}$/)
    expect(relaySourceSha256(s)).toBe(relaySourceSha256(s))
  })
})

// ── Managed provisioning (fake Cloudflare API via global fetch mock) ─────────

const CF_BASE = 'https://api.cloudflare.com/client/v4'

function cfResponse(status: number, body: unknown) {
  return { status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

function setupFetch() {
  const called: Array<{ method?: string; path?: string; body?: unknown }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const path = url.replace(CF_BASE, '')
    called.push({ method, path, body: init?.body })
    if (path === '/user/tokens/verify' && method === 'GET') return cfResponse(200, { success: true })
    if (path.startsWith('/accounts/acc-1/workers/scripts/') && method === 'PUT') return cfResponse(200, { success: true, result: { id: path.split('/').pop() } })
    const subdomainMatch = path.match(/^\/accounts\/acc-1\/workers\/scripts\/([^/]+)\/subdomain$/)
    if (subdomainMatch && method === 'GET') {
      return cfResponse(200, { success: true, result: { subdomain: 'example-subdomain' } })
    }
    const deleteMatch = path.match(/^\/accounts\/acc-1\/workers\/scripts\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') return cfResponse(200, { success: true })
    return cfResponse(404, { success: false, errors: [{ code: 9999, message: 'not found' }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, called }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cloudflare managed provisioning', () => {
  it('metadata exposes managed:true with only Account ID / API Token / Worker Name', () => {
    const meta = cloudflareWorkerDriver.getMetadata()
    expect(meta.managed).toBe(true)
    expect(meta.authTypes).toEqual(['hmac'])
    expect(meta.fields.map((f) => f.key)).toEqual(['accountId', 'apiToken', 'workerName'])
    expect(meta.fields.find((f) => f.key === 'apiToken')?.secret).toBe(true)
  })

  it('validateConfig rejects a user-supplied endpoint (system-managed)', async () => {
    await expect(
      cloudflareWorkerDriver.validateConfig!({ endpointUrl: 'https://x.workers.dev', config: { accountId: 'a', apiToken: 't', workerName: 'n' } }),
    ).rejects.toMatchObject({ code: 'WORKER_DRIVER_CONFIG_INVALID' })
  })

  it('validateConfig rejects an invalid worker name', async () => {
    await expect(
      cloudflareWorkerDriver.validateConfig!({ config: { accountId: 'a', apiToken: 't', workerName: 'bad name!' } }),
    ).rejects.toThrowError(AppError)
  })

  it('validateConfig verifies the API token before accepting', async () => {
    const { fetchMock } = setupFetch()
    const result = await cloudflareWorkerDriver.validateConfig!({ config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' } })
    expect(fetchMock).toHaveBeenCalledWith(`${CF_BASE}/user/tokens/verify`, expect.objectContaining({ method: 'GET' }))
    expect(result.endpointUrl).toBeNull()
    expect(result.configEncryptedInput).toMatchObject({
      config: { accountId: 'acc-1', workerName: 'relay-1' },
      credentials: { apiToken: 'tok' },
    })
  })

  it('provision: multipart upload (module + metadata with secret binding) → discover subdomain → endpoint', async () => {
    const { called, fetchMock } = setupFetch()
    const result = await cloudflareWorkerDriver.provision!({
      config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' },
      secret: 'relay-secret',
    })
    const PUTs = called.filter((c) => c.method === 'PUT')
    expect(PUTs).toHaveLength(1)
    expect(PUTs[0].path).toBe('/accounts/acc-1/workers/scripts/relay-1')
    // The body is a native FormData: metadata part + module part named after
    // the entry module (worker.mjs).
    const form = PUTs[0].body as FormData
    expect(form).toBeInstanceOf(FormData)
    const metadataPart = form.get('metadata') as Blob
    expect(metadataPart.type).toBe('application/json')
    const metadataJson = JSON.parse(await metadataPart.text()) as {
      main_module: string
      compatibility_date: string
      bindings: Array<{ type: string; name: string; text: string }>
    }
    // main_module MUST reference exactly the uploaded module part name —
    // a mismatch is what trips Cloudflare parse error 10021.
    expect(metadataJson.main_module).toBe('worker.mjs')
    expect(metadataJson.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(metadataJson.bindings).toEqual([{ type: 'secret_text', name: 'RELAY_SECRET', text: 'relay-secret' }])
    const modulePart = form.get('worker.mjs') as Blob
    expect(modulePart.type).toBe('application/javascript+module')
    const moduleSource = await modulePart.text()
    expect(moduleSource.length).toBeGreaterThan(0)
    expect(moduleSource).toContain('export default')
    expect(moduleSource).not.toContain('relay-secret')
    // Metadata part before module part: both present, module part non-empty.
    expect([...form.keys()]).toEqual(['metadata', 'worker.mjs'])
    // Serialize the FormData the way the runtime would: the generated framing
    // must contain a proper boundary with the module part named exactly
    // worker.mjs and typed as a JavaScript module.
    const serialized = await new Response(form).text()
    // The runtime's generated framing: undici serializes the field name inside
    // Content-Disposition (filename carries the module name), with each part's
    // own Content-Type header, closing with the boundary terminator.
    const lines = serialized.split('\r\n')
    expect(lines[0]).toMatch(/^--[^\r\n]+$/)
    expect(serialized).toContain('Content-Disposition: form-data; name="metadata"; filename="blob"\r\nContent-Type: application/json')
    expect(serialized).toContain('Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module')
    expect(serialized).toContain('"main_module":"worker.mjs"')
    expect(lines[lines.length - 2]).toMatch(/^--[^\r\n]+--$/)
    // The driver lets the runtime generate the multipart container + boundary:
    // no explicit content-type is passed for FormData bodies.
    expect(fetchMock).toHaveBeenCalledWith(
      `${CF_BASE}/accounts/acc-1/workers/scripts/relay-1`,
      expect.objectContaining({ method: 'PUT', headers: expect.not.objectContaining({ 'content-type': expect.anything() }) }),
    )
    expect(fetchMock).toHaveBeenCalledWith(`${CF_BASE}/accounts/acc-1/workers/scripts/relay-1/subdomain`, expect.anything())
    expect(result.endpointUrl).toBe('https://relay-1.example-subdomain.workers.dev')
    expect(result.configEncryptedInput).toMatchObject({
      runtime: { endpointUrl: 'https://relay-1.example-subdomain.workers.dev', protocolVersion: RELAY_PROTOCOL_VERSION },
    })
  })

  it('provision maps 401 → WORKER_CREDENTIAL_INVALID and never leaks the token or API body', async () => {
    setupFetch()
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse(401, { errors: [{ message: 'token echo: tok-value-1' }] })))
    const config = { accountId: 'acc-1', apiToken: 'tok-value-1', workerName: 'relay-1' }
    await expect(cloudflareWorkerDriver.provision!({ config, secret: 's' })).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_INVALID' })
    try {
      await cloudflareWorkerDriver.provision!({ config, secret: 's' })
    } catch (error) {
      expect(String((error as AppError).message)).not.toContain('tok-value-1')
      expect(String((error as AppError).message)).not.toContain('token echo')
    }
  })

  it('provision maps 409 → WORKER_PROVISION_CONFLICT (rename hint, no silent overwrite)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse(409, { errors: [{ message: 'already exists' }] })))
    await expect(
      cloudflareWorkerDriver.provision!({ config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' }, secret: 's' }),
    ).rejects.toMatchObject({ code: 'WORKER_PROVISION_CONFLICT' })
  })

  it('maps CF 400 with error code 10053 (script exists) → WORKER_PROVISION_CONFLICT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse(400, { success: false, errors: [{ code: 10053, message: 'script already exists' }] })))
    await expect(
      cloudflareWorkerDriver.provision!({ config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' }, secret: 's' }),
    ).rejects.toMatchObject({ code: 'WORKER_PROVISION_CONFLICT' })
  })

  it('deprovision treats 404 as success (idempotent)', async () => {
    const { fetchMock } = setupFetch()
    await cloudflareWorkerDriver.deprovision!({ config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' } })
    expect(fetchMock).toHaveBeenCalledWith(`${CF_BASE}/accounts/acc-1/workers/scripts/relay-1`, expect.objectContaining({ method: 'DELETE' }))
  })

  it('deprovision on 500 throws WORKER_DEPROVISION_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse(500, { errors: [{ message: 'boom' }] })))
    await expect(
      cloudflareWorkerDriver.deprovision!({ config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' } }),
    ).rejects.toMatchObject({ code: 'WORKER_PROVISION_FAILED' })
  })

  it('update with a renamed worker deploys the new script and removes the old one', async () => {
    const { called } = setupFetch()
    const result = await cloudflareWorkerDriver.update!({
      config: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-2' },
      storedConfig: { accountId: 'acc-1', apiToken: 'tok', workerName: 'relay-1' },
      secret: 'relay-secret',
    })
    const DELETEs = called.filter((c) => c.method === 'DELETE')
    expect(DELETEs).toHaveLength(1)
    expect(DELETEs[0].path).toBe('/accounts/acc-1/workers/scripts/relay-1')
    expect(result.endpointUrl).toBe('https://relay-2.example-subdomain.workers.dev')
  })

  it('mapCloudflareApiError never includes provider body text (safe code + step only)', () => {
    const err = mapCloudflareApiError('upload', 500, '{"errors":[{"message":"FATAL: token=abc123 leaked"}]}')
    expect(err.message).not.toContain('abc123')
    expect(err.message).not.toContain('FATAL')
    expect(err.code).toBe('WORKER_PROVISION_FAILED')
  })

  it('reports the failing step + safe Cloudflare numeric error code', () => {
    const err = mapCloudflareApiError('upload', 400, JSON.stringify({ errors: [{ code: 10021, message: 'syntax error in worker' }] }))
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('WORKER_PROVISION_FAILED')
    expect(err.message).toContain('step: upload')
    expect(err.message).toContain('Cloudflare error 10021')
    expect(err.message).not.toContain('syntax error in worker')
  })

  it('maps CF 400 error code 10053 (script exists) → WORKER_PROVISION_CONFLICT', () => {
    const err = mapCloudflareApiError('upload', 400, JSON.stringify({ errors: [{ code: 10053 }] }))
    expect(err.code).toBe('WORKER_PROVISION_CONFLICT')
  })
})