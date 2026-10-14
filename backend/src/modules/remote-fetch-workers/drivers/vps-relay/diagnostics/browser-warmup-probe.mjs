/**
 * VPS Browser Warmup PoC — standalone same-egress BEFORE/AFTER diagnostic.
 *
 * Runs on the SAME VPS egress (deploy alongside the relay or in a temp image
 * on the same host/network). Proves whether short-lived headless Chromium
 * page prep (no Play click) enables subsequent normal Node.js ranged fetch
 * to return genuine media bytes.
 *
 * Usage (redacted output — never echoes URLs/cookies/tokens):
 *   node diagnostics/browser-warmup-probe.mjs --page 'https://SOURCE_HOST/...' --media 'https://MEDIA_HOST/...vid' [--timeout-ms 25000] [--range 0-1023] [--json]
 *
 * Gate:
 *   BEFORE 404 → AFTER 206 genuine media = warmup supported, proceed.
 *   Browser 206 + Node 404 = session/fingerprint gap, do NOT ship warmup.
 *   Both 404 = source-side restriction, report only.
 *   206 text/html or vidthumb.mp4 = NOT a media success.
 *
 * Bounds: one Chromium instance, one tab, 25s nav default, sampled bytes
 * only (default 0-1023), immediate close/reap, RSS metrics, no full downloads.
 */
import crypto from 'node:crypto';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return def;
  return v;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function usage() {
  console.log(`Usage: node diagnostics/browser-warmup-probe.mjs --page <SOURCE_PAGE_URL> --media <MEDIA_URL> [--timeout-ms 25000] [--range 0-1023] [--json]`);
  process.exit(2);
}

const pageUrl = arg('page');
const mediaUrl = arg('media');
if (!pageUrl || !mediaUrl) usage();
const timeoutMs = Math.min(Math.max(Number(arg('timeout-ms', '25000')) || 25000, 5000), 60000);
const rangeSpec = arg('range', '0-1023');
const jsonOut = flag('json');

function fp(raw) {
  try {
    return crypto.createHash('sha256').update(new URL(raw).href, 'utf8').digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex').slice(0, 12);
  }
}
function hostOf(raw) {
  try { return new URL(raw).hostname; } catch { return ''; }
}
function extOf(raw) {
  try {
    const p = new URL(raw).pathname.toLowerCase();
    const m = p.match(/\.[a-z0-9]{2,5}$/);
    return m ? m[0] : '(no-ext)';
  } catch { return '(invalid)'; }
}
function redactShape(raw) {
  try {
    const u = new URL(raw);
    return { host: u.hostname, ext: extOf(raw), pathLen: u.pathname.length, queryCount: [...u.searchParams.keys()].length, urlFp: fp(raw) };
  } catch {
    return { host: '', ext: '(invalid)', pathLen: 0, queryCount: 0, urlFp: fp(raw) };
  }
}

function mediaVerdict({ status, headers, bytes }) {
  const ct = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const cr = String(headers['content-range'] || headers['Content-Range'] || '');
  if (status !== 206 && status !== 200) return { genuine: false, reason: `status-${status}` };
  if (ct.includes('text/html')) return { genuine: false, reason: '206-text-html-is-document-not-media' };
  if (!bytes || bytes.length === 0) return { genuine: false, reason: 'empty-body' };
  const head = bytes.subarray(0, 12);
  const ascii = Buffer.from(head).toString('latin1');
  if (ascii.includes('ftyp')) return { genuine: true, reason: 'ftyp-box' };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { genuine: true, reason: 'ebml-webm' };
  if (ct.includes('video/') || ct.includes('audio/') || ct.includes('mp2t') || ct.includes('mpegurl')) {
    return { genuine: status === 206, reason: status === 206 ? 'media-content-type-206' : 'media-content-type-200-needs-range-check' };
  }
  return { genuine: false, reason: `unrecognized-ct:${ct.split(';')[0] || 'none'}` };
}

async function rangedFetch(target, range) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('header timeout')), 20000);
  try {
    const res = await fetch(target, { headers: { Range: `bytes=${range}`, Accept: '*/*', 'User-Agent': '9Drive-WarmupProbe/1.0' }, redirect: 'manual', signal: controller.signal });
    // Follow up to 5 redirects manually (same as relay).
    let current = res;
    let url = target;
    let hops = 0;
    while (current.status >= 300 && current.status < 400 && hops < 5) {
      const loc = current.headers.get('location');
      if (!loc) break;
      try { await current.arrayBuffer().catch(() => null); } catch {}
      url = new URL(loc, url).href;
      current = await fetch(url, { headers: { Range: `bytes=${range}`, Accept: '*/*', 'User-Agent': '9Drive-WarmupProbe/1.0' }, redirect: 'manual', signal: controller.signal });
      hops += 1;
    }
    const headers = {};
    current.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const buf = Buffer.from(await current.arrayBuffer());
    // Bound sampled bytes (default 1KiB range already bounds; hard-cap 64KiB).
    const bytes = buf.subarray(0, 65536);
    return { status: current.status, headers, bytes, redirectHops: hops, finalFp: fp(url), finalHost: hostOf(url) };
  } finally {
    clearTimeout(timer);
  }
}

