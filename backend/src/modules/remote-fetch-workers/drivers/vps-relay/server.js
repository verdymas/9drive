/**
 * 9Drive VPS relay — self-hosted `9drive-relay-v1` network relay.
 *
 * Deploy: upload `9drive-vps-relay.zip` via hosting panel (Upload ZIP → Dockerfile),
 * set RELAY_SECRET, expose PORT (default 3000) behind the panel's HTTPS reverse proxy.
 *
 * Plain Node.js only — zero runtime dependencies. Streams bytes upstream→client
 * as they arrive; never buffers full files, never writes to /tmp, never base64-wraps
 * large payloads (except the legacy non-stream envelope path, which is capped).
 *
 * Protocol: identical to drivers/cloudflare-relay/worker.mjs and
 * drivers/deno-relay/worker.ts. HMAC `x-9drive-signature = HMAC(secret, "METHOD path")`.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

// ── Config ──────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const MAX_CONCURRENT_TRANSFERS = Number.parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '2', 10) || 2;
const MAX_REDIRECTS = Number.parseInt(process.env.MAX_REDIRECTS || '5', 10) || 5;
const MAX_CONTROL_BYTES = Number.parseInt(process.env.MAX_CONTROL_BYTES || '65536', 10) || 65536;
const UPSTREAM_HEADER_TIMEOUT_MS = Number.parseInt(process.env.UPSTREAM_HEADER_TIMEOUT_MS || '20000', 10) || 20000;
const MAX_ENVELOPE_BYTES = Number.parseInt(process.env.MAX_ENVELOPE_BYTES || String(5 * 1024 * 1024), 10) || 5 * 1024 * 1024;
// Test-only bypass for local mocked upstreams (127.0.0.1). NEVER enable in
// production — production must always deny loopback/private/link-local targets.
const ALLOW_PRIVATE_UPSTREAM = ['true', '1', 'yes', 'on'].includes(String(process.env.ALLOW_PRIVATE_UPSTREAM || '').toLowerCase());
// Optional asserted public base URL for setup diagnostics (never inferred from
// request headers). Example: RELAY_PUBLIC_URL=https://relay.example.com
const RELAY_PUBLIC_URL_RAW = (process.env.RELAY_PUBLIC_URL || '').trim();
// VPS Browser Warmup (short-lived headless Chromium page prep, VPS-only).
// Disabled by default until the live gate proves genuine media bytes.
// BROWSER_WARMUP_ENABLED=true + a Chromium executable are both required to
// advertise support; otherwise POST /warmup answers 501 WARMUP_NOT_SUPPORTED
// and /health reports supported:false (legacy relays keep working for
// non-warmup jobs). Never run untrusted pages as root without sandboxing.
const BROWSER_WARMUP_ENABLED = ['true', '1', 'yes', 'on'].includes(String(process.env.BROWSER_WARMUP_ENABLED || '').toLowerCase());
const BROWSER_WARMUP_TIMEOUT_MS = Math.min(Math.max(Number.parseInt(process.env.BROWSER_WARMUP_TIMEOUT_MS || '25000', 10) || 25000, 5000), 60000);
const BROWSER_WARMUP_REPLAY_WINDOW_SECONDS = Math.min(Math.max(Number.parseInt(process.env.BROWSER_WARMUP_REPLAY_WINDOW_SECONDS || '300', 10) || 300, 30), 600);
const CHROMIUM_EXECUTABLE_PATH = (process.env.CHROMIUM_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
let warmupLastErrorCategory = null;
let warmingActive = false;
const warmupNonceCache = new Map(); // nonce -> expiresAtMs (replay resistance, bounded)

const START_TIME_MS = Date.now();

const SERVICE_IDENTITY = '9drive-relay';
const PROTOCOL_VERSION = '9drive-relay-v1';
const COOKIE_PROTOCOL_VERSION = '9drive-relay-v2-cookie';
const SIGNATURE_HEADER = 'x-9drive-signature';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'file:', 'ftp:', 'data:']);
const ALLOWED_UPSTREAM_HEADERS = new Set([
  'referer',
  'origin',
  'user-agent',
  'cookie',
  'accept',
  'accept-encoding',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-storage-access',
  'range',
]);

let activeTransfers = 0;

// ── Safe logging helpers (never query values, header values, bodies, secrets) ──
function urlFingerprintForLog(rawUrl) {
  try {
    const canonical = new URL(rawUrl).href;
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('sha256').update(String(rawUrl), 'utf8').digest('hex').slice(0, 12);
  }
}

function urlShapeForLog(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const keys = [...u.searchParams.keys()].sort().join('+') || 'none';
    const count = [...u.searchParams.keys()].length;
    return `pathLen=${u.pathname.length} queryCount=${count} queryKeys=${keys} hasFragment=${Boolean(u.hash)} urlLen=${String(rawUrl).length}`;
  } catch {
    return `pathLen=unknown queryCount=unknown queryKeys=unknown hasFragment=unknown urlLen=${String(rawUrl).length}`;
  }
}

function log(line) {
  console.log(line);
}

// ── SSRF defenses (mirror backend ssrf.ts blocklists) ───────────────────
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function ipv4InCidr(ip, cidrBase, prefix) {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(cidrBase);
  if (ipInt === null || baseInt === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : ~((2 ** (32 - prefix)) - 1) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isBlockedIpv4(ip) {
  return IPV4_BLOCKS.some(([base, prefix]) => ipv4InCidr(ip, base, prefix));
}

function expandIpv6(ip) {
  // Expand :: shorthand into 8 hextets. Returns null on invalid.
  try {
    const [head = '', tail = ''] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    // Handle embedded IPv4 (e.g. ::ffff:127.0.0.1) — treat via mapped check first.
    if (ip.includes('.')) return null;
    const missing = 8 - headParts.length - tailParts.length;
    if (!ip.includes('::')) {
      if (headParts.length !== 8) return null;
      return headParts;
    }
    if (missing < 0) return null;
    return [...headParts, ...Array(missing).fill('0'), ...tailParts];
  } catch {
    return null;
  }
}

function isBlockedIp(ip) {
  const normalized = String(ip).toLowerCase();
  // IPv4-mapped IPv6 ::ffff:a.b.c.d → check inner IPv4.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 ULA
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe90:') || normalized.startsWith('fea0:') || normalized.startsWith('feb0:')) return true;
    // fe80::/10 covers fe80–febf; approximate with prefix check on first hextet.
    const parts = expandIpv6(normalized);
    if (parts && parts[0]) {
      const first = parseInt(parts[0], 16);
      if (!Number.isNaN(first)) {
        if ((first & 0xffc0) === 0xfe80) return true; // link-local
        if ((first & 0xff00) === 0xff00) return true; // multicast
      }
    } else {
      return true; // unparseable → blocked
    }
    return false;
  }
  return true; // unparseable → blocked
}

async function resolveAndValidateHost(host) {
  if (ALLOW_PRIVATE_UPSTREAM) {
    // Test-only: still resolve to catch DNS failures, but skip blocklists.
    if (net.isIP(host)) return host;
    try {
      const records = await dns.lookup(host, { all: true });
      if (!records || records.length === 0) {
        const err = new Error('dns failed');
        err.code = 'SSRF_DNS_FAILED';
        throw err;
      }
      return records[0].address;
    } catch {
      const err = new Error('dns failed');
      err.code = 'SSRF_DNS_FAILED';
      throw err;
    }
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      const err = new Error('blocked address');
      err.code = 'SSRF_BLOCKED_ADDRESS';
      throw err;
    }
    return host;
  }
  // Block obvious internal hostnames without DNS.
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === 'metadata.google.internal' || lower.endsWith('.internal') || lower.endsWith('.local')) {
    const err = new Error('blocked hostname');
    err.code = 'SSRF_BLOCKED_ADDRESS';
    throw err;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    const err = new Error('dns failed');
    err.code = 'SSRF_DNS_FAILED';
    throw err;
  }
  if (!records || records.length === 0) {
    const err = new Error('dns failed');
    err.code = 'SSRF_DNS_FAILED';
    throw err;
  }
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      const err = new Error('blocked address');
      err.code = 'SSRF_BLOCKED_ADDRESS';
      throw err;
    }
  }
  return records[0].address;
}

// ── HMAC ────────────────────────────────────────────────────────────────
function signaturesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function expectedSignature(secret, method, path) {
  return crypto.createHmac('sha256', secret).update(`${method} ${path}`, 'utf8').digest('hex');
}

function verifyHmac(req, urlPath) {
  if (!RELAY_SECRET) return false;
  const got = req.headers[SIGNATURE_HEADER];
  const expected = expectedSignature(RELAY_SECRET, req.method, urlPath);
  return signaturesMatch(got, expected);
}

function warmupSupported() {
  return BROWSER_WARMUP_ENABLED && CHROMIUM_EXECUTABLE_PATH.length > 0;
}

function pruneWarmupNonces(now = Date.now()) {
  if (warmupNonceCache.size > 2000) {
    for (const [nonce, exp] of warmupNonceCache) {
      if (exp <= now) warmupNonceCache.delete(nonce);
      if (warmupNonceCache.size <= 1000) break;
    }
  } else {
    for (const [nonce, exp] of warmupNonceCache) {
      if (exp <= now) warmupNonceCache.delete(nonce);
    }
  }
}

/**
 * Payload-bound warmup auth: HMAC(secret, "POST /warmup\nsha256(body)\nTs\nNonce").
 * Binds authentication to the exact page URL + timestamp + nonce (replay
 * window enforced, nonces single-use). Legacy /fetch keeps bare METHOD+path.
 */
