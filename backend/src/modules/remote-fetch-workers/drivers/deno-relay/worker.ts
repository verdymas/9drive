/**
 * 9Drive relay for Deno Deploy — manual-endpoint driver template.
 *
 * Same `9drive-relay-v1` (+ `v2-cookie`) contract as the Cloudflare relay
 * (`drivers/cloudflare-relay/worker.mjs`): HMAC-verified `GET /health` and
 * `POST /fetch`, strict upstream-header allowlist, SSRF-shape validation,
 * streaming passthrough (`response: "stream"`) with `x-9drive-*` metadata, and
 * safe `traceId`/`urlFp` diagnostics (never query values, header values,
 * bodies, or secrets).
 *
 * Deploy: create a new Deno Deploy app from this single file, set the
 * `RELAY_SECRET` environment variable to the 9Drive-generated secret, deploy,
 * then register the app URL in 9Drive Workers (Service: Deno Relay).
 *
 * Plain Web-standard code only — no npm imports — so it runs unmodified on
 * Deno Deploy (current platform, not Classic).
 */

const SERVICE_IDENTITY = "9drive-relay";
const PROTOCOL_VERSION = "9drive-relay-v1";
const COOKIE_PROTOCOL_VERSION = "9drive-relay-v2-cookie";
const SIGNATURE_HEADER = "x-9drive-signature";
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const BLOCKED_SCHEMES = new Set(["javascript:", "file:", "ftp:", "data:"]);
const ALLOWED_UPSTREAM_HEADERS = new Set([
  "referer",
  "origin",
  "user-agent",
  "cookie",
  "accept",
  "accept-encoding",
  "accept-language",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-storage-access",
  "range",
]);

function signaturesMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function relaySecret(): string {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (Deno as any)?.env?.get?.("RELAY_SECRET") ?? "";
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

async function verifyHmac(request: Request): Promise<boolean> {
  const secret = relaySecret();
  if (!secret) return false;
  const url = new URL(request.url);
  const canonical = `${request.method} ${url.pathname}`;
  const expected = await hmacHex(secret, canonical);
  return signaturesMatch(request.headers.get(SIGNATURE_HEADER), expected);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function urlFpForLog(rawUrl: string): Promise<string> {
  try {
    const canonical = new URL(rawUrl).href;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  } catch {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(rawUrl)));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
    } catch {
      return "unknown";
    }
  }
}

function urlShapeForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const keys = [...u.searchParams.keys()].sort().join("+") || "none";
    const count = [...u.searchParams.keys()].length;
    return `pathLen=${u.pathname.length} queryCount=${count} queryKeys=${keys} hasFragment=${Boolean(u.hash)} urlLen=${String(rawUrl).length}`;
  } catch {
    return `pathLen=unknown queryCount=unknown queryKeys=unknown hasFragment=unknown urlLen=${String(rawUrl).length}`;
  }
}

function handleHealth(): Response {
  return json({
    service: SERVICE_IDENTITY,
    protocolVersion: PROTOCOL_VERSION,
    status: "ok",
    capabilities: {
      streaming: true,
      rangeRequests: true,
      requestContext: true,
      hls: false,
      maxBodyBytes: null,
    },
  });
}

