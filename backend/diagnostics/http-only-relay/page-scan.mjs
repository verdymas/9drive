#!/usr/bin/env node
/**
 * 9Drive HTTP-only page scan — Experiment 1 diagnostic (standalone).
 *
 * Dependency-free Node.js 20 tool. No npm packages, no browser runtime,
 * no eval/vm, no JavaScript execution. Read-only: ONE bounded page GET
 * (plus manual redirect hops) and, optionally, bounded Range probes of
 * statically-observed non-thumbnail candidates.
 *
 * Diagnostic-only: safe to copy this single file to /tmp on the non-root
 * VPS container — it needs only `node`. Fully self-contained (no imports
 * from media-probe.mjs) so a lone copy keeps working.
 *
 * Usage:
 *   PAGE_URL='https://page.example/...' node page-scan.mjs [--probe N]
 *   node page-scan.mjs --page-file implementations/....md [--probe N]
 *
 * `--page-file` extracts the first `PAGE_URL=<value>` line so the sensitive
 * URL never appears in shell history. `--probe N` (default 0, max 3) probes
 * up to N statically-observed non-thumbnail .vid/.mp4 candidates with
 * `Range: bytes=0-1023`, one variable at a time, no retries.
 * `--probe-thumbs N` (default 0, max 2) probes up to N observed thumbnails
 * (reachability census only — a thumb 206 is never media proof).
 *
 * Output is a single redacted JSON report on stdout: hosts, truncated URL
 * fingerprints (sha256/12, same canonicalization as the relay protocol),
 * header/param NAMES only, counts, magic-number verdicts. Never full URLs,
 * query values, cookie values, or response bodies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const TOOL_VERSION = 1;
const PAGE_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 15000;
const PAGE_MAX_BYTES = 262144; // 256 KiB static window, then cancel
const PROBE_BYTES = 1024;
const PAGE_MAX_REDIRECTS = 3;
const PROBE_MAX_REDIRECTS = 4;
const HARD_MAX_PROBES = 3;

const BLOCKED_SCHEMES = new Set(['javascript:', 'file:', 'ftp:', 'data:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ── Redacted URL identity (same canonicalization as relay-protocol.ts) ────

function urlFingerprint(rawUrl) {
  try {
    const canonical = new URL(rawUrl).href;
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('sha256').update(String(rawUrl), 'utf8').digest('hex').slice(0, 12);
  }
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function extensionOf(rawUrl) {
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

function shapeOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const keys = [...u.searchParams.keys()].sort().join('+') || 'none';
    return { pathLen: u.pathname.length, queryKeys: keys, queryCount: [...u.searchParams.keys()].length, urlLen: String(rawUrl).length };
  } catch {
    return { pathLen: -1, queryKeys: 'unknown', queryCount: -1, urlLen: String(rawUrl).length };
  }
}

function redactUrl(rawUrl) {
  return { fp: urlFingerprint(rawUrl), host: hostOf(rawUrl), ext: extensionOf(rawUrl), ...shapeOf(rawUrl) };
}

// ── Literal SSRF gate (DNS enforcement stays at the relay edge) ───────────

function isBlockedIpLiteral(ip) {
  const v = String(ip).toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : v;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const parts = v4.split('.').map(Number);
    const n = ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
    const inCidr = (base, prefix) => {
      const b = base.split('.').map(Number);
      const m = prefix === 32 ? 0xffffffff : ~((2 ** (32 - prefix)) - 1) >>> 0;
      return (n & m) === (((((b[0] * 256 + b[1]) * 256 + b[2]) * 256 + b[3]) & m) >>> 0);
    };
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([b, p]) => inCidr(b, p));
  }
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  return false;
}

function gateUrl(rawUrl, { allowHttp = false, allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'INVALID_URL';
  }
  if (BLOCKED_SCHEMES.has(u.protocol) || (u.protocol !== 'https:' && u.protocol !== 'http:')) return 'BLOCKED_SCHEME';
  if (u.protocol === 'http:' && !allowHttp) return 'HTTP_NOT_ALLOWED';
  if (u.username || u.password) return 'CREDENTIALS_IN_URL';
  if (/[\r\n]/.test(rawUrl)) return 'CONTROL_CHARS';
  if (!allowPrivate) {
    if (isBlockedIpLiteral(u.hostname)) return 'SSRF_BLOCKED_ADDRESS';
    const lower = u.hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.internal') || lower.endsWith('.local')) return 'SSRF_BLOCKED_HOSTNAME';
  }
  return null;
}

// ── Bounded body read (always cancels the reader) ─────────────────────────

async function readBounded(body, limit) {
  if (!body) return { bytes: Buffer.alloc(0), truncated: true };
  let reader;
  try {
    reader = body.getReader();
  } catch {
    return { bytes: Buffer.alloc(0), truncated: true };
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
        const slice = value.subarray(0, remaining);
        chunks.push(Buffer.from(slice));
        size += slice.byteLength;
      }
      if (size >= limit) break;
    }
  } catch (e) {
    return { bytes: Buffer.concat(chunks), truncated: true, readError: e?.name ?? 'ReadError' };
  } finally {
    try { await reader.cancel(); } catch { /* closed */ }
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  return { bytes: Buffer.concat(chunks), truncated: size >= limit };
}

