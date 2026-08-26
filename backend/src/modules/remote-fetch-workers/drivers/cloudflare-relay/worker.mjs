/**
 * 9Drive relay Worker — deployed verbatim by the Cloudflare driver through the
 * Workers Scripts multipart API (ES module Worker, entry module worker.mjs).
 * This is a NETWORK RELAY ONLY: it forwards bytes between 9Drive and the
 * remote source. No HLS parsing, no FFmpeg, no remux, no uploads.
 *
 * Protocol (9drive-relay-v1):
 * - GET /health  — HMAC-verified, returns service identity + capabilities.
 * - POST /fetch  — HMAC-verified, relays one outbound request and returns the
 *                  response (body base64-encoded, non-streaming for v1).
 * Every other path returns 404.
 *
 * The relay secret arrives as the `RELAY_SECRET` binding (secret_text), set by
 * the driver at provisioning time. All HMAC signing happens in the 9Drive
 * backend; the worker only verifies.
 *
 * This file must stay plain ES module JavaScript — no imports, no TypeScript,
 * no Node APIs — so it can be uploaded as-is with no build step.
 */

const SERVICE_IDENTITY = '9drive-relay';
const PROTOCOL_VERSION = '9drive-relay-v1';
const SIGNATURE_HEADER = 'x-9drive-signature';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'file:', 'ftp:', 'data:']);

// Constant-time-ish comparison; not a signature of anything sensitive beyond
// the shared secret, but avoids early-exit timing hints.
function signaturesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyHmac(request, env) {
  const secret = env.RELAY_SECRET || '';
  if (!secret) return false;
  const url = new URL(request.url);
  const canonical = request.method + ' ' + url.pathname;
  const sig = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', sig, new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signaturesMatch(request.headers.get(SIGNATURE_HEADER), hex);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function handleHealth() {
  return json({
    service: SERVICE_IDENTITY,
    protocolVersion: PROTOCOL_VERSION,
    status: 'ok',
    capabilities: {
      streaming: true,
      rangeRequests: true,
      requestContext: true,
      hls: false,
      maxBodyBytes: null,
    },
  });
}

