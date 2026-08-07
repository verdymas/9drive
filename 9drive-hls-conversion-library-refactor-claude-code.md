# Claude Code Prompt — Refactor 9Drive HLS/M3U8 Conversion

You are working inside the existing 9Drive project.

The Remote Import feature already supports direct HTTP/HTTPS files and has an existing HLS/M3U8 implementation, but M3U8 conversion/remux is currently unreliable and frequently fails.

Your task is to **diagnose the existing failure first**, then refactor the HLS pipeline using maintained libraries and a simpler, testable architecture.

Do not blindly rewrite the feature. Reproduce at least one current failure, identify the exact root cause, then implement the refactor.

## Required technology choices

### HLS parser / serializer

Use:

```bash
npm install hls-parser
```

Use `hls-parser` for:

- parsing master playlists;
- parsing media playlists;
- variants and audio renditions;
- segments;
- `EXT-X-MAP`;
- `EXT-X-BYTERANGE`;
- `EXT-X-KEY`;
- discontinuities;
- media sequence;
- live/VOD detection;
- rewriting remote URIs to local materialized URIs;
- serializing rewritten local playlists with `stringify()`.

Do not continue using ad-hoc `split('\n')` parsing or large custom regular expressions for HLS manifests.

### FFmpeg process execution

Prefer:

```bash
npm install execa
```

Use `execa` for FFmpeg and ffprobe execution, unless the repository already has a robust `child_process.spawn()` abstraction with cancellation, timeout handling, progress parsing, bounded stderr capture, and tests.

Do **not** add the deprecated original `fluent-ffmpeg` package.

Never construct shell commands with user input. Use executable + argument arrays only.

### FFmpeg binary

For Docker production, prefer the system FFmpeg binary in the worker image:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

Prefer:

```text
/usr/bin/ffmpeg
/usr/bin/ffprobe
```

Make paths configurable:

```dotenv
REMOTE_IMPORT_FFMPEG_PATH=/usr/bin/ffmpeg
REMOTE_IMPORT_FFPROBE_PATH=/usr/bin/ffprobe
```

At worker startup, verify both binaries and log only safe version information.

Do not require `ffmpeg-static` for Docker production unless repository analysis proves system FFmpeg cannot be used reliably.

---

# 1. Mandatory initial diagnosis

Before modifying files, inspect:

- `AGENTS.md`
- `README.md`
- backend `package.json`
- worker `package.json` if separate
- Dockerfiles
- Docker Compose
- Prisma schema
- Remote Import models
- current HLS parser
- current playlist rewrite logic
- secure HTTP fetcher
- SSRF protection
- redirect handling
- segment downloader
- FFmpeg service
- ffprobe service
- temporary-file manager
- retry/cancel handling
- HLS tests
- worker logs for failed HLS jobs

Search for:

```text
m3u8
HLS
ffmpeg
ffprobe
spawn
exec
protocol_whitelist
EXT-X-MAP
EXT-X-KEY
EXT-X-BYTERANGE
discontinuity
segment
remux
materialize
playlist
output.part
```

Reproduce at least one actual HLS failure.

Capture safely:

- FFmpeg exit code;
- sanitized FFmpeg stderr tail;
- ffprobe error if any;
- current generated local playlist;
- whether every referenced local file exists;
- whether the playlist contains remote URLs after materialization;
- whether the source is MPEG-TS or fragmented MP4;
- whether `EXT-X-MAP` exists;
- whether byte ranges exist;
- whether encryption exists;
- whether separate audio exists;
- whether the source is live;
- whether signed query parameters are required by child resources.

Never log signed query values, encryption keys, cookies, Authorization headers, provider tokens, or credentials.

Before coding, provide a concise root-cause analysis, then continue implementation without waiting for confirmation unless a genuinely blocking repository issue exists.

---

# 2. Target architecture

Refactor HLS processing to this flow:

