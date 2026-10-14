#!/usr/bin/env node
/**
 * 9Drive HTTP-only media probe — VPS relay root-cause diagnosis harness.
 *
 * Dependency-free Node.js 20 tool. No npm packages, no browser runtime,
 * no eval/vm, no dynamic code execution. Read-only: only bounded GETs.
 *
 * Usage (Alpine / non-root container safe — needs only `node`):
 *   PAGE_URL='https://page.example/...' MEDIA_URL='https://cdn.example/...' \
 *   REFERER_URL='https://page.example/...' node media-probe.mjs
 *
 * Env:
 *   PAGE_URL            https page URL that hosts the video (optional but
 *                       recommended for Experiment D warmup comparison).
 *   MEDIA_URL           https media URL under test (.vid / .mp4, required).
 *   REFERER_URL         true source-page URL used as Referer (optional).
 *   DIAG_TIMEOUT_MS     per-request timeout, default 15000 (max 30000).
 *   DIAG_MAX_REDIRECTS  manual-redirect hops followed, default 4 (max 5).
 *   DIAG_PROBE_BYTES    Range end + body read cap, default 1024 (max 4096).
 *   DIAG_MAX_REQUESTS   total-request budget, default 10 (max 20).
 *   DIAG_ALLOW_HTTP     set to 1 ONLY for local mocked tests (http://127.0.0.1).
 *   DIAG_ALLOW_PRIVATE  set to 1 ONLY for local mocked tests (loopback).
 *
 * Safety:
 *   - https-only unless DIAG_ALLOW_HTTP=1 (mocked offline tests).
 *   - Literal-IP / hostname blocklist mirror of the VPS relay (loopback,
 *     private, link-local, multicast, .internal/.local, metadata host).
 *     DNS-rebinding enforcement stays with the relay edge; this harness
 *     gates literals synchronously and reports DNS/TLS failures as evidence.
 *   - Never sends Cookie, Authorization, HMAC secrets, or relay credentials
 *     upstream. The only stateful header ever sent is an optional Referer
 *     supplied by the operator, stripped on cross-host redirects.
 *   - Bounded Range reads (bytes=0-N); response bodies are cancelled after
 *     the probe window. Full videos are never fetched.
 *   - JSON report contains hosts, truncated URL fingerprints (sha256/12),
 *     header NAMES only, and magic-number classifications — never query
 *     values, path tokens, cookie values, or response bodies.
 */

import crypto from 'node:crypto';

// ── Tunables (bounded by spec) ─────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REDIRECTS = 4;
const HARD_MAX_REDIRECTS = 5;
const DEFAULT_PROBE_BYTES = 1024;
const HARD_MAX_PROBE_BYTES = 4096;
const DEFAULT_MAX_REQUESTS = 10;
const HARD_MAX_REQUESTS = 20;
const TOOL_VERSION = 1;

const BLOCKED_SCHEMES = new Set(['javascript:', 'file:', 'ftp:', 'data:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ── URL identity / redaction helpers ───────────────────────────────────────

/** Stable truncated hash of the full canonical URL (same construction as relay-protocol.ts). */
export function urlFingerprint(rawUrl) {
  try {
    const canonical = new URL(rawUrl).href;
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('sha256').update(String(rawUrl), 'utf8').digest('hex').slice(0, 12);
  }
}

export function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function extensionOf(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot < 0) return 'none';
    return (last.slice(dot + 1).toLowerCase() || 'none').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

/** Safe URL shape: path length + query PARAM NAMES only — never values. */
export function shapeOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const keys = [...u.searchParams.keys()].sort().join('+') || 'none';
    return {
      pathLen: u.pathname.length,
      queryKeys: keys,
      queryCount: [...u.searchParams.keys()].length,
      hasFragment: Boolean(u.hash),
      urlLen: String(rawUrl).length,
    };
  } catch {
    return { pathLen: -1, queryKeys: 'unknown', queryCount: -1, hasFragment: false, urlLen: String(rawUrl).length };
  }
}

export function redactedInput(rawUrl) {
  return {
    fp: urlFingerprint(rawUrl),
    host: hostOf(rawUrl),
    ext: extensionOf(rawUrl),
    ...shapeOf(rawUrl),
  };
}