function verifyWarmupHmac(req, rawBody) {
  if (!RELAY_SECRET) return { ok: false, reason: 'AUTH_FAILED' };
  const got = req.headers[SIGNATURE_HEADER];
  const tsRaw = req.headers['x-9drive-timestamp'];
  const nonce = req.headers['x-9drive-nonce'];
  if (typeof got !== 'string' || typeof tsRaw !== 'string' || typeof nonce !== 'string') return { ok: false, reason: 'AUTH_FAILED' };
  if (!/^[0-9a-fA-F]{16,128}$/.test(nonce)) return { ok: false, reason: 'REPLAY_REJECTED' };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'REPLAY_REJECTED' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > BROWSER_WARMUP_REPLAY_WINDOW_SECONDS) return { ok: false, reason: 'REPLAY_REJECTED' };
  pruneWarmupNonces();
  if (warmupNonceCache.has(nonce)) return { ok: false, reason: 'REPLAY_REJECTED' };
  const bodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const expected = crypto.createHmac('sha256', RELAY_SECRET).update(`POST /warmup\n${bodyHash}\n${tsRaw}\n${nonce}`, 'utf8').digest('hex');
  if (!signaturesMatch(got, expected)) return { ok: false, reason: 'AUTH_FAILED' };
  warmupNonceCache.set(nonce, Date.now() + BROWSER_WARMUP_REPLAY_WINDOW_SECONDS * 1000);
  return { ok: true };
}