async function handleFetch(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid payload', reason: 'INVALID_JSON' }, 400);
  }
  const { method, url, headers, body, protocolVersion, response: responseMode } = payload || {};
  const STREAMING = responseMode === 'stream';
  // Canonical 9drive-relay-v1 contract — keep in sync with backend/src/modules/remote-fetch-workers/relay-protocol.ts
  // Validation with safe reason codes — never echo URL, headers values, or body content.
  if (protocolVersion === undefined || protocolVersion === null) {
    return json({ error: 'invalid payload', reason: 'MISSING_PROTOCOL' }, 400);
  }
  if (protocolVersion !== PROTOCOL_VERSION) {
    return json({ error: 'invalid payload', reason: 'INVALID_PROTOCOL' }, 400);
  }
  if (method === undefined || method === null) {
    return json({ error: 'invalid payload', reason: 'MISSING_METHOD' }, 400);
  }
  if (typeof method !== 'string') {
    return json({ error: 'invalid payload', reason: 'INVALID_METHOD' }, 400);
  }
  if (!ALLOWED_METHODS.has(method)) {
    return json({ error: 'invalid payload', reason: 'UNSUPPORTED_METHOD' }, 400);
  }
  if (url === undefined || url === null) {
    return json({ error: 'invalid payload', reason: 'MISSING_URL' }, 400);
  }
  if (typeof url !== 'string') {
    return json({ error: 'invalid payload', reason: 'INVALID_URL' }, 400);
  }
  if (headers !== undefined && headers !== null && (typeof headers !== 'object' || Array.isArray(headers))) {
    return json({ error: 'invalid payload', reason: 'INVALID_HEADERS' }, 400);
  }
  // Body is optional: when present must be string (not null, not number). HEAD/GET should omit it.
  if (body !== undefined && typeof body !== 'string') {
    return json({ error: 'invalid payload', reason: 'INVALID_BODY_TYPE' }, 400);
  }
  // Safe diagnostics — never log URL query, headers values, or body
  let targetHostForLog = '';
  let hasRange = false;
  try {
    targetHostForLog = new URL(url).hostname;
    const payloadKeys = payload ? Object.keys(payload).sort().join(',') : '';
    const bodyPresent = body !== undefined;
    const bodyType = typeof body;
    const headersCount = headers && typeof headers === 'object' ? Object.keys(headers).length : 0;
    const headersType = typeof headers;
    hasRange = headers && typeof headers === 'object'
      ? Object.keys(headers).some((k) => String(k).toLowerCase() === 'range')
      : false;
    console.log(`[relay] protocol=${PROTOCOL_VERSION} upstreamMethod=${method} targetHost=${targetHostForLog} payloadKeys=${payloadKeys} contentType=${request.headers.get('content-type')} bodyPresent=${bodyPresent} bodyType=${bodyType} headersCount=${headersCount} headersType=${headersType} hasRange=${hasRange}`);
  } catch {}
  let target;
  try {
    target = new URL(url);
  } catch {
    return json({ error: 'invalid payload', reason: 'INVALID_URL' }, 400);
  }
  if (BLOCKED_SCHEMES.has(target.protocol) || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return json({ error: 'invalid payload', reason: 'INVALID_URL' }, 400);
  }

  const outHeaders = new Headers();
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      if (key.includes('\r') || key.includes('\n') || value.includes('\r') || value.includes('\n')) continue;
      outHeaders.set(key, value);
    }
  }

  try {
    const upstream = await fetch(target.href, {
      method,
      headers: outHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'follow',
    });

    // Streaming mode (v1.1): pipe the upstream response through UNBUFFERED —
    // the Worker never holds the whole body in memory, so large files no
    // longer hit the runtime memory ceiling (RESOURCE_LIMIT). Metadata rides
    // in x-9drive-* headers; hop-by-hop headers are dropped.
    if (STREAMING) {
      const passthrough = new Headers();
      upstream.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        if (k === 'transfer-encoding' || k === 'content-length' || k === 'connection') return;
        passthrough.set(key, value);
      });
      passthrough.set('x-9drive-streaming', '1');
      passthrough.set('x-9drive-upstream-status', String(upstream.status));
      if (upstream.url) passthrough.set('x-9drive-final-url', encodeURI(upstream.url));
      return new Response(upstream.body, { status: 200, headers: passthrough });
    }

    const responseBody = new Uint8Array(await upstream.arrayBuffer());
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    // Chunked base64 to avoid call-stack / argument-length limits on large
    // bodies (String.fromCharCode.apply with a huge Uint8Array would throw).
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < responseBody.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, responseBody.subarray(i, i + chunkSize));
    }
    return json(
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
        body: btoa(binary),
        finalUrl: upstream.url,
        protocolVersion: PROTOCOL_VERSION,
      },
      200
    );
  } catch (error) {
    // The relay itself is healthy — the UPSTREAM fetch failed (DNS/TLS/
    // connect error, or the runtime blocked the destination). Log only safe
    // metadata — never the URL query, header values, or body. The error
    // message may name the failing HOST (already logged above); it never
    // carries query strings or credentials. A keyword-classified `kind`
    // gives the caller a stable diagnostic bucket without echoing raw text.
    let errorName = 'Unknown';
    let causeCode = '';
    let message = '';
    try {
      if (error && typeof error === 'object') {
        if (error.name) errorName = String(error.name);
        if (typeof error.message === 'string') message = error.message;
        const cause = error.cause;
        if (cause && typeof cause === 'object') {
          if (cause.code && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(String(cause.code))) causeCode = String(cause.code);
          else if (!causeCode && cause.name && /^[A-Za-z]+$/.test(String(cause.name))) causeCode = String(cause.name);
        }
      }
      const kind = classifyUpstreamError(message, causeCode);
      console.log(`[relay] event=upstream_fetch_failed upstreamMethod=${method} targetHost=${targetHostForLog} hasRange=${hasRange} errorName=${errorName}${causeCode ? ` cause=${causeCode}` : ''} kind=${kind} message=${JSON.stringify(message.slice(0, 200))}`);
      return json({ error: 'upstream fetch failed', code: 'UPSTREAM_FETCH_EXCEPTION', reason: errorName, kind, ...(causeCode ? { cause: causeCode } : {}) }, 502);
    } catch {}
    return json({ error: 'upstream fetch failed', code: 'UPSTREAM_FETCH_EXCEPTION', reason: errorName }, 502);
  }
}

// Keyword buckets for the runtime's fetch TypeError (which carries no cause
// code). Patterns match the fixed message set of the Workers runtime.
function classifyUpstreamError(message, causeCode) {
  const hay = `${message} ${causeCode}`.toLowerCase();
  if (/resolve|dns|nxdomain|no such host|getaddrinfo/.test(hay)) return 'DNS_FAILURE';
  if (/tls|ssl|cert/.test(hay)) return 'TLS_ERROR';
  if (/reset|refused|unreachable|abort|closed/.test(hay)) return 'CONNECT_FAILURE';
  if (/timeout|timed out/.test(hay)) return 'TIMEOUT';
  if (/memory|allocation|exceed/.test(hay)) return 'RESOURCE_LIMIT';
  return 'UNKNOWN';
}

export default {
  async fetch(request, env) {
    if (!(await verifyHmac(request, env))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return handleHealth();
    if (request.method === 'POST' && url.pathname === '/fetch') return handleFetch(request);
    return json({ error: 'not found' }, 404);
  },
};