// ── SSRF gate (literal-only; DNS enforcement stays at the relay edge) ─────

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function ipv4InCidr(ip, base, prefix) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : ~((2 ** (32 - prefix)) - 1) >>> 0;
  return (a & mask) === (b & mask);
}

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isBlockedIpLiteral(ip) {
  const v = String(ip).toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return IPV4_BLOCKS.some(([b, p]) => ipv4InCidr(mapped[1], b, p));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return IPV4_BLOCKS.some(([b, p]) => ipv4InCidr(v, b, p));
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  const first = v.split(':')[0] ?? '';
  const n = parseInt(first, 16);
  if (!Number.isNaN(n)) {
    if ((n & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((n & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  }
  return false;
}

/**
 * Synchronous pre-flight gate. Returns null when allowed, else a reason code.
 * Covers scheme, credentials, blocked schemes, literal-IP blocklist and
 * obviously-internal hostnames. DNS resolution failures surface later as
 * fetch exceptions (reported, not thrown).
 */
export function gateUrl(rawUrl, { allowHttp = false, allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'INVALID_URL';
  }
  if (BLOCKED_SCHEMES.has(u.protocol) || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    return 'BLOCKED_SCHEME';
  }
  if (u.protocol === 'http:' && !allowHttp) return 'HTTP_NOT_ALLOWED';
  if (u.username || u.password) return 'CREDENTIALS_IN_URL';
  if (/[\r\n]/.test(rawUrl)) return 'CONTROL_CHARS';
  if (!allowPrivate) {
    if (isBlockedIpLiteral(u.hostname)) return 'SSRF_BLOCKED_ADDRESS';
    const lower = u.hostname.toLowerCase();
    if (lower === 'localhost' || lower === 'metadata.google.internal' || lower.endsWith('.internal') || lower.endsWith('.local')) {
      return 'SSRF_BLOCKED_HOSTNAME';
    }
  }
  return null;
}

// ── Media validation (HTML 206 trap vs genuine media 206) ─────────────────

/**
 * Classify the bounded body prefix. `.vid` extension alone is NEVER proof.
 * Returns { verdict: 'media'|'html'|'unknown', magic, reasons[] }.
 */
export function validateMediaBytes({ bytes, contentType, contentRange, finalExt }) {
  const reasons = [];
  const ct = String(contentType ?? '').toLowerCase();
  const buf = bytes ?? Buffer.alloc(0);

  const isHtmlCt = ct.includes('text/html') || ct.includes('application/xhtml');
  if (isHtmlCt) reasons.push('content-type-is-html');

  // Magic-number sniffing on the bounded prefix (no full-body read).
  let magic = 'unknown';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') magic = 'mp4-ftyp';
  else if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) magic = 'webm-ebml';
  else if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') magic = 'mp3-id3';
  else if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') magic = 'ogg';
  else if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'FLV') magic = 'flv';
  else if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '\x00\x00\x00\x18') magic = 'mp4-size-hint';

  const head = buf.subarray(0, Math.min(buf.length, 256)).toString('latin1').trimStart().slice(0, 120).toLowerCase();
  const looksHtml = head.startsWith('<') && (
    head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body')
  );
  if (looksHtml) {
    magic = 'html-markup';
    reasons.push('body-opens-with-html-markup');
  }

  const isMediaCt = /^(video|audio)\//.test(ct) || ct.includes('mp2t') || ct.includes('mpegurl') === false && ct.includes('octet-stream');
  if (/^(video|audio)\//.test(ct)) reasons.push('content-type-is-media');
  if (magic === 'mp4-ftyp' || magic === 'webm-ebml') reasons.push(`magic-${magic}`);

  // Content-Range plausibility: "bytes 0-1023/30862" with HTML type is the
  // known trap (ranged HTML page, not video — see investigation evidence).
  let range = null;
  if (contentRange) {
    const m = String(contentRange).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (m) {
      range = { first: Number(m[1]), last: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
      reasons.push(`content-range=${m[1]}-${m[2]}/${m[3]}`);
    } else {
      reasons.push('content-range-unparseable');
    }
  }

  // Verdict: HTML wins over everything (prevents the HTML-206 trap).
  if (isHtmlCt || magic === 'html-markup') {
    return { verdict: 'html', magic, reasons, range };
  }
  if (isMediaCt || magic === 'mp4-ftyp' || magic === 'webm-ebml' || magic === 'mp3-id3' || magic === 'ogg' || magic === 'flv') {
    // Downgrade to unknown when the extension is opaque (.vid) with no magic
    // and only a generic octet-stream — honest uncertainty, not a claim.
    if (finalExt === 'vid' && magic === 'unknown' && !/^(video|audio)\//.test(ct)) {
      reasons.push('opaque-vid-extension-without-magic');
      return { verdict: 'unknown', magic, reasons, range };
    }
    return { verdict: 'media', magic, reasons, range };
  }
  if (buf.length === 0) {
    reasons.push('empty-prefix');
    return { verdict: 'unknown', magic, reasons, range };
  }
  reasons.push('no-media-signal');
  return { verdict: 'unknown', magic, reasons, range };
}

// ── Bounded fetch with manual redirect tracing ─────────────────────────────

function headerNamesOnly(headers) {
  const names = [];
  try {
    headers.forEach((_v, k) => names.push(String(k).toLowerCase()));
  } catch { /* non-Headers */ }
  return [...new Set(names)].sort();
}

function getHeader(headers, name) {
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

/** Read at most `limit` bytes, then cancel the reader. Always settles. */
async function readBounded(body, limit) {
  if (!body) return { bytes: Buffer.alloc(0), truncated: true };
  let reader;
  try {
    reader = body.getReader();
  } catch {
    return { bytes: Buffer.alloc(0), truncated: true, readerError: true };
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = limit - size;
        if (remaining <= 0) break;
        const slice = value.subarray ? value.subarray(0, remaining) : value.slice(0, remaining);
        chunks.push(Buffer.from(slice));
        size += slice.byteLength ?? slice.length;
      }
      if (size >= limit) break;
    }
  } catch (e) {
    return { bytes: Buffer.concat(chunks), truncated: true, readError: e?.name ?? 'ReadError' };
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  return { bytes: Buffer.concat(chunks), truncated: size >= limit };
}

/**
 * One bounded GET with manual redirect following. Reports every hop.
 * Never forwards Cookie/Authorization/HMAC; the optional Referer is
 * stripped on cross-host redirects (origin boundary).
 */
export async function probeUrl(target, {
  referer = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  probeBytes = DEFAULT_PROBE_BYTES,
  allowHttp = false,
  allowPrivate = false,
  countRequest,
} = {}) {
  const hops = [];
  let current = target;
  let lastReferer = referer;
  const initialHost = hostOf(target);
  let requestCount = 0;

  for (let i = 0; i <= maxRedirects; i += 1) {
    const gateReason = gateUrl(current, { allowHttp, allowPrivate });
    if (gateReason) {
      return {
        hops,
        final: null,
        error: { stage: 'ssrf-gate', reason: gateReason, hop: i },
        requestCount,
      };
    }
    if (countRequest) countRequest();
    requestCount += 1;

    const headers = {
      'User-Agent': '9Drive-Diag/1.0',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Range: `bytes=0-${probeBytes - 1}`,
    };
    if (lastReferer) headers.Referer = lastReferer;

    const hopStarted = Date.now();
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e?.name ?? 'FetchError';
      const cause = e?.cause ? ` cause=${e.cause?.code ?? e.cause?.message ?? ''}`.slice(0, 80) : '';
      return {
        hops,
        final: null,
        error: { stage: 'fetch-exception', reason: `${name}${cause}`.slice(0, 120), hop: i, targetFp: urlFingerprint(current), targetHost: hostOf(current) },
        requestCount,
      };
    }

    const hopMs = Date.now() - hopStarted;
    const status = res.status;
    const names = headerNamesOnly(res.headers);
    const contentType = getHeader(res.headers, 'content-type');
    const contentRange = getHeader(res.headers, 'content-range');
    const contentLength = getHeader(res.headers, 'content-length');
    const location = getHeader(res.headers, 'location');

    if (REDIRECT_STATUSES.has(status)) {
      if (!location) {
        try { await res.arrayBuffer().catch(() => null); } catch { /* drain best-effort */ }
        hops.push({
          index: i, status, sourceHost: hostOf(current), destHost: null,
          locationHost: null, contentType, contentLength, contentRange,
          headerNames: names, hopMs, note: 'redirect-without-location',
        });
        return { hops, final: null, error: { stage: 'redirect-without-location', reason: `status-${status}-without-location`, hop: i }, requestCount };
      }
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
        hops.push({
          index: i, status, sourceHost: hostOf(current), destHost: null,
          locationHost: 'unparseable', contentType, contentLength, contentRange,
          headerNames: names, hopMs, note: 'invalid-location',
        });
        return { hops, final: null, error: { stage: 'invalid-location', reason: 'LOCATION_UNPARSEABLE', hop: i }, requestCount };
      }
      try { await res.arrayBuffer().catch(() => null); } catch { /* drain best-effort */ }
      hops.push({
        index: i, status, sourceHost: hostOf(current), destHost: hostOf(next),
        locationHost: hostOf(next), contentType, contentLength, contentRange,
        headerNames: names, hopMs, note: 'redirect',
      });
      // Origin boundary: strip Referer when leaving the initial host.
      if (lastReferer && hostOf(next) !== initialHost) lastReferer = null;
      current = next;
      continue;
    }

    // Terminal response: bounded body read, then classify.
    const { bytes, readError } = await readBounded(res.body, probeBytes);
    const validation = validateMediaBytes({ bytes, contentType, contentRange, finalExt: extensionOf(current) });
    // First-byte signature: magic label + hex of the first 16 bytes max
    // (magic-number diagnosis only — never the body).
    const firstBytesHex = bytes.subarray(0, Math.min(16, bytes.length)).toString('hex') || null;
    hops.push({
      index: i, status, sourceHost: hostOf(current), destHost: null,
      locationHost: null, contentType, contentLength, contentRange,
      headerNames: names, hopMs, note: 'terminal',
    });
    return {
      hops,
      final: {
        status,
        finalHost: hostOf(current),
        finalExt: extensionOf(current),
        finalFp: urlFingerprint(current),
        contentType,
        contentRange,
        contentLength,
        headerNames: names,
        mediaValidation: { ...validation, firstBytesHex },
        bytesRead: bytes.length,
        readError: readError ?? null,
        redirectCount: i,
        rangeIgnored: status === 200 && bytes.length >= probeBytes,
      },
      error: null,
      requestCount,
    };
  }

  return { hops, final: null, error: { stage: 'too-many-redirects', reason: 'TOO_MANY_REDIRECTS', hop: maxRedirects }, requestCount };
}

// ── Orchestration: one variable at a time ──────────────────────────────────

function clampInt(v, fallback, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function readConfig(env = process.env) {
  return {
    pageUrl: (env.PAGE_URL ?? '').trim() || null,
    mediaUrl: (env.MEDIA_URL ?? '').trim() || null,
    refererUrl: (env.REFERER_URL ?? '').trim() || null,
    timeoutMs: clampInt(env.DIAG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxRedirects: clampInt(env.DIAG_MAX_REDIRECTS, DEFAULT_MAX_REDIRECTS, HARD_MAX_REDIRECTS),
    probeBytes: clampInt(env.DIAG_PROBE_BYTES, DEFAULT_PROBE_BYTES, HARD_MAX_PROBE_BYTES),
    maxRequests: clampInt(env.DIAG_MAX_REQUESTS, DEFAULT_MAX_REQUESTS, HARD_MAX_REQUESTS),
    allowHttp: ['1', 'true', 'yes', 'on'].includes(String(env.DIAG_ALLOW_HTTP ?? '').toLowerCase()),
    allowPrivate: ['1', 'true', 'yes', 'on'].includes(String(env.DIAG_ALLOW_PRIVATE ?? '').toLowerCase()),
  };
}

export async function runDiagnosis(config) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let used = 0;
  const countRequest = () => { used += 1; };
  const budgetGuard = () => used >= config.maxRequests;

  const report = {
    tool: '9drive-http-only-media-probe',
    version: TOOL_VERSION,
    startedAt,
    finishedAt: null,
    durationMs: null,
    config: {
      timeoutMs: config.timeoutMs,
      maxRedirects: config.maxRedirects,
      probeBytes: config.probeBytes,
      maxRequests: config.maxRequests,
      allowHttp: config.allowHttp,
      allowPrivate: config.allowPrivate,
    },
    inputs: {
      page: config.pageUrl ? redactedInput(config.pageUrl) : null,
      media: config.mediaUrl ? redactedInput(config.mediaUrl) : null,
      refererHost: config.refererUrl ? hostOf(config.refererUrl) : null,
    },
    experiments: [],
    summary: { failureStage: 'not-run', mediaProved: false, note: '' },
    requestBudget: { used: 0, max: config.maxRequests },
  };

  if (!config.mediaUrl) {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedMs;
    report.summary = { failureStage: 'input', mediaProved: false, note: 'MEDIA_URL is empty. Set MEDIA_URL (and optionally PAGE_URL / REFERER_URL) and retry.' };
    return report;
  }

  const base = {
    timeoutMs: config.timeoutMs,
    maxRedirects: config.maxRedirects,
    probeBytes: config.probeBytes,
    allowHttp: config.allowHttp,
    allowPrivate: config.allowPrivate,
    countRequest,
  };

  // Experiment B/C-1: media probe WITHOUT Referer (explicit baseline).
  const t0 = Date.now();
  const bare = await probeUrl(config.mediaUrl, { ...base, referer: null });
  report.experiments.push({ name: 'media-no-referer', timingsMs: Date.now() - t0, ...bare });

  // Experiment C-2: media probe WITH the true source-page Referer (one variable).
  if (config.refererUrl && !budgetGuard()) {
    const t1 = Date.now();
    const withRef = await probeUrl(config.mediaUrl, { ...base, referer: config.refererUrl });
    report.experiments.push({ name: 'media-with-referer', timingsMs: Date.now() - t1, ...withRef });
  }

  // Experiment D: page warmup — bounded HTML fetch, Set-Cookie presence only.
  if (config.pageUrl && !budgetGuard()) {
    const t2 = Date.now();
    const page = await probeUrl(config.pageUrl, { ...base, referer: null });
    // Page bodies are HTML by design: never run media validation as success
    // criteria; surface cookie presence (names only) + content signals.
    report.experiments.push({ name: 'page-warmup', timingsMs: Date.now() - t2, ...page });
  }

  const totalUsed = report.experiments.reduce((n, e) => n + (e.requestCount ?? 0), 0);
  report.requestBudget.used = totalUsed;

  // Summary: HTML 206 is never media success (evidence trap #8).
  const finals = report.experiments.filter((e) => e.final).map((e) => ({ name: e.name, final: e.final }));
  const mediaHit = finals.find((f) => f.final.mediaValidation?.verdict === 'media' && (f.final.status === 206 || f.final.status === 200));
  const htmlTrap = finals.find((f) => f.final.mediaValidation?.verdict === 'html' && f.final.status === 206);
  if (mediaHit) {
    report.summary = {
      failureStage: 'ok',
      mediaProved: true,
      note: `${mediaHit.name}: status ${mediaHit.final.status} with ${mediaHit.final.mediaValidation.magic} — genuine media bytes in the bounded prefix.`,
    };
  } else if (htmlTrap) {
    report.summary = {
      failureStage: 'media-validation',
      mediaProved: false,
      note: `${htmlTrap.name}: status 206 with content-type ${htmlTrap.final.contentType ?? 'unknown'} is a ranged HTML page, NOT video (known trap).`,
    };
  } else {
    const firstErr = report.experiments.map((e) => e.error).find(Boolean);
    const firstFinal = finals[0];
    if (firstErr) {
      report.summary = { failureStage: firstErr.stage, mediaProved: false, note: `${firstErr.reason ?? firstErr.stage} at hop ${firstErr.hop ?? 0}.` };
    } else if (firstFinal?.final.status === 404) {
      report.summary = { failureStage: 'final-media', mediaProved: false, note: 'Upstream answered 404 for the bounded media probe.' };
    } else if (firstFinal?.final.status === 416) {
      report.summary = { failureStage: 'final-media', mediaProved: false, note: 'Upstream answered 416 Range Not Satisfiable for bytes=0-N.' };
    } else if (firstFinal) {
      report.summary = { failureStage: 'media-validation', mediaProved: false, note: `Status ${firstFinal.final.status} with verdict ${firstFinal.final.mediaValidation?.verdict ?? 'unknown'} — no media signal in the bounded prefix.` };
    } else {
      report.summary = { failureStage: 'unknown', mediaProved: false, note: 'No terminal response recorded within the request budget.' };
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedMs;
  return report;
}

// ── CLI ────────────────────────────────────────────────────────────────────

/**
 * Settle-then-exit: give pending fetch/timeout handles a chance to close
 * before force-exit. Exiting immediately after a fetch trips a Windows
 * libuv assertion (`UV_HANDLE_CLOSING`); the report is already flushed by
 * then, so a short settle only affects the exit code, never the data.
 */
async function cleanExit(code) {
  await new Promise((r) => setTimeout(r, 100));
  process.exit(code);
}

async function main() {
  const config = readConfig(process.env);
  const report = await runDiagnosis(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // Exit 0 only when genuine media bytes were proved; 1 for classified
  // non-media outcomes; 2 for input/SSRF-gate failures.
  if (report.summary.mediaProved) await cleanExit(0);
  else if (report.summary.failureStage === 'input' || report.summary.failureStage === 'ssrf-gate') await cleanExit(2);
  else await cleanExit(1);
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('media-probe.mjs') || entry.endsWith('media-probe.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch(async (e) => {
    process.stdout.write(`${JSON.stringify({
      tool: '9drive-http-only-media-probe',
      version: TOOL_VERSION,
      finishedAt: new Date().toISOString(),
      summary: { failureStage: 'exception', mediaProved: false, note: String(e?.name ?? 'Exception').slice(0, 120) },
      experiments: [],
      requestBudget: { used: 0, max: DEFAULT_MAX_REQUESTS },
    }, null, 2)}\n`);
    await cleanExit(1);
  });
}
