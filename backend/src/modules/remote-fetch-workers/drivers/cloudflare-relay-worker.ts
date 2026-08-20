/**
 * The 9Drive relay Worker source, bundled as a plain JS string and deployed by
 * the Cloudflare driver via the Workers Scripts API (direct upload, no build
 * step, no imports). This is a NETWORK RELAY ONLY: it forwards bytes between
 * 9Drive and the remote source. No HLS parsing, no FFmpeg, no remux, no uploads.
 *
 * Protocol (9drive-relay-v1):
 * - GET /health  — HMAC-verified, returns service identity + capabilities.
 * - POST /fetch  — HMAC-verified, relays one outbound request and returns the
 *                  response (body base64-encoded, non-streaming for v1).
 * Every other path returns 404.
 *
 * The relay secret arrives as the `SECRET` binding (secret_text), set by the
 * driver at provisioning time. All HMAC signing happens in the 9Drive backend;
 * the worker only verifies.
 */

export const RELAY_WORKER_SOURCE = `
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

async function verifyHmac(request) {
  const secret = globalThis.env && globalThis.env.SECRET ? globalThis.env.SECRET : '';
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
      streaming: false,
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
    return json({ error: 'invalid payload' }, 400);
  }
  const { method, url, headers, body } = payload || {};
  if (!ALLOWED_METHODS.has(method) || typeof url !== 'string') {
    return json({ error: 'invalid request' }, 400);
  }
  let target;
  try {
    target = new URL(url);
  } catch {
    return json({ error: 'invalid url' }, 400);
  }
  if (BLOCKED_SCHEMES.has(target.protocol) || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return json({ error: 'invalid url' }, 400);
  }
  if (typeof body !== 'string' && body != null) return json({ error: 'invalid body' }, 400);

  const outHeaders = new Headers();
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      if (key.includes('\\r') || key.includes('\\n') || value.includes('\\r') || value.includes('\\n')) continue;
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
    const responseBody = new Uint8Array(await upstream.arrayBuffer());
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return json(
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
        body: btoa(String.fromCharCode.apply(null, responseBody)),
        protocolVersion: PROTOCOL_VERSION,
      },
      200
    );
  } catch {
    return json({ error: 'upstream fetch failed' }, 502);
  }
}

export default {
  async fetch(request) {
    if (!(await verifyHmac(request))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return handleHealth();
    if (request.method === 'POST' && url.pathname === '/fetch') return handleFetch();
    return json({ error: 'not found' }, 404);
  },
};
`.trim()