async function handleFetch(request: Request): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    try { console.log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=none reason=INVALID_JSON relayHttpStatus=400 upstreamStatus=none fetchExecuted=false`); } catch { /* noop */ }
    return json({ error: "invalid payload", reason: "INVALID_JSON" }, 400);
  }
  const { method, url, headers, body, protocolVersion, response: responseMode, traceId: rawTraceId } = payload ?? {};
  const STREAMING = responseMode === "stream";
  const traceId = typeof rawTraceId === "string" && rawTraceId.length >= 1 && rawTraceId.length <= 128 ? rawTraceId : "none";
  async function reject(reason: string): Promise<Response> {
    try { console.log(`[relay] event=validation_rejected stage=validation handler=fetch traceId=${traceId} reason=${reason} relayHttpStatus=400 upstreamStatus=none fetchExecuted=false protocolVersion=${typeof protocolVersion === "string" ? protocolVersion : "none"}`); } catch { /* noop */ }
    return json({ error: "invalid payload", reason }, 400);
  }
  if (protocolVersion === undefined || protocolVersion === null) return reject("MISSING_PROTOCOL");
  if (protocolVersion !== PROTOCOL_VERSION && protocolVersion !== COOKIE_PROTOCOL_VERSION) return reject("INVALID_PROTOCOL");
  if (method === undefined || method === null) return reject("MISSING_METHOD");
  if (typeof method !== "string") return reject("INVALID_METHOD");
  if (!ALLOWED_METHODS.has(method)) return reject("UNSUPPORTED_METHOD");
  if (url === undefined || url === null) return reject("MISSING_URL");
  if (typeof url !== "string") return reject("INVALID_URL");
  if (headers !== undefined && headers !== null && (typeof headers !== "object" || Array.isArray(headers))) return reject("INVALID_HEADERS");
  const hasCookie = headers && typeof headers === "object" &&
    Object.keys(headers as Record<string, unknown>).some((k) => k.toLowerCase() === "cookie");
  if (hasCookie && protocolVersion !== COOKIE_PROTOCOL_VERSION) return reject("INVALID_PROTOCOL");
  if (body !== undefined && typeof body !== "string") return reject("INVALID_BODY_TYPE");

  let targetHostForLog = "";
  let hasRange = false;
  let upstreamHeaderNamesForLog = "";
  try {
    targetHostForLog = new URL(url as string).hostname;
    const payloadKeys = Object.keys(payload ?? {}).sort().join(",");
    hasRange = headers && typeof headers === "object"
      ? Object.keys(headers as Record<string, unknown>).some((k) => String(k).toLowerCase() === "range")
      : false;
    const shape = urlShapeForLog(url as string);
    const urlFp = await urlFpForLog(url as string);
    console.log(`[relay] event=request_received stage=validation handler=fetch traceId=${traceId} protocol=${protocolVersion} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} payloadKeys=${payloadKeys} hasRange=${hasRange} hasCookie=${Boolean(hasCookie)} fetchExecuted=false ${shape}`);
  } catch { /* noop */ }
  let target: URL;
  try {
    target = new URL(url as string);
  } catch {
    return reject("INVALID_URL");
  }
  if (BLOCKED_SCHEMES.has(target.protocol) || (target.protocol !== "http:" && target.protocol !== "https:")) {
    return reject("INVALID_URL");
  }
  const outHeaders = new Headers();
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      if (key.includes("\r") || key.includes("\n") || value.includes("\r") || value.includes("\n")) continue;
      if (!ALLOWED_UPSTREAM_HEADERS.has(String(key).toLowerCase())) continue;
      outHeaders.set(key, value);
    }
  }
  try {
    upstreamHeaderNamesForLog = [...outHeaders.keys()].map((k) => String(k).toLowerCase()).sort().join(",");
  } catch { /* noop */ }
  try {
    const urlFp = await urlFpForLog(target.href);
    const shape = urlShapeForLog(url as string);
    console.log(`[relay] event=validation_accepted stage=pre-fetch handler=fetch traceId=${traceId} protocol=${protocolVersion} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} upstreamHeaderNames=${upstreamHeaderNamesForLog || "none"} hasRange=${hasRange} fetchExecuted=false ${shape}`);
    console.log(`[relay] event=upstream_fetch_start stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} upstreamHeaderNames=${upstreamHeaderNamesForLog || "none"} hasRange=${hasRange} fetchExecuted=false ${shape}`);
  } catch { /* noop */ }
  try {
    const upstream = await fetch(target.href, {
      method: method as string,
      headers: outHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : (body as string | undefined),
      redirect: protocolVersion === COOKIE_PROTOCOL_VERSION ? "manual" : "follow",
    });
    try {
      const finalHost = (() => { try { return new URL(upstream.url).hostname; } catch { return ""; } })();
      const redirected = Boolean(upstream.url) && upstream.url !== target.href;
      const shape = urlShapeForLog(url as string);
      const urlFp = await urlFpForLog(target.href);
      const finalUrlFp = upstream.url ? await urlFpForLog(upstream.url) : urlFp;
      console.log(`[relay] event=upstream_response stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} finalHost=${finalHost || "unknown"} finalUrlFp=${finalUrlFp} sameHost=${finalHost === targetHostForLog} redirected=${redirected} upstreamStatus=${upstream.status} relayHttpStatus=200 fetchExecuted=true responseMode=${STREAMING ? "stream" : "envelope"} upstreamHeaderNames=${upstreamHeaderNamesForLog} hasRange=${hasRange} hasCookie=${Boolean(hasCookie)} ${shape}`);
    } catch { /* noop */ }
    if (STREAMING) {
      const passthrough = new Headers();
      upstream.headers.forEach((value, key) => {
        const k = key.toLowerCase();
        if (k === "transfer-encoding" || k === "content-length" || k === "connection") return;
        passthrough.set(key, value);
      });
      passthrough.set("x-9drive-streaming", "1");
      passthrough.set("x-9drive-upstream-status", String(upstream.status));
      if (upstream.url) passthrough.set("x-9drive-final-url", encodeURI(upstream.url));
      return new Response(upstream.body, { status: 200, headers: passthrough });
    }
    const responseBody = new Uint8Array(await upstream.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => { responseHeaders[key] = value; });
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < responseBody.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, responseBody.subarray(i, i + chunkSize) as unknown as number[]);
    }
    return json({ status: upstream.status, statusText: upstream.statusText, headers: responseHeaders, body: btoa(binary), finalUrl: upstream.url, protocolVersion }, 200);
  } catch (error) {
    let errorName = "Unknown";
    try {
      if (error && typeof error === "object" && (error as { name?: unknown }).name) errorName = String((error as { name: unknown }).name);
    } catch { /* noop */ }
    try {
      const urlFp = await urlFpForLog(target.href);
      console.log(`[relay] event=upstream_fetch_failed stage=upstream handler=fetch traceId=${traceId} upstreamMethod=${method} targetHost=${targetHostForLog} urlFp=${urlFp} hasRange=${hasRange} fetchExecuted=true upstreamStatus=none relayHttpStatus=502 errorName=${errorName}`);
    } catch { /* noop */ }
    return json({ error: "upstream fetch failed", code: "UPSTREAM_FETCH_EXCEPTION", reason: errorName }, 502);
  }
}

async function handler(request: Request): Promise<Response> {
  if (!(await verifyHmac(request))) {
    try { console.log(`[relay] event=request_received stage=auth handler=unknown traceId=none relayHttpStatus=401 upstreamStatus=none fetchExecuted=false method=${request.method}`); } catch { /* noop */ }
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    try { console.log(`[relay] event=request_received stage=health handler=health traceId=none relayHttpStatus=200 upstreamStatus=none fetchExecuted=false`); } catch { /* noop */ }
    return handleHealth();
  }
  if (request.method === "POST" && url.pathname === "/fetch") {
    try { console.log(`[relay] event=request_received stage=routing handler=fetch method=POST path=/fetch`); } catch { /* noop */ }
    return handleFetch(request);
  }
  try { console.log(`[relay] event=request_received stage=routing handler=not-found traceId=none relayHttpStatus=404 upstreamStatus=none fetchExecuted=false method=${request.method} pathLen=${url.pathname.length}`); } catch { /* noop */ }
  return json({ error: "not found" }, 404);
}

export default { fetch: handler };

// Deno Deploy entrypoint (current platform): serve this handler directly.
// Kept alongside the default export so `deno run` and Deploy both work.
try {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any)?.Deno;
  if (D?.serve && D?.env?.get?.("DENO_DEPLOYMENT_ID") !== undefined) {
    D.serve(handler);
  }
} catch { /* non-Deno runtimes ignore */ }
