# Browser Capture × MediaGrabber — Phases 1–3 Analysis

Analysis deliverables for the MediaGrabber reference phase pack. Covers:

1. Audit of the current 9Drive Browser Capture
2. Reverse engineering of `references/MediaGrabber`
3. Gap analysis with keep/adapt/custom/defer classifications

The reference repository is treated as read-only. No runtime code is imported
from it; all production changes live in the 9Drive codebase.

---

## Phase 1 — Audit: Current 9Drive Browser Capture

### Important files / modules

| File | Responsibility |
| --- | --- |
| `extensions/browser-capture/manifest.json` | MV3 manifest; `webRequest` + `host_permissions` for observational header inspection; action popup; no `cookies`/`tabs` (uses `initiator`/`originUrl`). |
| `extensions/browser-capture/src/background.js` | Service worker: `webRequest` detection (request-origin tracking + response headers), context menu, badge, 5-min sync sweep, popup message API, device pairing handshake. |
| `extensions/browser-capture/src/content-script.js` | Collects public page metadata (`title`, `og:title`, `twitter:title`, `mediaTitle`) and `<a download>` attributes into `chrome.storage.session`, keyed by stripped page URL. |
| `extensions/browser-capture/src/classify.js` | Pure classification (`classifyResource`, `classifyMime`), display labels, quality extraction, HLS size estimation, and popup grouping (`groupCaptures`). |
| `extensions/browser-capture/src/filename-resolver.js` | Central filename candidate scoring (custom > CD `filename*` > CD `filename` > download attr > final URL > request URL > media/og/twitter/page titles), generic-name penalization, sanitizer, HLS/DASH output-container swap. |
| `extensions/browser-capture/src/store.js` | `chrome.storage.local` capture list, status taxonomy, FIFO cap (200), badge count source of truth, server prune. |
| `extensions/browser-capture/src/api.js` | Backend client: API-root resolution probe, device-token auth, resource submit/list/delete, import-options, import. |
| `extensions/browser-capture/popup/*` | Popup UI: capture cards, HLS variant grouping with quality select, inline import form (filename/folder/account/worker), Clear All, pairing form. |
| `backend/src/modules/browser-capture/*` | Pairing/device lifecycle, resource submission (SSRF-lite gate, display-URL stripping, encrypted at rest, hashed tokens), TTL sweep, and import that re-uses the existing Remote Import pipeline. |
| `backend/src/modules/remote-imports/*` | The import side: probe (CD/URL/HTML rejection), filename chain, SSRF gate, worker routing, HLS pipeline, FFmpeg, Drive/S3 upload, retry/queue lifecycle. |

### Data flow

```
browser/network/DOM
 → webRequest onHeadersReceived (final URL + headers) + onBeforeRequest (original URL)
 → classifyResource(url, mime)          [suppresses segments/variants]
 → content-script pageMetadata (title/og/twitter/mediaTitle, download attrs)
 → resolveFilename(...)                 [candidate scoring]
 → addCapture (local store, dedupe by URL) + updateBadge
 → submitResource (device token)        [backend validates + stores encrypted]
 → popup getState → groupCaptures → cards
 → importCapturedResource → createRemoteImport (probe again, canonical filename)
 → queue → processor → HLS/direct → Drive/S3
```

### Filename mutation points

1. `background.js` detection: `resolveFilename(...)` → `entry.filename`.
2. `classify.js detectFilename` (deprecated shim, kept for popup grouping).
3. `background.js` context menu: `resolveFilename` with `requestUrl === finalUrl`.
4. `popup.js startImport`: user-edited `#dlgName` → sent as `filename` to import; persisted to `customFilename`.
5. `browser-capture.service.ts importCapturedResource`: priority `user filename → resource.filename`, re-sanitized; `sourceFileName` preserved; HLS container swap in `remote-import.service.ts hlsFinalFileName`.
6. `remote-import.service.ts createRemoteImport`: final canonicalization (probe name only used when no captured name); the processor/uploader reuse `row.fileName`.

The chain holds: a canonical name set at capture time survives to `File.name`.

### Metadata collection points

- Page: `content-script.js` — `title`, `ogTitle`, `twitterTitle`, `mediaTitle`, `<a download>`.
- Response: `background.js` — `content-type`, `content-length`, `content-disposition`; original vs final URL via `requestOrigins` map.
- Request context: referer/origin only; cookies never requested/read.

### Grouping / dedup points

- Grouping: `classify.js groupCaptures` — HLS/DASH grouped by page origin+path; primary = first detected.
- Dedup: `store.js addCapture` by exact URL (detected/pending only); backend `submitCapturedResource` by `(user, displayUrl, type)` among pending rows (TTL refresh). 5-min sweep prunes consumed rows.

### Type classification points