```text
Remote HLS URL
      ↓
Existing secure 9Drive HTTP fetcher
      ↓
hls-parser
      ↓
Select variant / audio
      ↓
Securely download required resources
      ↓
Materialize all required HLS resources locally
      ↓
Rewrite parsed playlist objects to local URIs
      ↓
hls-parser stringify()
      ↓
Validate generated local playlist
      ↓
FFmpeg reads LOCAL FILES ONLY
      ↓
output.part.mkv
      ↓
ffprobe verification
      ↓
atomic rename → output.mkv
      ↓
Existing 9Drive provider upload pipeline
      ↓
Existing virtual file registration
```

FFmpeg must not fetch arbitrary user-provided HTTP/HTTPS URLs directly.

All remote networking must remain inside the application's secure fetcher and SSRF controls.

---

# 3. Make MKV the default HLS output

Use MKV as the default HLS container because it is more tolerant of stream-copy combinations and is a better default for Jellyfin.

Frontend options may remain:

```text
Automatic
MKV
MP4
```

But for the reliable implementation:

```text
Automatic → MKV
```

Do not attempt MP4 first.

If the user explicitly chooses MP4, treat it as a separate compatibility path and return a clear error when stream copy is impossible.

Never create a file whose extension does not match the actual container.

---

# 4. Replace handcrafted HLS parsing

Create/refactor a dedicated module equivalent to:

```text
hls-manifest.service.ts
```

Responsibilities:

- parse manifest text with `hls-parser`;
- identify master vs media playlist;
- extract variants;
- extract rendition metadata;
- select a variant;
- detect live/VOD;
- calculate approximate duration;
- enforce playlist depth, variant count, and segment count limits;
- inspect encryption;
- resolve child resource URLs;
- build a materialization plan;
- rewrite parsed objects to local paths;
- serialize a valid local playlist using `stringify()`.

Do not manually reconstruct the entire playlist using string concatenation.

Use the installed library's typed structures for variants, renditions, segments, maps, byte ranges, keys, and discontinuities.

---

# 5. Preserve HLS semantics during rewrite

The rewritten playlist must preserve all relevant semantics, including:

- HLS version;
- target duration;
- media sequence;
- discontinuity sequence;
- playlist type;
- endlist;
- segment duration;
- segment title where applicable;
- discontinuities;
- `EXT-X-MAP`;
- `EXT-X-BYTERANGE` semantics until materialized;
- AES-128 key metadata where supported;
- IV values;
- program date time where harmless.

Dropping `EXT-X-MAP`, byte-range semantics, discontinuities, or keys is considered a conversion bug.

---

# 6. Local materialization layout

Never use remote paths directly as local filesystem paths.

Use generated paths, for example:

```text
job/
├── video/
│   ├── init-000001.mp4
│   ├── segment-000001.ts
│   ├── segment-000002.ts
│   └── ...
├── audio/
│   ├── init-000001.mp4
│   ├── segment-000001.m4s
│   └── ...
├── keys/
│   └── key-000001.bin
├── video.local.m3u8
├── audio.local.m3u8
├── output.part.mkv
└── output.mkv
```

Requirements:

- all files must remain under the job directory;
- no symlinks;
- no `../` traversal;
- no source-provided `file://` paths;
- use generated filenames;
- validate paths before read/write/delete;
- wait for all file writes to fully flush before FFmpeg starts;
- use atomic rename for final output.

---

# 7. Master playlist handling

For a master playlist:

1. Parse using `hls-parser`.
2. Generate server-owned opaque variant IDs.
3. Select the requested variant by ID.
4. Resolve its URI relative to the final master URL.
5. Fetch through the secure HTTP client.
6. Parse the selected media playlist with `hls-parser`.

Do not trust a raw child playlist URL supplied by the frontend.

Automatic selection should be deterministic:

1. highest supported resolution within configured limits;
2. highest average bandwidth;
3. highest bandwidth;
4. stable tie-breaker.

Ignore I-frame-only variants for normal imports.

---

# 8. Separate audio handling

If audio is embedded in the selected media playlist:

```text
video.local.m3u8
→ FFmpeg input
```

If the selected master variant references a separate audio rendition:

```text
video playlist → video.local.m3u8
audio playlist → audio.local.m3u8
```

Then remux using two local inputs:

```text
ffmpeg
-i video.local.m3u8
-i audio.local.m3u8
-map 0:v:0
-map 1:a:0
-c copy
output.part.mkv
```

