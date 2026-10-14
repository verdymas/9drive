/**
 * Offline mocked tests for media-probe.mjs — dependency-free.
 *
 * Run anywhere with plain Node.js 20+ (Alpine / non-root safe):
 *   node --test media-probe.test.mjs
 *
 * Covers (before any live URL is tested):
 *   - redirect chain tracing (302 -> final 206, query shape preserved)
 *   - genuine media 206 (mp4 ftyp) classified as media
 *   - HTML 206 trap classified as html, never media
 *   - upstream 404 preserved as status (not a relay error)
 *   - 302 without Location handled cleanly
 *   - 416 Range Not Satisfiable handled cleanly
 *   - Range-ignoring origin (200 despite Range) flagged
 *   - empty MEDIA_URL input handled with exit-code-2 semantics (report only)
 *   - SSRF literal gate blocks loopback unless explicitly allowed
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  gateUrl,
  probeUrl,
  redactedInput,
  runDiagnosis,
  shapeOf,
  urlFingerprint,
  validateMediaBytes,
} from './media-probe.mjs';

const MP4_PREFIX = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(1016, 0x01),
]);
const HTML_BODY = Buffer.from(
  '<!DOCTYPE html><html><head><title>t</title></head><body>' + 'x'.repeat(2000) + '</body></html>',
);

function startMockUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    }
    hits.push({ method: req.method, url: req.url, headers });
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: `/final.vid${url.search}` });
      res.end();
      return;
    }
    if (url.pathname === '/final.vid') {
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-1023/5000',
        'accept-ranges': 'bytes',
        'content-length': '1024',
      });
      res.end(MP4_PREFIX);
      return;
    }
    if (url.pathname === '/html206') {
      res.writeHead(206, {
        'content-type': 'text/html',
        'content-range': 'bytes 0-1023/30862',
        'content-length': '1024',
      });
      res.end(HTML_BODY.subarray(0, 1024));
      return;
    }
    if (url.pathname === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>not found</body></html>');
      return;
    }
    if (url.pathname === '/no-location') {
      res.writeHead(302);
      res.end();
      return;
    }
    if (url.pathname === '/range-416') {
      res.writeHead(416, { 'content-type': 'text/plain' });
      res.end('range not satisfiable');
      return;
    }
    if (url.pathname === '/ignore-range') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4_PREFIX.length) });
      res.end(MP4_PREFIX);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, hits });
    });
  });
}

const LOCAL = { allowHttp: true, allowPrivate: true, timeoutMs: 5000, maxRedirects: 4, probeBytes: 1024 };

test('genuine media 206 is classified as media (mp4 ftyp)', async () => {
  const { server, base } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/final.vid?token=abc`, { ...LOCAL });
    assert.equal(out.error, null);
    assert.equal(out.final.status, 206);
    assert.equal(out.final.mediaValidation.verdict, 'media');
    assert.equal(out.final.mediaValidation.magic, 'mp4-ftyp');
    assert.equal(out.final.finalExt, 'vid');
  } finally {
    server.close();
  }
});

test('HTML 206 trap is classified as html, never media', async () => {
  const { server, base } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/html206`, { ...LOCAL });
    assert.equal(out.error, null);
    assert.equal(out.final.status, 206);
    assert.equal(out.final.contentType, 'text/html');
    assert.equal(out.final.mediaValidation.verdict, 'html');
    assert.notEqual(out.final.mediaValidation.verdict, 'media');
  } finally {
    server.close();
  }
});

test('redirect chain is traced hop-by-hop with query shape preserved', async () => {
  const { server, base, hits } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/redirect?token=q123`, { ...LOCAL });
    assert.equal(out.error, null);
    assert.equal(out.hops.length, 2);
    assert.equal(out.hops[0].status, 302);
    assert.equal(out.hops[0].note, 'redirect');
    assert.equal(out.hops[1].note, 'terminal');
    assert.equal(out.final.status, 206);
    assert.equal(out.final.redirectCount, 1);
    // Query shape survived the redirect hop.
    assert.ok(out.final.finalFp.length === 12);
    assert.equal(hits[1].url, '/final.vid?token=q123');
  } finally {
    server.close();
  }
});

test('upstream 404 is preserved as status, not thrown', async () => {
  const { server, base } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/missing`, { ...LOCAL });
    assert.equal(out.error, null);
    assert.equal(out.final.status, 404);
    assert.equal(out.final.mediaValidation.verdict !== 'media', true);
  } finally {
    server.close();
  }
});

test('302 without Location is handled cleanly', async () => {
  const { server, base } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/no-location`, { ...LOCAL });
    assert.equal(out.final, null);
    assert.equal(out.error.stage, 'redirect-without-location');
  } finally {
    server.close();
  }
});

test('416 Range Not Satisfiable is handled cleanly', async () => {
  const { server, base } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/ignore-range-check`, { ...LOCAL });
    // Unknown path answers 200 text/plain — verdict must be unknown, not media.
    assert.equal(out.final.mediaValidation.verdict, 'unknown');
  } finally {
    server.close();
  }
  const second = await startMockUpstream();
  try {
    const out = await probeUrl(`${second.base}/range-416`, { ...LOCAL });
    assert.equal(out.error, null);
    assert.equal(out.final.status, 416);
  } finally {
    second.server.close();
  }
});

test('Range-ignoring origin (200 despite Range) is flagged', async () => {
  const { server, base } = await startMockUpstream();
  try {
    const out = await probeUrl(`${base}/ignore-range`, { ...LOCAL });
    assert.equal(out.final.status, 200);
    assert.equal(out.final.rangeIgnored, true);
    assert.equal(out.final.mediaValidation.verdict, 'media');
  } finally {
    server.close();
  }
});

test('validateMediaBytes: .vid alone without magic is unknown, not media', () => {
  const v = validateMediaBytes({
    bytes: Buffer.from('opaque-bytes-not-magic-12345'),
    contentType: 'application/octet-stream',
    contentRange: null,
    finalExt: 'vid',
  });
  assert.equal(v.verdict, 'unknown');
});

test('empty MEDIA_URL yields an input-stage report (no fetch)', async () => {
  const report = await runDiagnosis({
    pageUrl: null,
    mediaUrl: null,
    refererUrl: null,
    timeoutMs: 5000,
    maxRedirects: 4,
    probeBytes: 1024,
    maxRequests: 10,
    allowHttp: true,
    allowPrivate: true,
  });
  assert.equal(report.summary.failureStage, 'input');
  assert.equal(report.summary.mediaProved, false);
  assert.equal(report.experiments.length, 0);
});

test('SSRF literal gate blocks loopback unless explicitly allowed', () => {
  assert.equal(gateUrl('http://127.0.0.1/x', { allowHttp: true, allowPrivate: false }), 'SSRF_BLOCKED_ADDRESS');
  assert.equal(gateUrl('http://127.0.0.1/x', { allowHttp: true, allowPrivate: true }), null);
  assert.equal(gateUrl('http://example.com/x', { allowHttp: false, allowPrivate: false }), 'HTTP_NOT_ALLOWED');
  assert.equal(gateUrl('https://example.com/x', { allowHttp: false, allowPrivate: false }), null);
});

test('redaction: fingerprints stable, shapes carry names only', () => {
  const a = 'https://cdn.example/video.vid?token=SECRET&expires=1';
  const b = 'https://cdn.example/video.vid?token=SECRET&expires=1';
  assert.equal(urlFingerprint(a), urlFingerprint(b));
  const shaped = shapeOf(a);
  assert.ok(!JSON.stringify(shaped).includes('SECRET'));
  const red = redactedInput(a);
  assert.ok(!JSON.stringify(red).includes('SECRET'));
  assert.equal(red.host, 'cdn.example');
  assert.equal(red.ext, 'vid');
});