- `classify.js` — HLS/DASH manifest-first, video/document by extension or MIME, segments/variants suppressed.
- Backend `capture-types.ts RESOURCE_TYPES = ['video','hls','dash','document']` + zod enum in routes.

### Remote Import payload construction

`background.js syncCapture` → `submitResource` (url, type, mimeType, filename, pageUrl, pageTitle, requestContext). Import: `popup.js` → `POST /browser-capture/resources/:id/import` with `{filename, folderId, connectedAccountId, workerId}` → service loads the stored URL server-side, probes for HLS, and calls `createRemoteImport` (worker guard, SSRF gate, request context, canonical filename).

### Current weak points

1. Classification only covers video/hls/dash/document — no audio/archive/image/unknown (Phase 8).
2. Page metadata lacks thumbnail, duration, resolution/quality (Phase 5).
3. HLS grouping over-groups by bare page path; no master/variant distinction; primary = first-detected, not master (Phase 7).
4. Local dedup is exact-URL only — signed-URL re-detections can duplicate locally (Phase 12).
5. Quality is derived from the filename only, not from the media element's resolution (Phase 5/6).
6. Popup shows no thumbnail/duration; type label is a badge but no normalized subtitle (Phase 11).

---

## Phase 2 — Reverse Engineering: MediaGrabber

### Important files

| File | Responsibility |
| --- | --- |
| `extension/src/background.ts` | Service worker: webRequest detection, per-tab state (`mediaByTab`, `pageMetadataByTab`, generations), HLS/DASH manifest fetching + variant/rendition parsing, MSE relay mapping, yt-dlp (YouTube) path, download orchestration via native messaging. |
| `extension/src/content.ts` | DOM observer for `video`/`source`/`iframe`; MSE hookup (message bridge with injected script); page metadata (`og:title` → `twitter:title` → `document.title`, thumbnail cascade, duration); SPA navigation generations. |
| `extension/src/lib/m3u8-parser.ts` | Master/media playlist parsing: `EXT-X-STREAM-INF` variants (bandwidth/resolution/codecs/audio-group), `EXT-X-MEDIA` renditions (audio/subtitles), segment durations, dedupe of identical variants. |
| `extension/src/lib/dash-parser.ts`, `mpd-parser.ts` | DASH/MPD equivalent: variants (bandwidth/height), subtitle tracks. |
| `extension/src/lib/quality-utils.ts` | Quality labels (`4K/1440p/...`), bandwidth formatting, duration formatting, dedupe of quality levels. |
| `extension/src/lib/types.ts` | `VideoInfo` / `VideoQuality` model: title, type, qualities[], childUrls, referer, thumbnail, duration, fileSize. |
| `extension/src/popup/popup.ts` | Per-tab popup: video list, quality picker, download with filename edit. |
| `coapp/*` | Native companion app (ffmpeg/yt-dlp/downloads) — **not applicable to 9Drive** (server-side imports). |

### Detection architecture

- **Two-layer detection**: (a) webRequest (HLS/DASH content-types + `.m3u8/.mpd/.mp4/.webm` paths) in the service worker; (b) DOM/MSE in the content script.
- **Per-tab state with generation counters**: `pageGenerationByTab` / `navigationGenerationByTab` invalidate stale detections after SPA navigation — messages carry a `generation` and are dropped when stale.
- **Manifest-first identity**: HLS/DASH master playlists are fetched and parsed in the background; variants become `qualities[]` of ONE `VideoInfo` (the master), never separate cards; media playlists contribute duration.
- **MSE**: an injected script captures `SourceBuffer` append segments and relays blob/segment URLs + codecs to the content script, which builds a single MSE `VideoInfo`.
- **YouTube**: special-cased via yt-dlp through the native client.
- **Media identity model**: `VideoInfo { id, title, url, type, qualities[], childUrls, referer, thumbnail, duration, fileSize }` — one identity per logical media asset, quality variants nested inside.

### Metadata propagation

`content.ts` sends `PAGE_METADATA` (title, thumbnail, duration, pageUrl, generation) to the background; the background merges it into `pageMetadataByTab` and back-fills `thumbnail`/`duration` onto already-detected videos. Titles use `og:title` → `twitter:title` → `document.title`.

### Grouping behavior

HLS variants are children of the master (via `childUrls` + `qualities`), deduped on URL and on path for redirect chains; audio renditions attach to variants by audio-group; subtitle tracks attach as quality entries. Unrelated media on a page stay separate `VideoInfo` entries.

### Title/filename behavior

Downloads default to `${video.title}` (site-suffix NOT stripped, sanitized) with the container extension appended via `ensureFilenameExtension`; user edits win. No candidate scoring, no Content-Disposition/`download` attribute handling, no site-suffix stripping.