Do not create a synthetic combined master playlist unless actually required.

Verify the final MKV contains both streams using ffprobe.

---

# 9. MPEG-TS HLS

Support HLS using `.ts` media segments.

Start with a minimal local FFmpeg stream-copy command:

```text
ffmpeg
-nostdin
-hide_banner
-loglevel warning
-progress pipe:1
-protocol_whitelist file,crypto,data
-allowed_extensions ALL
-i /safe/job/video.local.m3u8
-map 0
-c copy
-y
/safe/job/output.part.mkv
```

If the source has timestamp/DTS compatibility issues, retry once using a named compatibility profile:

```text
-fflags +genpts
-avoid_negative_ts make_zero
```

Do not randomly add FFmpeg flags until one happens to work.

Use explicit command profiles such as:

```text
standard
timestamp_compat
```

Record which profile succeeded.

---

# 10. Fragmented MP4 / EXT-X-MAP

This support is mandatory.

For every `EXT-X-MAP` initialization section:

1. securely resolve URI;
2. respect optional byte range;
3. download it;
4. save it locally;
5. rewrite the parsed map URI to the local filename.

For every fMP4 fragment:

1. securely download it;
2. preserve ordering;
3. preserve or materialize byte ranges;
4. rewrite URI to local filename.

Do not omit the initialization map.

Add a real fMP4 HLS fixture containing `EXT-X-MAP`.

---

# 11. Byte-range handling

Support `EXT-X-BYTERANGE` correctly.

Preferred implementation:

- download each required byte range into its own generated local segment file;
- after exact range materialization, remove the byte-range attribute from the local parsed segment object;
- rewrite its URI to the generated local file.

For each range request:

1. calculate exact offset and length;
2. send HTTP `Range`;
3. require valid `206 Partial Content` unless a narrowly documented fallback is safe;
4. validate `Content-Range`;
5. write exactly the requested bytes;
6. enforce total import size limits.

Handle implicit consecutive offsets correctly.

Never treat an entire `200 OK` response as a valid requested byte range.

---

# 12. AES-128 handling

Support only standard HLS:

```text
METHOD=AES-128
```

with identity-compatible keys.

For each unique key:

1. fetch through the secure HTTP client;
2. validate SSRF on every redirect;
3. strictly limit key response size;
4. store using a generated local filename;
5. rewrite `segment.key.uri` to the local key file;
6. preserve IV;
7. never log key bytes or full key URL;
8. delete key files during cleanup.

Reject:

```text
SAMPLE-AES
SAMPLE-AES-CTR
Widevine
FairPlay
PlayReady
non-identity DRM key formats
```

Return stable errors instead of producing corrupted media.

---

# 13. Signed URL compatibility

Investigate whether the failing real-world source uses signed query parameters.

Standard relative URL resolution does not automatically inherit the parent query string.

Do not globally append query parameters to child URLs.

Implement an optional narrowly controlled fallback:

1. resolve the child URI normally;
2. try the standard URL first;
3. only after a 401/403-like failure, and only when:
   - child is same-origin;
   - child URI contains no query;
   - parent URL has query parameters;
   - compatibility fallback is enabled;
   retry once with parent query parameters;
4. never log query values.

Configuration:

```dotenv
REMOTE_IMPORT_HLS_INHERIT_PARENT_QUERY_FALLBACK=false
```

Keep disabled by default unless product requirements justify it.

---

# 14. Safe HTTP request profile

The secure fetcher may use application-defined headers such as:

```text
User-Agent
Accept
Accept-Encoding
```

Suggested manifest Accept value:

```text
application/vnd.apple.mpegurl, application/x-mpegURL, audio/mpegurl, */*
```

Suggested media Accept value:

```text
video/*, audio/*, application/octet-stream, */*
```

Do not add arbitrary user-controlled headers.

Do not add arbitrary Cookie, Authorization, or Referer injection as part of this refactor.

If a real source requires authenticated cookies or mandatory Referer, classify it as an unsupported authenticated-source case instead of silently weakening security.

---

# 15. FFmpeg execution service

Create/refactor a dedicated service equivalent to:

```text
media-remux.service.ts
```