async function chromiumWarmup(page, timeout) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default ?? (await import('puppeteer-core'));
  } catch {
    return { ran: false, reason: 'puppeteer-core-not-installed', navigationStatus: null, mediaObserved: 0, browserMedia206: false };
  }
  const exe = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  if (!exe) return { ran: false, reason: 'no-chromium-executable', navigationStatus: null, mediaObserved: 0, browserMedia206: false };
  const memBefore = process.memoryUsage().rss;
  const start = Date.now();
  let browser = null;
  const seen = [];
  let browserMedia206 = false;
  let navigationStatus = null;
  try {
    browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--incognito'], timeout: 15000 });
    const pg = await browser.newPage();
    pg.on('request', (r) => {
      try {
        const href = r.url().toLowerCase().split('?')[0];
        if (href.includes('vidthumb')) return;
        if (href.includes('.vid') || href.endsWith('.mp4') || href.endsWith('.m3u8')) seen.push(r.url());
      } catch {}
    });
    pg.on('response', (r) => {
      try {
        const href = r.url().toLowerCase().split('?')[0];
        if (href.includes('vidthumb')) return;
        if ((href.includes('.vid') || href.endsWith('.mp4')) && r.status() === 206) {
          const ct = String(r.headers()['content-type'] || '').toLowerCase();
          if (ct && !ct.includes('text/html')) browserMedia206 = true;
        }
      } catch {}
    });
    const resp = await pg.goto(page, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 25000) });
    try { navigationStatus = resp ? resp.status() : null; } catch { navigationStatus = null; }
    await new Promise((r) => setTimeout(r, 4000));
    await pg.close().catch(() => {});
    return { ran: true, reason: 'ok', navigationStatus, mediaObserved: seen.length, browserMedia206, rssBefore: memBefore, rssAfter: process.memoryUsage().rss, durationMs: Date.now() - start };
  } catch (e) {
    const msg = String((e && e.message) || '').toLowerCase();
    return { ran: false, reason: msg.includes('timeout') ? 'timeout' : 'launch-or-nav-failed', navigationStatus, mediaObserved: seen.length, browserMedia206 };
  } finally {
    try { await browser?.close(); } catch {}
  }
}

const before = await rangedFetch(mediaUrl, rangeSpec);
const beforeVerdict = mediaVerdict(before);
const warm = await chromiumWarmup(pageUrl, timeoutMs);
const after = await rangedFetch(mediaUrl, rangeSpec);
const afterVerdict = mediaVerdict(after);

const gate =
  !beforeVerdict.genuine && afterVerdict.genuine ? 'WARMUP_SUPPORTED_CONTINUE'
  : warm.browserMedia206 && !afterVerdict.genuine ? 'SESSION_GAP_DO_NOT_SHIP'
  : !beforeVerdict.genuine && !afterVerdict.genuine ? 'SOURCE_OR_CONTEXT_RESTRICTION_REPORT_ONLY'
  : beforeVerdict.genuine ? 'ALREADY_ACCESSIBLE_NO_WARMUP_NEEDED'
  : 'INCONCLUSIVE';

const report = {
  tool: 'browser-warmup-probe',
  gate,
  page: redactShape(pageUrl),
  media: redactShape(mediaUrl),
  range: `bytes=${rangeSpec}`,
  before: { status: before.status, contentType: String(before.headers['content-type'] || '').split(';')[0], contentRange: before.headers['content-range'] || null, redirectHops: before.redirectHops, verdict: beforeVerdict },
  warmup: { ran: warm.ran, reason: warm.reason, navigationStatus: warm.navigationStatus, mediaObserved: warm.mediaObserved, browserMedia206: warm.browserMedia206, rssBefore: warm.rssBefore, rssAfter: warm.rssAfter, durationMs: warm.durationMs },
  after: { status: after.status, contentType: String(after.headers['content-type'] || '').split(';')[0], contentRange: after.headers['content-range'] || null, redirectHops: after.redirectHops, verdict: afterVerdict },
  note: 'Hosts + fingerprints only. No URLs, cookies, tokens, or bodies echoed. BEFORE and AFTER used the same media URL + Range on the same egress.',
};

if (jsonOut) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[warmup-probe] gate=${gate}`);
  console.log(`[warmup-probe] page host=${report.page.host} ext=${report.page.ext} fp=${report.page.urlFp}`);
  console.log(`[warmup-probe] media host=${report.media.host} ext=${report.media.ext} fp=${report.media.urlFp} range=${report.range}`);
  console.log(`[warmup-probe] BEFORE status=${before.status} ct=${report.before.contentType} verdict=${beforeVerdict.genuine ? 'GENUINE' : 'not-media'}:${beforeVerdict.reason}`);
  console.log(`[warmup-probe] warmup ran=${warm.ran} nav=${warm.navigationStatus} observed=${warm.mediaObserved} browser206=${warm.browserMedia206} reason=${warm.reason}`);
  console.log(`[warmup-probe] AFTER status=${after.status} ct=${report.after.contentType} verdict=${afterVerdict.genuine ? 'GENUINE' : 'not-media'}:${afterVerdict.reason}`);
}
process.exit(0);