function headerNamesOnly(headers) {
  const names = [];
  try {
    headers.forEach((_v, k) => names.push(String(k).toLowerCase()));
  } catch { /* noop */ }
  return [...new Set(names)].sort();
}

// Static cookie-name extraction: names only, never values.
function setCookieNames(headers) {
  let raw = null;
  try {
    raw = headers.getSetCookie ? headers.getSetCookie() : headers.get('set-cookie');
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const names = [];
  for (const entry of list) {
    const first = String(entry).split(';')[0] ?? '';
    const eq = first.indexOf('=');
    const name = (eq > 0 ? first.slice(0, eq) : first).trim();
    if (name && !names.includes(name) && names.length < 20) names.push(name);
  }
  return names;
}

// ── Static HTML discovery (regex only — never executed) ───────────────────

const URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/g;
const PROTOCOL_REL_PATTERN = /["']\/\/([^\s"'<>\\]+)/g;
const RELATIVE_MEDIA_PATTERN = /["'](\/[^\s"'<>\\]*?\.(vid|mp4|m3u8|mpd|webm)(\?[^\s"'<>\\]*)?)["']/gi;
const SCRIPT_SRC_PATTERN = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
const SCRIPT_TAG_PATTERN = /<script(?![^>]*src)[^>]*>/gi;
// Generic player-config key census: key names + counts only, never values.
const PLAYER_KEY_PATTERN = /\b(file|source|video_url|videourl|stream_url|streamurl|manifest|playlist|hls|dash|mp4|playback_url)\b\s*[:=]/gi;

function classifyCandidate(href) {
  const lower = href.toLowerCase();
  const ext = extensionOf(href);
  if (lower.includes('vidthumb')) return 'thumb';
  if (ext === 'vid') return 'vid';
  if (ext === 'mp4' || ext === 'm3u8' || ext === 'mpd' || ext === 'webm') return 'media-other';
  if (lower.includes('.mp4')) return 'media-other';
  return 'other';
}

function staticDiscovery(html, baseUrl) {
  const seen = new Set();
  const groups = { vid: [], thumb: [], 'media-other': [], other: [] };
  const consider = (href) => {
    if (seen.has(href)) return;
    seen.add(href);
    if (seen.size > 2000) return; // census cap — never unbounded
    const kind = classifyCandidate(href);
    if (kind === 'other') return;
    // Per-candidate: fingerprint + shape only. Full href stays in memory for
    // optional probing and is never serialized.
    groups[kind].push({ redacted: redactUrl(href), _href: href });
  };
  for (const m of html.matchAll(URL_PATTERN)) {
    consider(m[0].replace(/[.,;!?)]+$/, ''));
  }
  // Protocol-relative (//host/path) and page-relative (/path) references use
  // the same census — generic URL shapes, not site-specific parsing.
  for (const m of html.matchAll(PROTOCOL_REL_PATTERN)) {
    consider(`https://${m[1].replace(/[.,;!?)]+$/, '')}`);
  }
  if (baseUrl) {
    for (const m of html.matchAll(RELATIVE_MEDIA_PATTERN)) {
      try {
        consider(new URL(m[1], baseUrl).href);
      } catch { /* unresolvable — skip */ }
    }
  }
  const scriptSrcHosts = {};
  let unresolvableScriptSrcs = 0;
  for (const m of html.matchAll(SCRIPT_SRC_PATTERN)) {
    try {
      const h = new URL(m[1], baseUrl ?? 'https://page.invalid').hostname.toLowerCase();
      if (h === 'page.invalid') unresolvableScriptSrcs += 1;
      else scriptSrcHosts[h] = (scriptSrcHosts[h] ?? 0) + 1;
    } catch {
      unresolvableScriptSrcs += 1;
    }
  }
  const inlineScripts = [...html.matchAll(SCRIPT_TAG_PATTERN)].length;
  const keyCensus = {};
  for (const m of html.matchAll(PLAYER_KEY_PATTERN)) {
    const k = m[1].toLowerCase();
    keyCensus[k] = (keyCensus[k] ?? 0) + 1;
  }
  return { groups, scriptSrcHosts, unresolvableScriptSrcs, inlineScripts, keyCensus, urlsScanned: seen.size };
}