function pageHostForLog(rawUrl) {
  try { return new URL(rawUrl).hostname; } catch { return ''; }
}

function isMediaishUrl(href) {
  const lower = String(href).toLowerCase().split('?')[0];
  if (lower.includes('vidthumb')) return false;
  return lower.includes('.vid') || lower.endsWith('.mp4') || lower.endsWith('.m3u8') || lower.includes('.mp4');
}

// ── HTTP helpers ────────────────────────────────────────────────────────
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

/**
 * Validate the operator-configured public base URL for setup diagnostics.
 * Strict: https only, no credentials, no query, no fragment. Never reads
 * request headers — only this explicit variable is ever asserted.
 * Returns { value: string|null, warning: string|null } (names only, no values).
 */
function getPublicBaseUrl() {
  if (!RELAY_PUBLIC_URL_RAW) {
    return { value: null, warning: 'RELAY_PUBLIC_URL is not set — publicBaseUrl is null. Set RELAY_PUBLIC_URL to the relay https domain.', invalid: false };
  }
  if (/[\r\n\s]/.test(RELAY_PUBLIC_URL_RAW)) {
    return { value: null, warning: 'RELAY_PUBLIC_URL is invalid — expected an https URL without credentials, query, or fragment.', invalid: true };
  }
  let u;
  try {
    u = new URL(RELAY_PUBLIC_URL_RAW);
  } catch {
    return { value: null, warning: 'RELAY_PUBLIC_URL is invalid — expected an https URL without credentials, query, or fragment.', invalid: true };
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.hostname) {
    return { value: null, warning: 'RELAY_PUBLIC_URL is invalid — expected an https URL without credentials, query, or fragment.', invalid: true };
  }
  return { value: u.toString().replace(/\/+$/, ''), warning: null, invalid: false };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('control body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validatePayload(payload) {
  const { protocolVersion, url, method, headers, body, response, traceId } = payload ?? {};
  if (protocolVersion === undefined || protocolVersion === null) return { reason: 'MISSING_PROTOCOL' };
  if (protocolVersion !== PROTOCOL_VERSION && protocolVersion !== COOKIE_PROTOCOL_VERSION) return { reason: 'INVALID_PROTOCOL' };
  if (method === undefined || method === null) return { reason: 'MISSING_METHOD' };
  if (typeof method !== 'string') return { reason: 'INVALID_METHOD' };
  if (!ALLOWED_METHODS.has(method)) return { reason: 'UNSUPPORTED_METHOD' };
  if (url === undefined || url === null) return { reason: 'MISSING_URL' };
  if (typeof url !== 'string') return { reason: 'INVALID_URL' };
  if (headers !== undefined && headers !== null && (typeof headers !== 'object' || Array.isArray(headers))) return { reason: 'INVALID_HEADERS' };
  const hasCookie = headers && typeof headers === 'object' && Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
  if (hasCookie && protocolVersion !== COOKIE_PROTOCOL_VERSION) return { reason: 'INVALID_PROTOCOL' };
  if (body !== undefined && typeof body !== 'string') return { reason: 'INVALID_BODY_TYPE' };
  if (response !== undefined && response !== 'stream') return { reason: 'INVALID_BODY_TYPE' };
  if (traceId !== undefined && (typeof traceId !== 'string' || traceId.length < 1 || traceId.length > 128)) return { reason: 'INVALID_BODY_TYPE' };
  return null;
}

function buildUpstreamHeaders(inHeaders) {
  const out = {};
  if (!inHeaders || typeof inHeaders !== 'object') return out;
  for (const [key, value] of Object.entries(inHeaders)) {
    if (typeof value !== 'string') continue;
    if (key.includes('\r') || key.includes('\n') || value.includes('\r') || value.includes('\n')) continue;
    if (!ALLOWED_UPSTREAM_HEADERS.has(String(key).toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function fetchWithHeaderTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream header timeout')), timeoutMs);
  const combined = options.signal
    ? AbortSignal.any ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    : controller.signal;
  return fetch(url, { ...options, signal: combined }).finally(() => clearTimeout(timer));
}

async function doValidatedFetch(targetHref, method, outHeaders, body, protocolVersion, traceId, targetHostForLog, urlFp, shape, hasRange, headerNames) {
  let currentUrl = targetHref;
  let currentMethod = method;
  let currentBody = method === 'GET' || method === 'HEAD' ? undefined : body;
  let redirectCount = 0;

  for (;;) {
    // Per-hop SSRF validation (DNS + blocklist), incl. redirect destinations.
    let u;
    try {
      u = new URL(currentUrl);
    } catch {
      return { kind: 'invalid-url' };
    }
    if (BLOCKED_SCHEMES.has(u.protocol) || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      return { kind: 'invalid-url' };
    }
    if (u.username || u.password) {
      return { kind: 'invalid-url' };
    }
    try {
      await resolveAndValidateHost(u.hostname);
    } catch (e) {
      return { kind: 'blocked', code: e.code || 'SSRF_BLOCKED_ADDRESS' };
    }

    let upstream;
    try {
      upstream = await fetchWithHeaderTimeout(
        currentUrl,
        { method: currentMethod, headers: outHeaders, body: currentBody, redirect: 'manual' },
        UPSTREAM_HEADER_TIMEOUT_MS,
      );
    } catch (e) {
      const name = e && e.name ? String(e.name) : 'Unknown';
      return { kind: 'exception', errorName: name };
    }

    const location = upstream.headers.get('location');
    if (location && [301, 302, 303, 307, 308].includes(upstream.status)) {
      if (redirectCount >= MAX_REDIRECTS) {
        try { await upstream.arrayBuffer().catch(() => null); } catch {}
        return { kind: 'too-many-redirects' };
      }
      let next;
      try {
        next = new URL(location, currentUrl).href;
      } catch {
        try { await upstream.arrayBuffer().catch(() => null); } catch {}
        return { kind: 'invalid-url' };
      }
      try { await upstream.arrayBuffer().catch(() => null); } catch {}
      // 303 always becomes GET; 301/302 with POST become GET (fetch spec).
      if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = next;
      redirectCount += 1;
      continue;
    }

    return { kind: 'response', upstream, finalUrl: currentUrl || upstream.url || targetHref, redirectCount };
  }
}

// ── Handlers ────────────────────────────────────────────────────────────
function handleHealthz(req, res) {
  log(`[relay] event=request_received stage=health handler=healthz relayHttpStatus=200 upstreamStatus=none fetchExecuted=false`);
  sendJson(res, 200, { status: 'ok', service: SERVICE_IDENTITY });
}

function handleHealth(req, res, urlPath) {
  if (!verifyHmac(req, urlPath)) {
    log(`[relay] event=request_received stage=auth handler=unknown traceId=none relayHttpStatus=401 upstreamStatus=none fetchExecuted=false method=${req.method}`);
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  log(`[relay] event=request_received stage=health handler=health traceId=none relayHttpStatus=200 upstreamStatus=none fetchExecuted=false`);
  return sendJson(res, 200, {
    service: SERVICE_IDENTITY,
    protocolVersion: PROTOCOL_VERSION,
    status: 'ok',
    capabilities: { streaming: true, rangeRequests: true, requestContext: true, hls: false, maxBodyBytes: null, browserWarmup: { supported: warmupSupported(), configured: BROWSER_WARMUP_ENABLED } },
  });
}

/**
 * GET /system-health — unauthenticated setup diagnostics (no HMAC on purpose:
 * it must answer while HMAC is still unconfigured). Allowlisted booleans/enums
 * only — never secrets, hashes, env values, URLs with tokens, or client hosts.
 * Never proxies content and never initiates an upstream fetch.
 */
function handleSystemHealth(req, res) {
  const secretConfigured = RELAY_SECRET.length > 0;
  const publicBase = getPublicBaseUrl();
  const warnings = [];
  if (!secretConfigured) {
    warnings.push('RELAY_SECRET is not set — set RELAY_SECRET and redeploy. Relay operations fail closed until it is configured.');
  }
  if (publicBase.warning) warnings.push(publicBase.warning);

  // ready = local config + handlers present (not a claim about source
  // reachability or 9Drive-side secret match). A missing public URL keeps
  // ready with a warning; an invalid one is degraded. not_configured =
  // secret missing (relay fail-closed).
  const status = !secretConfigured ? 'not_configured' : (publicBase.invalid ? 'degraded' : 'ready');
  const httpStatus = status === 'not_configured' ? 503 : 200;
  const message = !secretConfigured
    ? 'Relay is not configured: set RELAY_SECRET in the deployment environment and redeploy, then use the authenticated connection test in 9Drive (Workers → Virtual Private Server) to verify that both sides share the same secret.'
    : 'Relay service is configured. Use the authenticated connection test in 9Drive to verify that both sides share the same secret.';

  log(`[relay] event=request_received stage=health handler=system-health relayHttpStatus=${httpStatus} upstreamStatus=none fetchExecuted=false status=${status}`);
  const body = JSON.stringify({
    service: '9drive-vps-relay',
    provider: 'Virtual Private Server',
    protocol: PROTOCOL_VERSION,
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - START_TIME_MS) / 1000),
    publicBaseUrl: publicBase.warning ? null : publicBase.value,
    endpoints: { health: '/system-health', relay: '/fetch' },
    setup: {
      relaySecret: { configured: secretConfigured },
      authentication: { mode: 'hmac', configured: secretConfigured },
      httpServer: { listening: true },
      relayHandler: { registered: true },
      publicUrl: { configured: publicBase.value !== null },
    },
    capabilities: { rangeRequests: 'implemented', responseStreaming: 'implemented' },
    browserWarmup: { supported: warmupSupported(), configured: BROWSER_WARMUP_ENABLED, lastErrorCategory: warmupLastErrorCategory },
    warnings,
    message,
  });
  res.writeHead(httpStatus, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function handleFetch(req, res, urlPath) {
  const startedAt = Date.now();
  if (!verifyHmac(req, urlPath)) {
    log(`[relay] event=request_received stage=auth handler=unknown traceId=none relayHttpStatus=401 upstreamStatus=none fetchExecuted=false method=POST`);
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  log(`[relay] event=request_received stage=routing handler=fetch method=POST path=/fetch`);

  if (activeTransfers >= MAX_CONCURRENT_TRANSFERS) {
    log(`[relay] event=overloaded stage=routing handler=fetch relayHttpStatus=429 upstreamStatus=none fetchExecuted=false active=${activeTransfers} max=${MAX_CONCURRENT_TRANSFERS}`);
    return sendJson(res, 429, { error: 'overloaded', code: 'CONCURRENCY_LIMIT' });
  }

  let raw;
  try {
    raw = await readBody(req, MAX_CONTROL_BYTES);
  } catch {
    log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=none reason=INVALID_BODY_TYPE relayHttpStatus=400 upstreamStatus=none fetchExecuted=false`);
    return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_BODY_TYPE' });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=none reason=INVALID_JSON relayHttpStatus=400 upstreamStatus=none fetchExecuted=false`);
    return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_JSON' });
  }

  const traceId = typeof payload?.traceId === 'string' && payload.traceId.length >= 1 && payload.traceId.length <= 128 ? payload.traceId : 'none';
  const validationError = validatePayload(payload);
  if (validationError) {
    log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=${traceId} reason=${validationError.reason} relayHttpStatus=400 upstreamStatus=none fetchExecuted=false protocolVersion=${typeof payload?.protocolVersion === 'string' ? payload.protocolVersion : 'none'}`);
    return sendJson(res, 400, { error: 'invalid payload', reason: validationError.reason });
  }

  const { method, url, headers, body, protocolVersion, response: responseMode } = payload;
  const STREAMING = responseMode === 'stream';
  const shape = urlShapeForLog(url);
  const urlFp = urlFingerprintForLog(url);
  let targetHostForLog = '';
  try { targetHostForLog = new URL(url).hostname; } catch {}
  const hasCookie = headers && typeof headers === 'object' && Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
  const hasRange = headers && typeof headers === 'object' && Object.keys(headers).some((k) => String(k).toLowerCase() === 'range');
  const payloadKeys = Object.keys(payload ?? {}).sort().join(',');
  log(`[relay] event=request_received stage=validation handler=fetch traceId=${traceId} protocol=${protocolVersion} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} payloadKeys=${payloadKeys} hasRange=${Boolean(hasRange)} hasCookie=${Boolean(hasCookie)} fetchExecuted=false ${shape}`);

  const outHeaders = buildUpstreamHeaders(headers);
  const headerNames = Object.keys(outHeaders).map((k) => String(k).toLowerCase()).sort().join(',') || 'none';
  log(`[relay] event=validation_accepted stage=pre-fetch handler=fetch traceId=${traceId} protocol=${protocolVersion} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} upstreamHeaderNames=${headerNames} hasRange=${Boolean(hasRange)} fetchExecuted=false ${shape}`);
  log(`[relay] event=upstream_fetch_start stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} upstreamHeaderNames=${headerNames} hasRange=${Boolean(hasRange)} fetchExecuted=false ${shape}`);

  activeTransfers += 1;
  const downstreamClosed = { closed: false };
  req.on('close', () => { downstreamClosed.closed = true; });
  // Abort upstream when downstream disconnects.
  const downstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) downstreamAbort.abort(new Error('downstream closed'));
  });

  try {
    const outcome = await doValidatedFetch(url, method, outHeaders, body, protocolVersion, traceId, targetHostForLog, urlFp, shape, hasRange, headerNames);

    if (outcome.kind === 'invalid-url') {
      log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=${traceId} reason=INVALID_URL relayHttpStatus=400 upstreamStatus=none fetchExecuted=false ${shape}`);
      return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_URL' });
    }
    if (outcome.kind === 'blocked') {
      log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=${traceId} reason=INVALID_URL relayHttpStatus=400 upstreamStatus=none fetchExecuted=false ${shape}`);
      return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_URL' });
    }
    if (outcome.kind === 'too-many-redirects') {
      log(`[relay] event=upstream_fetch_failed stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} hasRange=${Boolean(hasRange)} fetchExecuted=true upstreamStatus=none relayHttpStatus=502 errorName=TooManyRedirects`);
      return sendJson(res, 502, { error: 'upstream fetch failed', code: 'UPSTREAM_FETCH_EXCEPTION', reason: 'TooManyRedirects' });
    }
    if (outcome.kind === 'exception') {
      log(`[relay] event=upstream_fetch_failed stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} hasRange=${Boolean(hasRange)} fetchExecuted=true upstreamStatus=none relayHttpStatus=502 errorName=${outcome.errorName}`);
      return sendJson(res, 502, { error: 'upstream fetch failed', code: 'UPSTREAM_FETCH_EXCEPTION', reason: outcome.errorName });
    }

    const { upstream, finalUrl, redirectCount } = outcome;
    let finalHost = '';
    try { finalHost = new URL(finalUrl).hostname; } catch {}
    const finalUrlFp = urlFingerprintForLog(finalUrl);
    const redirected = Boolean(finalUrl) && finalUrl !== new URL(url).href;
    log(`[relay] event=upstream_response stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} finalHost=${finalHost || 'unknown'} finalUrlFp=${finalUrlFp} sameHost=${finalHost === targetHostForLog} redirected=${redirected} upstreamStatus=${upstream.status} relayHttpStatus=200 fetchExecuted=true responseMode=${STREAMING ? 'stream' : 'envelope'} upstreamHeaderNames=${headerNames} hasRange=${Boolean(hasRange)} hasCookie=${Boolean(hasCookie)} ${shape}`);

    if (STREAMING) {
      const passthrough = {};
      upstream.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        if (k === 'transfer-encoding' || k === 'content-length' || k === 'connection') return;
        passthrough[key] = value;
      });
      passthrough['x-9drive-streaming'] = '1';
      passthrough['x-9drive-upstream-status'] = String(upstream.status);
      if (finalUrl) passthrough['x-9drive-final-url'] = encodeURI(finalUrl);
      res.writeHead(200, passthrough);
      if (method === 'HEAD' || !upstream.body) {
        res.end();
        const ms = Date.now() - startedAt;
        log(`[relay] event=relay_responded stage=response handler=fetch traceId=${traceId} relayHttpStatus=200 upstreamStatus=${upstream.status} durationMs=${ms} bytes=0`);
        return;
      }
      let bytes = 0;
      const reader = upstream.body.getReader();
      req.on('close', () => { try { reader.cancel().catch(() => {}); } catch {} });
      res.on('close', () => { try { reader.cancel().catch(() => {}); } catch {} });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (downstreamClosed.closed || res.destroyed) {
            try { await reader.cancel(); } catch {}
            break;
          }
          const ok = res.write(value);
          if (!ok) await new Promise((r) => res.once('drain', r));
        }
        res.end();
        const ms = Date.now() - startedAt;
        log(`[relay] event=relay_responded stage=response handler=fetch traceId=${traceId} relayHttpStatus=200 upstreamStatus=${upstream.status} durationMs=${ms} bytes=${bytes}`);
      } catch (e) {
        const ms = Date.now() - startedAt;
        log(`[relay] event=stream_error stage=response handler=fetch traceId=${traceId} relayHttpStatus=200 upstreamStatus=${upstream.status} durationMs=${ms} bytes=${bytes} error=stream-error`);
        try { res.destroy(); } catch {}
      } finally {
        try { reader.releaseLock(); } catch {}
      }
      return;
    }

    // Legacy JSON envelope (capped to avoid OOM on large files).
    const contentLength = Number(upstream.headers.get('content-length') || '0');
    if (contentLength > MAX_ENVELOPE_BYTES) {
      try { await upstream.arrayBuffer().catch(() => null); } catch {}
      log(`[relay] event=upstream_fetch_failed stage=upstream handler=fetch traceId=${traceId} upstreamStatus=none relayHttpStatus=502 errorName=ResourceLimit fetchExecuted=true ${shape}`);
      return sendJson(res, 502, { error: 'upstream fetch failed', code: 'UPSTREAM_FETCH_EXCEPTION', reason: 'ResourceLimit' });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_ENVELOPE_BYTES) {
      log(`[relay] event=upstream_fetch_failed stage=upstream handler=fetch traceId=${traceId} upstreamStatus=none relayHttpStatus=502 errorName=ResourceLimit fetchExecuted=true ${shape}`);
      return sendJson(res, 502, { error: 'upstream fetch failed', code: 'UPSTREAM_FETCH_EXCEPTION', reason: 'ResourceLimit' });
    }
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => { responseHeaders[key] = value; });
    const ms = Date.now() - startedAt;
    log(`[relay] event=relay_responded stage=response handler=fetch traceId=${traceId} relayHttpStatus=200 upstreamStatus=${upstream.status} durationMs=${ms} bytes=${buf.length}`);
    return sendJson(res, 200, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
      body: buf.toString('base64'),
      finalUrl,
      protocolVersion,
    });
  } finally {
    activeTransfers = Math.max(0, activeTransfers - 1);
  }
}

// ── Browser Warmup (POST /warmup) ─────────────────────────────────────────
// Short-lived headless Chromium page prep, VPS-only. Never clicks Play, never
// holds the browser open for downloads, never relaunches per Range request.
// One active warmup at a time (429 busy otherwise). Auth is payload-bound
// (timestamp+nonce+body hash); page URL + redirects validated against SSRF.
async function handleWarmup(req, res) {
  const startedAt = Date.now();
  let raw;
  try {
    raw = await readBody(req, MAX_CONTROL_BYTES);
  } catch {
    warmupLastErrorCategory = 'UPSTREAM_ERROR';
    return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_BODY_TYPE' });
  }
  const auth = verifyWarmupHmac(req, raw);
  if (!auth.ok) {
    warmupLastErrorCategory = auth.reason;
    log(`[relay] event=request_received stage=auth handler=warmup traceId=none relayHttpStatus=${auth.reason === 'REPLAY_REJECTED' ? 403 : 401} upstreamStatus=none fetchExecuted=false reason=${auth.reason}`);
    return sendJson(res, auth.reason === 'REPLAY_REJECTED' ? 403 : 401, { error: 'unauthorized', reason: auth.reason });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    warmupLastErrorCategory = 'UPSTREAM_ERROR';
    return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_JSON' });
  }
  const traceId = typeof payload?.traceId === 'string' && payload.traceId.length >= 1 && payload.traceId.length <= 128 ? payload.traceId : 'none';
  const pageUrl = payload?.pageUrl;
  const protocolVersion = payload?.protocolVersion;
  const timeoutMs = typeof payload?.timeoutMs === 'number' ? Math.min(Math.max(payload.timeoutMs, 5000), 60000) : BROWSER_WARMUP_TIMEOUT_MS;
  if (protocolVersion !== PROTOCOL_VERSION || typeof pageUrl !== 'string') {
    warmupLastErrorCategory = 'UPSTREAM_ERROR';
    log(`[relay] event=validation_rejected stage=validation handler=warmup traceId=${traceId} reason=INVALID_URL relayHttpStatus=400 upstreamStatus=none fetchExecuted=false`);
    return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_URL' });
  }
  let pageFp = urlFingerprintForLog(pageUrl);
  let pageHost = pageHostForLog(pageUrl);
  log(`[relay] event=request_received stage=validation handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} fetchExecuted=false`);
  // Validate page URL against the same SSRF rules as /fetch (top-level only;
  // subresource egress is bounded by navigation timeout + single-tab + process
  // disposal — see README warmup section for the residual risk note).
  try {
    const u = new URL(pageUrl);
    if (BLOCKED_SCHEMES.has(u.protocol) || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new Error('bad scheme');
    if (u.username || u.password) throw new Error('creds');
    await resolveAndValidateHost(u.hostname);
  } catch (e) {
    warmupLastErrorCategory = 'SECURITY_REJECTED';
    log(`[relay] event=validation_rejected stage=validation handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} reason=INVALID_URL relayHttpStatus=400 upstreamStatus=none fetchExecuted=false`);
    return sendJson(res, 400, { error: 'invalid payload', reason: 'INVALID_URL' });
  }
  if (!warmupSupported()) {
    warmupLastErrorCategory = 'NOT_SUPPORTED';
    log(`[relay] event=warmup_skipped stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} relayHttpStatus=501 reason=NOT_SUPPORTED fetchExecuted=false`);
    return sendJson(res, 501, { error: 'browser warmup not supported', code: 'WARMUP_NOT_SUPPORTED', protocolVersion: PROTOCOL_VERSION, status: 'not_supported', traceId });
  }
  if (warmingActive) {
    warmupLastErrorCategory = 'BUSY';
    log(`[relay] event=overloaded stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} relayHttpStatus=429 fetchExecuted=false`);
    return sendJson(res, 429, { error: 'overloaded', code: 'CONCURRENCY_LIMIT' });
  }
  warmingActive = true;
  log(`[relay] event=browser.launched stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} fetchExecuted=false timeoutMs=${timeoutMs}`);
  try {
    const outcome = await runChromiumWarmup(pageUrl, timeoutMs, traceId, pageHost, pageFp);
    const ms = Date.now() - startedAt;
    if (outcome.ok) {
      warmupLastErrorCategory = null;
      log(`[relay] event=browser.closed stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} navigationStatus=${outcome.navigationStatus ?? 'none'} mediaObserved=${outcome.mediaObserved} browserMedia206=${outcome.browserMedia206} durationMs=${ms} fetchExecuted=false`);
      return sendJson(res, 200, { protocolVersion: PROTOCOL_VERSION, status: 'warmed', navigationStatus: outcome.navigationStatus, mediaObserved: outcome.mediaObserved, browserMedia206: outcome.browserMedia206, traceId });
    }
    warmupLastErrorCategory = outcome.errorCategory || 'NAVIGATION_FAILED';
    log(`[relay] event=browser.closed stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} errorCategory=${warmupLastErrorCategory} durationMs=${ms} fetchExecuted=false`);
    const httpStatus = warmupLastErrorCategory === 'TIMEOUT' ? 504 : 502;
    return sendJson(res, httpStatus, { protocolVersion: PROTOCOL_VERSION, status: 'failed', navigationStatus: outcome.navigationStatus ?? null, mediaObserved: outcome.mediaObserved ?? 0, browserMedia206: false, traceId, errorCategory: warmupLastErrorCategory });
  } finally {
    warmingActive = false;
  }
}

/**
 * Launch short-lived Chromium, visit the page WITHOUT Play, observe media-ish
 * requests, then close everything (page/context/process) within the deadline.
 * Uses puppeteer-core + CHROMIUM_EXECUTABLE_PATH when present; the lean image
 * without Chromium never reaches here (501 above). Runs as non-root `node`
 * user; if the platform forces --no-sandbox, the risk is documented in README.
 */
async function runChromiumWarmup(pageUrl, timeoutMs, traceId, pageHost, pageFp) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default ?? (await import('puppeteer-core'));
  } catch {
    return { ok: false, errorCategory: 'BROWSER_LAUNCH_FAILED', navigationStatus: null, mediaObserved: 0 };
  }
  const memBefore = process.memoryUsage().rss;
  const start = Date.now();
  let browser = null;
  const observed = [];
  let browserMedia206 = false;
  let navigationStatus = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_EXECUTABLE_PATH,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--incognito'],
      timeout: 15000,
    });
    const page = await browser.newPage();
    await page.setRequestInterception(false).catch(() => {});
    page.on('request', (r) => {
      try {
        const href = r.url();
        if (isMediaishUrl(href)) observed.push(href);
      } catch {}
    });
    page.on('response', (r) => {
      try {
        const href = r.url();
        const status = r.status();
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        if (isMediaishUrl(href)) {
          if (!observed.includes(href)) observed.push(href);
          // Genuine media 206 only: 206 + non-HTML content. 206 text/html is
          // a ranged document, never a media success.
          if (status === 206 && ct && !ct.includes('text/html')) browserMedia206 = true;
        }
      } catch {}
    });
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 25000) });
    try { navigationStatus = resp ? resp.status() : null; } catch { navigationStatus = null; }
    log(`[relay] event=navigation.status stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} navigationStatus=${navigationStatus ?? 'none'} fetchExecuted=false`);
    // Bounded settle: allow normal page-load JS/player init, never Play click.
    const settleMs = Math.min(Math.max(timeoutMs - (Date.now() - start), 0), 8000);
    if (settleMs > 0) await new Promise((r) => setTimeout(r, Math.min(settleMs, 5000)));
    log(`[relay] event=media.observed stage=warmup handler=warmup traceId=${traceId} pageHost=${pageHost} pageFp=${pageFp} mediaObserved=${observed.length} browserMedia206=${browserMedia206} fetchExecuted=false`);
    const memAfter = process.memoryUsage().rss;
    log(`[relay] event=warmup.resources stage=warmup handler=warmup traceId=${traceId} rssBefore=${memBefore} rssAfter=${memAfter} durationMs=${Date.now() - start} fetchExecuted=false`);
    await page.close().catch(() => {});
    return { ok: true, navigationStatus, mediaObserved: observed.length, browserMedia206 };
  } catch (e) {
    const msg = String((e && e.message) || '').toLowerCase();
    const category = msg.includes('timeout') || msg.includes('timed out') ? 'TIMEOUT' : msg.includes('net::') || msg.includes('navigation') ? 'NAVIGATION_FAILED' : 'BROWSER_LAUNCH_FAILED';
    return { ok: false, errorCategory: category, navigationStatus, mediaObserved: observed.length };
  } finally {
    try { await browser?.close(); } catch {}
    try {
      // Reap any lingering Chromium child (best-effort, no orphan processes).
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => {
        try {
          const proc = execFile('pkill', ['-f', 'chrome.*--incognito'], () => resolve(null));
          setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 2000);
        } catch { resolve(null); }
      }).catch(() => {});
    } catch {}
  }
}

// ── Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://local');
  const path = u.pathname;
  if (req.method === 'GET' && path === '/healthz') return handleHealthz(req, res);
  if (req.method === 'GET' && path === '/system-health') return handleSystemHealth(req, res);
  if (req.method === 'GET' && path === '/health') return handleHealth(req, res, '/health');
  if (req.method === 'POST' && path === '/warmup') {
    handleWarmup(req, res).catch(() => {
      try {
        sendJson(res, 500, { error: 'internal' });
      } catch {}
    });
    return;
  }
  if (req.method === 'POST' && path === '/fetch') {
    handleFetch(req, res, '/fetch').catch((e) => {
      try {
        log(`[relay] event=stream_error stage=response handler=fetch traceId=none relayHttpStatus=500 upstreamStatus=none fetchExecuted=false error=internal`);
        sendJson(res, 500, { error: 'internal' });
      } catch {}
    });
    return;
  }
  log(`[relay] event=request_received stage=routing handler=not-found traceId=none relayHttpStatus=404 upstreamStatus=none fetchExecuted=false method=${req.method} pathLen=${path.length}`);
  return sendJson(res, 404, { error: 'not found' });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => {
  // Boolean-only secret presence (never the value): lets operators diagnose a
  // missing RELAY_SECRET from container logs while /system-health reports 503.
  // Relay operations stay fail-closed without a secret (HMAC cannot verify).
  console.log(`[relay] listening on 0.0.0.0:${PORT} maxConcurrent=${MAX_CONCURRENT_TRANSFERS} maxRedirects=${MAX_REDIRECTS} relaySecret=${RELAY_SECRET ? 'configured' : 'missing'}`);
});

function shutdown() {
  console.log('[relay] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