Typed operations should include equivalents of:

```ts
remuxHlsToMkv(...)
remuxSeparateVideoAudioToMkv(...)
remuxHlsToMp4(...)
probeMedia(...)
```

Process requirements:

- no shell;
- argument arrays only;
- cancellation support;
- timeout support;
- bounded stderr capture;
- machine-readable progress using `-progress pipe:1`;
- graceful terminate, then force kill after deadline;
- no orphan processes;
- no untrusted arbitrary FFmpeg options.

Do not infer success only from exit code. ffprobe must validate the output.

---

# 16. MP4 path

MP4 is secondary.

If explicitly selected:

```text
ffmpeg
...
-c copy
-movflags +faststart
output.part.mp4
```

If stream-copy to MP4 fails because the input codecs/container combination is incompatible, return:

```text
HLS_MP4_STREAM_COPY_UNSUPPORTED
```

Suggest MKV in the user-facing message.

Do not silently transcode video.

---

# 17. ffprobe verification

After FFmpeg exits successfully, run ffprobe against the partial output:

```text
ffprobe
-v error
-show_format
-show_streams
-of json
output.part.mkv
```

Require:

- file exists;
- size > 0;
- readable container;
- at least one expected media stream;
- positive duration for finite VOD;
- video stream when source is expected to contain video;
- audio stream for separate-audio import when expected.

Only after validation:

```text
output.part.mkv
→ atomic rename
→ output.mkv
```

Only then upload it.

---

# 18. Validate local playlists before FFmpeg

Before invoking FFmpeg:

1. parse the generated local playlist again using `hls-parser`;
2. confirm it is a media playlist;
3. confirm it contains segments;
4. confirm every segment URI points to an existing local file;
5. confirm every initialization map exists;
6. confirm every AES key file exists;
7. confirm no HTTP/HTTPS URI remains;
8. confirm no URI escapes the job directory;
9. confirm no source-controlled `file://` URI exists;
10. confirm total local materialized bytes are within limits.

On failure, return:

```text
HLS_LOCAL_PLAYLIST_INVALID
```

Do not invoke FFmpeg with an invalid generated playlist.

---

# 19. Improve error diagnostics

Add/reuse stable errors equivalent to:

```text
HLS_PARSE_FAILED
HLS_MASTER_INVALID
HLS_VARIANT_NOT_FOUND
HLS_MEDIA_PLAYLIST_INVALID
HLS_SEGMENT_DOWNLOAD_FAILED
HLS_SEGMENT_RANGE_INVALID
HLS_INIT_MAP_FAILED
HLS_KEY_DOWNLOAD_FAILED
HLS_ENCRYPTION_UNSUPPORTED
HLS_DRM_UNSUPPORTED
HLS_AUDIO_RENDITION_FAILED
HLS_LOCAL_PLAYLIST_INVALID
HLS_FFMPEG_FAILED
HLS_FFMPEG_TIMESTAMP_FAILED
HLS_FFPROBE_FAILED
HLS_OUTPUT_INVALID
HLS_AUTHENTICATED_SOURCE_UNSUPPORTED
HLS_MP4_STREAM_COPY_UNSUPPORTED
```

Persist safe diagnostics such as:

- error code;
- stage;
- FFmpeg exit code;
- sanitized stderr tail;
- completed segment count;
- selected resolution/bandwidth;
- MPEG-TS vs fMP4;
- whether map/byterange/encryption exists;
- command profile used.

Do not expose signed URLs, keys, internal credentials, or raw stack traces to users.

---

# 20. Development-only debug artifacts

For failed conversion in development/test only, optionally retain:

```text
manifest.original.redacted.m3u8
video.local.m3u8
audio.local.m3u8
ffmpeg.stderr.log
ffprobe.json
materialization-summary.json
```

Never preserve or expose:

- AES key content;
- signed query strings;
- cookies;
- Authorization headers.

Configuration:

```dotenv
REMOTE_IMPORT_HLS_KEEP_FAILED_DEBUG_ARTIFACTS=false
```

Production default must be false.

---

# 21. Direct file imports must not regress

Existing direct URL flow remains:

```text
direct URL
→ secure download
→ provider upload
```