### Useful concepts to adapt

1. **Manifest-first grouping**: master owns variants — merge into 9Drive's grouping so a master and its `1080.m3u8/720.m3u8/audio.m3u8` become ONE logical card.
2. **Thumbnail cascade**: `og:image` → `twitter:image` → `video[poster]` → `img[class*=poster/thumb]`.
3. **Title fallback**: `og:title` → `twitter:title` → `document.title` (9Drive already has this plus `mediaTitle`, and improves it with site-suffix stripping).
4. **Duration/quality from DOM**: `video.duration`, `videoWidth/videoHeight` → quality label.
5. **Navigation generation guard**: stale detections after SPA route changes are dropped (9Drive currently keys metadata by page URL in `storage.session`; a generation counter would make it robust).
6. **Quality label helpers**: height → `4K/1440p/1080p/...`, bandwidth formatting.

### Concepts that should NOT be copied

- **Native companion app (CoApp) + ffmpeg/yt-dlp in the extension** — 9Drive is server-side import only (Phase 9 guardrail).
- **MSE segment capture / browser relay URL rewriting** — out of scope; 9Drive's backend HLS pipeline downloads the manifest server-side.
- **YouTube yt-dlp special-casing** — the backend probe handles remote content generically.
- **Per-tab media maps with badge per tab** — 9Drive's model is a cross-tab pending list synced to the backend (its own requirement).
- **`isMediaUrl` extension-only matching** (e.g. `.includes('.m3u8')` matching filenames like `foo.m3u8.bak`) — 9Drive's stricter classification is safer.
- **Blindly copying parser code** — 9Drive's backend already has production HLS/DASH parsers; the extension must stay a capture client.

---

## Phase 3 — Gap Analysis

Legend: **keep** = keep 9Drive behavior · **adapt** = adapt MediaGrabber concept · **custom** = new 9Drive solution · **defer** = not now.

| Area | 9Drive today | MediaGrabber | Classification |
| --- | --- | --- | --- |
| Request/MIME detection | webRequest header + URL classification, segments suppressed | webRequest content-type + URL | **keep** |
| HLS/DASH detection | Extension + MIME, manifest-first | Extension + MIME + manifest fetch/parse | **adapt** (manifest-first grouping) |
| MP4/WebM/video-element | URL/MIME video; `mediaTitle` from `video[title]` | URL + DOM video/source scan | **adapt** (scan `video`/`source` nodes, capture resolution/duration) |
| Dynamic page / MSE | n/a (backend handles streams) | MSE injection + relay | **defer** (backend pipeline covers it) |
| Content-Disposition | Parsed (RFC 5987 + 6266), top-2 priority | not handled | **keep** |
| Final URL vs request URL | `requestOrigins` map, final beats request | not tracked (redirect dedupe by path only) | **keep** |
| HTML `download` attribute | Collected + scored | not handled | **keep** |
| Media/player title | `video[title]` → `mediaTitle`, top title source | `og:title` → `twitter:title` → `document.title` | **keep** (already superset) |
| og:title / twitter:title / document.title | Collected, site-suffix stripped, scored | Collected, not cleaned | **keep** |
| Manifest basename behavior | Generic names penalized (`master/index/1080/...`) | Title used as-is; manifest basename only when no title | **keep** (matches spec) |
| Quality/resolution | From filename only | From DOM resolution + manifest bandwidth | **adapt** (DOM resolution → quality) |
| Bandwidth | n/a in extension (backend probes) | parsed from manifests | **defer** (backend probe owns it) |
| Duration | Not collected | `video.duration` + manifest EXTINF sum | **adapt** (collect `video.duration`) |
| Thumbnail | Not collected | og:image/twitter:image/poster cascade | **adapt** (cascade) |
| Grouping master/variant/audio | By page origin+path; first-detected primary | Master owns variants; audio renditions attached | **adapt** (master-aware primary, same-directory grouping) |
| Deduplication | Exact URL locally; `(user, displayUrl, type)` server-side | URL + path dedupe, per-tab | **custom** (display-URL dedupe locally + repeat-detection refresh) |
| Popup representation | Cards + HLS group + quality select | Per-tab list + quality picker | **custom** (9Drive cross-tab model; add thumbnail/duration/subtitle) |
| Resource types | video/hls/dash/document | hls/dash/mp4/webm/ytdlp/mse/direct | **adapt** (add audio/archive/image/unknown, normalize) |
| Filename strategy | Candidate scoring (spec-compliant) | Title + container append | **keep** |
| Remote Import integration | Server-side, worker routing, canonical name | n/a (local downloads) | **keep** (guardrails) |
| Live HLS | Rejected from capture import with clear error | ffmpeg records live | **keep** (9Drive dashboard owns recording duration) |
