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
const COOKIE_PROTOCOL_VERSION = '9drive-relay-v2-cookie';
const SIGNATURE_HEADER = 'x-9drive-signature';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'file:', 'ftp:', 'data:']);
// Explicit upstream-header allowlist (lowercase) — mirrors the backend
// request-context allowlist. Transport-controlled, hop-by-hop and credential
// headers are never forwarded to the source.
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

// Short cryptographic fingerprint of the canonical target URL for
// backend ↔ Worker correlation. Canonical form is `new URL(raw).href` —
// identical to the backend `urlFingerprintForLog` — so fingerprints match
// only when canonicalization is identical. The hash never exposes
// path/query values.
async function urlFpForLog(rawUrl) {
  try {
    const canonical = new URL(rawUrl).href;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(rawUrl)));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    } catch {
      return 'unknown';
    }
  }
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
    // No parseable payload — traceId unknown. Stage is validation; no
    // upstream fetch was attempted and no upstream status exists.
    try { console.log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=none reason=INVALID_JSON relayHttpStatus=400 upstreamStatus=none fetchExecuted=false`); } catch {}
    return json({ error: 'invalid payload', reason: 'INVALID_JSON' }, 400);
  }
  const { method, url, headers, body, protocolVersion, response: responseMode, traceId: rawTraceId } = payload || {};
  const STREAMING = responseMode === 'stream';
  // Opaque correlation id (diagnostics-only, never affects routing). Lenient:
  // an absent/invalid traceId never fails the relay — it is only echoed in logs.
  const traceId = typeof rawTraceId === 'string' && rawTraceId.length >= 1 && rawTraceId.length <= 128 ? rawTraceId : 'none';
  // Log + return a validation rejection. Safe: reason code only, never URL /
  // header values / body. relayHttpStatus is the Worker answer; upstream was
  // never contacted (fetchExecuted=false, upstreamStatus=none).
  async function reject(reason) {
    try { console.log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=${traceId} reason=${reason} relayHttpStatus=400 upstreamStatus=none fetchExecuted=false protocolVersion=${typeof protocolVersion === 'string' ? protocolVersion : 'none'}`); } catch {}
    return json({ error: 'invalid payload', reason }, 400);
  }
  // Safe destination shape — param NAMES only, never values (signed URLs stay secret).
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
  // Canonical 9drive-relay-v1 contract — keep in sync with backend/src/modules/remote-fetch-workers/relay-protocol.ts
  // Validation with safe reason codes — never echo URL, headers values, or body content.
  if (protocolVersion === undefined || protocolVersion === null) {
    return reject('MISSING_PROTOCOL');
  }
  if (protocolVersion !== PROTOCOL_VERSION && protocolVersion !== COOKIE_PROTOCOL_VERSION) {
    return reject('INVALID_PROTOCOL');
  }
  if (method === undefined || method === null) {
    return reject('MISSING_METHOD');
  }
  if (typeof method !== 'string') {
    return reject('INVALID_METHOD');
  }
  if (!ALLOWED_METHODS.has(method)) {
    return reject('UNSUPPORTED_METHOD');
  }
  if (url === undefined || url === null) {
    return reject('MISSING_URL');
  }
  if (typeof url !== 'string') {
    return reject('INVALID_URL');
  }
  if (headers !== undefined && headers !== null && (typeof headers !== 'object' || Array.isArray(headers))) {
    return reject('INVALID_HEADERS');
  }
  const hasCookie = headers && Object.keys(headers).some((key) => key.toLowerCase() === 'cookie');
  if (hasCookie && protocolVersion !== COOKIE_PROTOCOL_VERSION) {
    return reject('INVALID_PROTOCOL');
  }
  // Body is optional: when present must be string (not null, not number). HEAD/GET should omit it.
  if (body !== undefined && typeof body !== 'string') {
    return reject('INVALID_BODY_TYPE');
  }
  // Safe diagnostics — never log URL query, headers values, or body.
  // `urlFp` matches the backend fingerprint (sha256 of canonical href).
  let targetHostForLog = '';
  let hasRange = false;
  let upstreamHeaderNamesForLog = '';
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
    const shape = urlShapeForLog(url);
    const urlFp = await urlFpForLog(url);
    console.log(`[relay] event=request_received stage=validation handler=fetch traceId=${traceId} protocol=${protocolVersion} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} payloadKeys=${payloadKeys} contentType=${request.headers.get('content-type')} bodyPresent=${bodyPresent} bodyType=${bodyType} headersCount=${headersCount} headersType=${headersType} hasRange=${hasRange} hasCookie=${Boolean(hasCookie)} fetchExecuted=false ${shape}`);
  } catch {}
  let target;
  try {
    target = new URL(url);
  } catch {
    return reject('INVALID_URL');
  }
  if (BLOCKED_SCHEMES.has(target.protocol) || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return reject('INVALID_URL');
  }

  const outHeaders = new Headers();
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      if (key.includes('\r') || key.includes('\n') || value.includes('\r') || value.includes('\n')) continue;
      // Enforce the allowlist: arbitrary, transport-controlled, hop-by-hop
      // and Authorization headers are stripped, never forwarded.
      if (!ALLOWED_UPSTREAM_HEADERS.has(String(key).toLowerCase())) continue;
      outHeaders.set(key, value);
    }
  }
  // Actual upstream header NAMES after allowlist filtering (never values) —
  // what the Worker asked fetch() to forward. Note: the edge runtime may still
  // normalize forbidden headers (e.g. Sec-Fetch-Mode no-cors→cors) and adds its
  // own CF-Worker/CF-Connecting-IP headers on the wire — invisible here.
  try {
    upstreamHeaderNamesForLog = [...outHeaders.keys()].map((k) => String(k).toLowerCase()).sort().join(',');
  } catch {}
  // Immediately before upstream fetch(): validation accepted, fetch is about
  // to execute. fetchExecuted=false here; the post-fetch line flips it true.
  try {
    const urlFp = await urlFpForLog(target.href);
    const shape = urlShapeForLog(url);
    console.log(`[relay] event=validation_accepted stage=pre-fetch handler=fetch traceId=${traceId} protocol=${protocolVersion} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} upstreamHeaderNames=${upstreamHeaderNamesForLog || 'none'} hasRange=${hasRange} hasCookie=${Boolean(hasCookie)} fetchExecuted=false ${shape}`);
    console.log(`[relay] event=upstream_fetch_start stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} upstreamHeaderNames=${upstreamHeaderNamesForLog || 'none'} hasRange=${hasRange} fetchExecuted=false ${shape}`);
  } catch {}

  try {
    const upstream = await fetch(target.href, {
      method,
      headers: outHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: protocolVersion === COOKIE_PROTOCOL_VERSION ? 'manual' : 'follow',
    });

    // Success diagnostics distinguish the relay (always HTTP 200 here) from
    // the UPSTREAM answer. Never log query values, header values, or bodies —
    // only hosts, status, redirect shape, fingerprints, and header NAMES.
    // A 404 here is the SOURCE response (fetchExecuted=true), never a relay
    // endpoint/validation 404.
    try {
      const finalHost = (() => { try { return new URL(upstream.url).hostname; } catch { return ''; } })();
      const redirected = Boolean(upstream.url) && upstream.url !== target.href;
      const sameHost = finalHost === targetHostForLog;
      const shape = urlShapeForLog(url);
      const urlFp = await urlFpForLog(target.href);
      const finalUrlFp = upstream.url ? await urlFpForLog(upstream.url) : urlFp;
      console.log(`[relay] event=upstream_response stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} finalHost=${finalHost || 'unknown'} finalUrlFp=${finalUrlFp} sameHost=${sameHost} redirected=${redirected} upstreamStatus=${upstream.status} relayHttpStatus=200 fetchExecuted=true responseMode=${STREAMING ? 'stream' : 'envelope'} upstreamHeaderNames=${upstreamHeaderNamesForLog} hasRange=${hasRange} hasCookie=${Boolean(hasCookie)} ${shape}`);
    } catch {}
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
        protocolVersion,
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
      const urlFp = await urlFpForLog(target.href);
      // No upstream response exists — report stage + kind, never a fabricated
      // upstreamStatus. relayHttpStatus=502 is the Worker answer.
      console.log(`[relay] event=upstream_fetch_failed stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} hasRange=${hasRange} hasCookie=${Boolean(hasCookie)} upstreamHeaderNames=${upstreamHeaderNamesForLog} fetchExecuted=true upstreamStatus=none relayHttpStatus=502 errorName=${errorName}${causeCode ? ` cause=${causeCode}` : ''} kind=${kind}`);
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
      // Relay endpoint reached but auth failed — no payload parsing, so no
      // traceId/upstream status. Distinct from an upstream 401/404.
      try { console.log(`[relay] event=request_received stage=auth handler=unknown traceId=none relayHttpStatus=401 upstreamStatus=none fetchExecuted=false method=${request.method}`); } catch {}
      return json({ error: 'unauthorized' }, 401);
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      try { console.log(`[relay] event=request_received stage=health handler=health traceId=none relayHttpStatus=200 upstreamStatus=none fetchExecuted=false`); } catch {}
      return handleHealth();
    }
    if (request.method === 'POST' && url.pathname === '/fetch') {
      try { console.log(`[relay] event=request_received stage=routing handler=fetch method=POST path=/fetch`); } catch {}
      return handleFetch(request);
    }
    // Relay endpoint 404: the request never reached the fetch handler and no
    // upstream fetch executed. Backend maps relay !ok to WORKER_UNHEALTHY —
    // never to an upstream 404.
    try { console.log(`[relay] event=request_received stage=routing handler=not-found traceId=none relayHttpStatus=404 upstreamStatus=none fetchExecuted=false method=${request.method} pathLen=${url.pathname.length}`); } catch {}
    return json({ error: 'not found' }, 404);
  },
};