// ── Media validation for optional candidate probes ────────────────────────

function validatePrefix(bytes, contentType) {
  const ct = String(contentType ?? '').toLowerCase();
  const buf = bytes ?? Buffer.alloc(0);
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return { verdict: 'html', magic: 'html-content-type' };
  let magic = 'unknown';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') magic = 'mp4-ftyp';
  else if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) magic = 'webm-ebml';
  const head = buf.subarray(0, Math.min(buf.length, 256)).toString('latin1').trimStart().slice(0, 120).toLowerCase();
  if (head.startsWith('<') && (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head'))) {
    return { verdict: 'html', magic: 'html-markup' };
  }
  if (/^(video|audio)\//.test(ct) || magic === 'mp4-ftyp' || magic === 'webm-ebml') return { verdict: 'media', magic };
  if (buf.length === 0) return { verdict: 'unknown', magic };
  return { verdict: 'unknown', magic };
}

async function probeCandidate(href, { timeoutMs, maxRedirects, allowHttp, allowPrivate }) {
  const hops = [];
  let current = href;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const blocked = gateUrl(current, { allowHttp, allowPrivate });
    if (blocked) return { hops, final: null, error: { stage: 'ssrf-gate', reason: blocked, hop: i } };
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        headers: { 'User-Agent': '9Drive-Diag/1.0', Accept: '*/*', 'Accept-Encoding': 'identity', Range: `bytes=0-${PROBE_BYTES - 1}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { hops, final: null, error: { stage: 'fetch-exception', reason: String(e?.name ?? 'FetchError').slice(0, 80), hop: i } };
    }
    const status = res.status;
    const names = headerNamesOnly(res.headers);
    const contentType = res.headers.get('content-type');
    const contentRange = res.headers.get('content-range');
    const contentLength = res.headers.get('content-length');
    const location = res.headers.get('location');
    if (REDIRECT_STATUSES.has(status)) {
      if (!location) {
        try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
        hops.push({ index: i, status, sourceHost: hostOf(current), destHost: null, note: 'redirect-without-location', headerNames: names });
        return { hops, final: null, error: { stage: 'redirect-without-location', hop: i } };
      }
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
        return { hops, final: null, error: { stage: 'invalid-location', hop: i } };
      }
      try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
      hops.push({ index: i, status, sourceHost: hostOf(current), destHost: hostOf(next), note: 'redirect', headerNames: names });
      current = next;
      continue;
    }
    const { bytes } = await readBounded(res.body, PROBE_BYTES);
    const validation = validatePrefix(bytes, contentType);
    hops.push({ index: i, status, sourceHost: hostOf(current), destHost: null, note: 'terminal', headerNames: names });
    return {
      hops,
      final: {
        status, finalHost: hostOf(current), finalExt: extensionOf(current), finalFp: urlFingerprint(current),
        contentType, contentRange, contentLength, bytesRead: bytes.length,
        mediaValidation: validation, redirectCount: i,
      },
      error: null,
    };
  }
  return { hops, final: null, error: { stage: 'too-many-redirects' } };
}

// ── Page fetch (bounded, manual redirects) ────────────────────────────────

async function fetchPage(pageUrl, { timeoutMs, maxRedirects, maxBytes, allowHttp, allowPrivate }) {
  const hops = [];
  let current = pageUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const blocked = gateUrl(current, { allowHttp, allowPrivate });
    if (blocked) return { hops, html: null, final: null, error: { stage: 'ssrf-gate', reason: blocked, hop: i } };
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        headers: { 'User-Agent': '9Drive-Diag/1.0', Accept: 'text/html,*/*', 'Accept-Encoding': 'identity' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { hops, html: null, final: null, error: { stage: 'fetch-exception', reason: String(e?.name ?? 'FetchError').slice(0, 80), hop: i } };
    }
    const status = res.status;
    const names = headerNamesOnly(res.headers);
    const contentType = res.headers.get('content-type');
    const contentLength = res.headers.get('content-length');
    const location = res.headers.get('location');
    if (REDIRECT_STATUSES.has(status)) {
      if (!location) {
        try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
        hops.push({ index: i, status, sourceHost: hostOf(current), destHost: null, note: 'redirect-without-location', headerNames: names });
        return { hops, html: null, final: null, error: { stage: 'redirect-without-location', hop: i } };
      }
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
        return { hops, html: null, final: null, error: { stage: 'invalid-location', hop: i } };
      }
      try { await res.arrayBuffer().catch(() => null); } catch { /* noop */ }
      hops.push({ index: i, status, sourceHost: hostOf(current), destHost: hostOf(next), note: 'redirect', headerNames: names });
      current = next;
      continue;
    }
    const cookies = setCookieNames(res.headers);
    const { bytes, truncated } = await readBounded(res.body, maxBytes);
    hops.push({ index: i, status, sourceHost: hostOf(current), destHost: null, note: 'terminal', headerNames: names });
    return {
      hops,
      html: bytes.toString('utf8'),
      final: {
        status, finalHost: hostOf(current), contentType, contentLength,
        bytesRead: bytes.length, windowTruncated: truncated,
        setCookie: { present: cookies.length > 0, count: cookies.length, names: cookies },
      },
      error: null,
    };
  }
  return { hops, html: null, final: null, error: { stage: 'too-many-redirects' } };
}

// ── CLI ───────────────────────────────────────────────────────────────────

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

function parseArgs(argv) {
  const out = { pageFile: null, probeCount: 0, probeThumbs: 0, allowHttp: false, allowPrivate: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--page-file') out.pageFile = argv[++i] ?? null;
    else if (argv[i] === '--probe') out.probeCount = Math.max(0, Math.min(HARD_MAX_PROBES, Number(argv[++i] ?? 0) || 0));
    else if (argv[i] === '--probe-thumbs') out.probeThumbs = Math.max(0, Math.min(2, Number(argv[++i] ?? 0) || 0));
    else if (argv[i] === '--allow-http') out.allowHttp = true;
    else if (argv[i] === '--allow-private') out.allowPrivate = true;
  }
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.DIAG_ALLOW_HTTP ?? '').toLowerCase())) out.allowHttp = true;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.DIAG_ALLOW_PRIVATE ?? '').toLowerCase())) out.allowPrivate = true;
  return out;
}

function resolvePageUrl(args) {
  const fromEnv = (process.env.PAGE_URL ?? '').trim();
  if (fromEnv) return fromEnv;
  if (args.pageFile) {
    try {
      const text = fs.readFileSync(args.pageFile, 'utf8');
      const m = text.match(/^PAGE_URL=(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* fall through to input error */ }
  }
  return null;
}

async function main() {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const pageUrl = resolvePageUrl(args);

  const base = { tool: '9drive-http-only-page-scan', version: TOOL_VERSION, startedAt, finishedAt: null, durationMs: null };

  if (!pageUrl) {
    process.stdout.write(`${JSON.stringify({
      ...base, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
      inputs: { page: null },
      summary: { failureStage: 'input', note: 'PAGE_URL is empty and --page-file yielded nothing.' },
    }, null, 2)}\n`);
    await cleanExit(2);
  }

  const page = await fetchPage(pageUrl, {
    timeoutMs: PAGE_TIMEOUT_MS, maxRedirects: PAGE_MAX_REDIRECTS, maxBytes: PAGE_MAX_BYTES,
    allowHttp: args.allowHttp, allowPrivate: args.allowPrivate,
  });

  const report = {
    ...base,
    inputs: { page: redactUrl(pageUrl) },
    fetch: { hops: page.hops, final: page.final, error: page.error },
    discovery: null,
    probes: [],
    summary: { failureStage: 'not-run', note: '' },
    requestBudget: { used: page.hops.length, max: PAGE_MAX_REDIRECTS + 1 + HARD_MAX_PROBES * (PROBE_MAX_REDIRECTS + 1) },
  };

  if (page.error || page.html == null) {
    report.summary = { failureStage: page.error?.stage ?? 'fetch', note: page.error?.reason ?? 'Page fetch produced no terminal response.' };
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedMs;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await cleanExit(1);
  }

  const found = staticDiscovery(page.html, pageUrl);
  const strip = (list) => list.map((c) => c.redacted);
  report.discovery = {
    htmlBytes: page.html.length,
    urlsScanned: found.urlsScanned,
    vid: strip(found.groups.vid),
    thumb: strip(found.groups.thumb),
    mediaOther: strip(found.groups['media-other']),
    scriptSrcHosts: found.scriptSrcHosts,
    unresolvableScriptSrcs: found.unresolvableScriptSrcs,
    inlineScriptCount: found.inlineScripts,
    playerKeyCensus: found.keyCensus,
  };

  // Optional bounded probes of observed non-thumbnail candidates only.
  const candidates = [...found.groups.vid, ...found.groups['media-other']].slice(0, args.probeCount);
  for (const c of candidates) {
    const outcome = await probeCandidate(c._href, {
      timeoutMs: PROBE_TIMEOUT_MS, maxRedirects: PROBE_MAX_REDIRECTS,
      allowHttp: args.allowHttp, allowPrivate: args.allowPrivate,
    });
    report.probes.push({ kind: 'media', candidate: c.redacted, ...outcome });
    report.requestBudget.used += outcome.hops.length;
  }
  // Optional bounded probes of observed THUMBNAILS (classified separately —
  // never media proof; only answers "does this egress reach the media-origin
  // family at all for unsigned static assets?").
  const thumbCandidates = found.groups.thumb.slice(0, args.probeThumbs);
  for (const c of thumbCandidates) {
    const outcome = await probeCandidate(c._href, {
      timeoutMs: PROBE_TIMEOUT_MS, maxRedirects: PROBE_MAX_REDIRECTS,
      allowHttp: args.allowHttp, allowPrivate: args.allowPrivate,
    });
    report.probes.push({ kind: 'thumb', candidate: c.redacted, ...outcome });
    report.requestBudget.used += outcome.hops.length;
  }

  const mediaHits = report.probes.filter((p) => p.kind === 'media' && p.final?.mediaValidation?.verdict === 'media');
  const thumbHits = report.probes.filter((p) => p.kind === 'thumb' && p.final?.mediaValidation?.verdict === 'media');
  if (mediaHits.length > 0) {
    report.summary = { failureStage: 'ok', note: `${mediaHits.length} statically-observed candidate(s) returned media bytes in the bounded prefix.` };
  } else if (thumbHits.length > 0) {
    report.summary = { failureStage: 'thumb-only', note: `${thumbHits.length} thumbnail(s) returned media bytes (unsigned static assets only); no full-media candidate was observed or proved.` };
  } else if (report.probes.length > 0) {
    report.summary = { failureStage: 'candidate-validation', note: 'Observed candidates probed; none returned media bytes in the bounded prefix.' };
  } else {
    report.summary = {
      failureStage: 'discovery-only',
      note: found.groups.vid.length > 0
        ? 'Static discovery done; rerun with --probe N to bounded-probe observed candidates.'
        : 'No .vid candidates in the static HTML window; media URLs likely originate in executable JS (not reproducible with HTML-only fetch) or require a fresh capture.',
    };
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedMs;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await cleanExit(report.summary.failureStage === 'ok' ? 0 : 1);
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('page-scan.mjs') || entry.endsWith('page-scan.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch(async (e) => {
    process.stdout.write(`${JSON.stringify({
      tool: '9drive-http-only-page-scan', version: TOOL_VERSION,
      finishedAt: new Date().toISOString(),
      summary: { failureStage: 'exception', note: String(e?.name ?? 'Exception').slice(0, 80) },
    }, null, 2)}\n`);
    await cleanExit(1);
  });
}