Only HLS uses:

```text
manifest
→ materialize
→ remux
→ verify
→ provider upload
```

Do not introduce unnecessary changes to working direct-file imports.

---

# 22. Frontend behavior

Keep the existing Import from URL modal and Remote Imports page.

For HLS show:

```text
Source: HLS
Quality: Automatic / 1080p / 720p / ...
Audio: Automatic / track
Output: MKV / MP4
```

Default HLS output:

```text
MKV
```

If retaining `Automatic`, helper text should say:

```text
Automatic uses MKV for maximum compatibility.
```

Provide user-friendly messages for stable errors, e.g.:

```text
The HLS playlist could not be parsed.
```

```text
A media segment could not be downloaded.
```

```text
This HLS source uses unsupported DRM encryption.
```

```text
This stream cannot be remuxed to MP4 using stream copy. Try MKV.
```

Do not show raw FFmpeg stderr to normal users.

---

# 23. Required real HLS fixtures

Do not rely only on mocked parser objects.

Create controlled local fixtures.

## Fixture A — MPEG-TS HLS

H.264 + AAC using `.ts` segments.

Expected:

```text
HLS → local playlist → MKV stream copy → ffprobe success
```

## Fixture B — fMP4 HLS

Must contain:

```text
EXT-X-MAP
*.m4s
```

Expected successful MKV output.

## Fixture C — Master variants

At least three variants such as:

```text
1080p
720p
480p
```

Verify requested selection.

## Fixture D — Separate audio

Video and audio in separate media playlists.

Final MKV must contain both video and audio.

## Fixture E — AES-128

Synthetic non-DRM AES-128 playlist.

Verify local key rewrite and successful remux.

## Fixture F — Byte range

Verify exact range downloads and valid local rewritten playlist.

---

# 24. hls-parser round-trip tests

Add unit tests for:

```text
parse(original)
→ mutate remote URIs to local URIs
→ stringify()
→ parse(generated)
```

Verify preserved semantics for:

- master/media detection;
- variants;
- audio renditions;
- durations;
- discontinuities;
- maps;
- byte ranges;
- keys;
- media sequence;
- endlist.

This round-trip test is mandatory.

---

# 25. End-to-end worker test

Create an end-to-end test using a local HTTP fixture server:

```text
fixture server
→ Remote Import probe
→ HLS detection
→ variant selection
→ secure download
→ hls-parser materialization
→ local playlist validation
→ FFmpeg
→ ffprobe
→ mocked provider upload
→ final file registration
```

Require ffprobe to validate a real generated media container.

Do not claim HLS is fixed because parser-only tests pass.

---

# 26. Turn the current failure into a regression test

After reproducing the actual current failure:

1. reduce it to the smallest safe fixture possible;
2. strip credentials and signed values;
3. create a regression test;
4. document why the old implementation failed;
5. verify the new implementation passes.

Investigate, do not assume, likely causes such as:

- handcrafted playlist lost `EXT-X-MAP`;
- byte-range semantics lost;
- separate audio ignored;
- invalid local relative paths;
- missing `crypto`/`data` protocol in FFmpeg whitelist;
- incompatible FFmpeg binary/build;
- MP4 stream-copy incompatibility;
- timestamp/DTS issues;
- incomplete segment file;
- Range source returned 200 instead of 206;
- key URI not rewritten;
- signed parent query required by child resources;
- FFmpeg launched before segment writes were flushed;
- upload started before remux truly completed;
- live playlist treated as VOD.

---

# 27. Docker capability verification

Inside the built worker container run:

```bash
ffmpeg -version
ffprobe -version
ffmpeg -demuxers
ffmpeg -protocols
ffmpeg -codecs
```

Verify at minimum:

```text
HLS demuxer
MPEG-TS demuxer
MOV/MP4 demuxer
Matroska muxer
file protocol
crypto protocol when AES-128 is enabled
H.264 parsing
AAC parsing
```

Verify HEVC if intended to be supported.

Do not assume any package named `ffmpeg` has the required capabilities.

---

# 28. Dependency policy

Preferred new dependencies:

```text
hls-parser
execa
```

Do not add:

```text
fluent-ffmpeg
```

Do not add several M3U8 parsers simultaneously.

Do not use `m3u8stream` as the new core HLS implementation unless repository analysis proves it provides a required capability that `hls-parser` plus the existing secure HTTP pipeline cannot provide.

Do not use `@ffmpeg/ffmpeg` / ffmpeg.wasm in the Docker backend worker.

Do not use HLS.js as the server-side converter/downloader.

---

# 29. Performance

Use bounded segment concurrency.

Suggested default:

```dotenv
REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY=6
```

Do not create one simultaneous Promise per segment for large playlists.

Preserve media order independently from network completion order.

Stream segment bodies to disk; do not load full segments into memory.

Enforce:

- maximum manifest bytes;
- maximum segment count;
- maximum total import bytes;
- network timeouts;
- retry limits.

---

# 30. Retry behavior

Retry must be stage-aware.

If all segments exist and the local playlist validates but FFmpeg failed:

```text
retry FFmpeg only
```

If ffprobe already passed and provider upload failed:

```text
retry provider upload only
```

If some segments are missing:

```text
reuse verified existing segments
→ download missing resources
```

Do not create duplicate remote provider files or duplicate database File rows.

---

# 31. Cancellation

Cancellation must abort:

- manifest requests;
- segment requests;
- key requests;
- map requests;
- FFmpeg;
- ffprobe;
- provider upload.

Ensure process cancellation cannot leave orphan FFmpeg processes.

Cancelled jobs must not enter automatic retry.

---

# 32. Acceptance criteria

The work is complete only when:

- the current real HLS failure has a documented root cause;
- `hls-parser` is used for manifest parsing;
- `hls-parser` is used to serialize rewritten local manifests;
- large handcrafted HLS reconstruction is removed;
- MKV is the default HLS output;
- FFmpeg reads only local materialized resources;
- FFmpeg is executed without shell-string interpolation;
- MPEG-TS HLS remux succeeds;
- fMP4 + `EXT-X-MAP` HLS remux succeeds;
- byte-range HLS succeeds;
- separate audio succeeds;
- standard non-DRM AES-128 succeeds when enabled;
- unsupported DRM is rejected;
- local playlists are validated before FFmpeg;
- ffprobe validates final output before upload;
- stage-aware retry works;
- existing direct-file imports still work;
- Docker worker contains a verified FFmpeg binary;
- real end-to-end HLS tests pass;
- backend/frontend builds still pass.

---

# 33. Required verification commands

Determine exact repository commands and run all applicable equivalents of:

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build
docker compose config
docker compose build
docker compose up -d
```

Inside the actual remote-import worker container run:

```bash
ffmpeg -version
ffprobe -version
```

Run end-to-end tests against actual local MPEG-TS and fMP4 fixtures.

Do not claim success unless commands were actually executed.

Fix every regression caused by this change.

Clearly separate unrelated pre-existing failures.

---

# 34. Final report

At completion provide:

## Root cause

Explain exactly why the previous M3U8 conversion failed.

## Old pipeline

Show the previous conversion flow.

## New pipeline

Show:

```text
secure fetch
→ hls-parser
→ local materialization
→ hls-parser stringify
→ local validation
→ FFmpeg
→ ffprobe
→ provider upload
```

## Installed versions

Report exact installed versions of:

```text
hls-parser
execa
FFmpeg
ffprobe
```

## Files changed

List important files.

## Actual FFmpeg profiles

Show sanitized argument arrays used by the working implementation.

## HLS compatibility results

Report actual tested result for:

```text
MPEG-TS
fMP4 / EXT-X-MAP
byte range
separate audio
AES-128
master playlist
media playlist
```

## Tests executed

For every command:

```text
Command:
Result:
```

## Real conversion verification

Report:

```text
fixture
selected variant
input type
output container
output duration
video codec
audio codec
output size
ffprobe result
```

## Remaining limitations

State them explicitly.

Do not claim the issue is fixed until at least one MPEG-TS fixture and one fMP4 fixture successfully complete:

```text
probe
→ download
→ materialize
→ local playlist validation
→ FFmpeg remux
→ ffprobe
→ provider upload
→ virtual file registration
```
