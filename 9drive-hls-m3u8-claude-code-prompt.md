# Claude Code Prompt — Add HLS/M3U8 Support to 9Drive Remote Import

You are working inside the existing 9Drive project.

The Remote Import from URL feature is already implemented for direct HTTP and
HTTPS files.

Extend Remote Import so it supports HLS/M3U8 sources safely and reliably.

A user must be able to paste an `.m3u8` URL, inspect the available variants,
select a quality when applicable, download the HLS media, remux it into a normal
media file, upload the result to Google Drive or S3-compatible storage, and
register it in the existing 9Drive virtual filesystem.

Do not implement this as a separate unrelated downloader. Extend and reuse the
existing Remote Import architecture, queue, worker, progress reporting, storage
routing, temporary storage, cancellation, retry, and file registration logic.

Inspect the repository before modifying any files.

Read and trace at least:

- `AGENTS.md`
- `README.md`
- `docker-compose.yml`
- Backend and worker Dockerfiles
- `.env` example files
- Backend package scripts
- Prisma schema and migrations
- Remote Import Prisma model
- Remote Import routes, controllers, services, queue, and worker
- Existing secure URL probe service
- Existing SSRF protection
- Existing redirect handling
- Existing direct-file downloader
- Existing temporary-file management
- Existing progress broadcasting or polling
- Existing Google Drive upload implementation
- Existing S3 upload implementation
- Existing automatic storage routing
- Existing Remote Import frontend modal and page
- Existing filename auto-detection
- Existing frontend and backend tests

Search for:

- `RemoteImport`
- `remote-import`
- `probe`
- `download`
- `Content-Disposition`
- `ssrf`
- `redirect`
- `BullMQ`
- `progress`
- `cancel`
- `retry`
- `spawn`
- `ffmpeg`
- `ffprobe`
- `temporary`
- `upload`
- `ConnectedAccount`
- `routing`

Do not assume filenames, routes, database fields, services, or component names.
Adapt everything to the actual repository.

Before coding, provide a concise implementation plan, then continue without
waiting for confirmation unless there is a genuinely blocking repository issue.

## 1. Supported source types

Extend Remote Import source detection to support:

- Direct HTTP file.
- Direct HTTPS file.
- HLS master playlist.
- HLS media playlist.
- URLs without an `.m3u8` extension when the response body is an HLS playlist.
- HLS playlists returned using common M3U8 content types.
- Signed HLS URLs using query parameters.
- Relative segment and child-playlist URLs.
- Absolute segment and child-playlist URLs.
- Redirecting playlist URLs.
- MPEG-TS segments.
- Fragmented MP4 segments with initialization maps.
- Standard finite HLS VOD playlists.
- Separate default audio renditions when they can be muxed safely.
- Standard AES-128 encrypted HLS only when the key is directly accessible
  through the same secure HTTP pipeline.

Do not support:

- Widevine.
- FairPlay.
- PlayReady.
- SAMPLE-AES.
- DRM license servers.
- DRM bypass.
- Paywall bypass.
- Browser automation.
- HTML page scraping.
- YouTube or social-media extraction.
- Torrents or magnet links.
- Arbitrary cookies supplied by users.
- Arbitrary request headers supplied by users.
- Interactive login.
- Local filesystem URLs.
- FTP.
- `file:`, `data:`, `javascript:`, `blob:`, or other non-HTTP source URLs.

Reject unsupported encryption explicitly instead of producing a corrupted file.

Users are responsible for having permission to download and store the source.

## 2. Source type detection

Add a strongly typed source classification equivalent to:

```text
direct_file
hls_master
hls_media
```

Detect HLS using all available signals:

1. Final URL pathname ending in `.m3u8`.
2. An HLS-compatible response Content-Type.
3. A safely read, strictly size-limited text prefix beginning with `#EXTM3U`.
4. HLS-specific tags inside the manifest.

Do not rely only on the URL extension.

Do not classify ordinary M3U audio playlists as HLS unless HLS-specific tags are
present.

The probe must read only a small configurable manifest body.

Add configuration equivalent to:

```dotenv
REMOTE_IMPORT_HLS_ENABLED=true
REMOTE_IMPORT_HLS_MAX_MANIFEST_BYTES=1048576
REMOTE_IMPORT_HLS_MAX_PLAYLIST_DEPTH=4
REMOTE_IMPORT_HLS_MAX_VARIANTS=50
REMOTE_IMPORT_HLS_MAX_SEGMENTS=50000
REMOTE_IMPORT_HLS_SEGMENT_CONCURRENCY=6
REMOTE_IMPORT_HLS_SEGMENT_ATTEMPTS=4
REMOTE_IMPORT_HLS_LIVE_ENABLED=true
REMOTE_IMPORT_HLS_MIN_RECORD_SECONDS=60
REMOTE_IMPORT_HLS_MAX_RECORD_SECONDS=21600
REMOTE_IMPORT_HLS_DEFAULT_CONTAINER=mkv
REMOTE_IMPORT_FFMPEG_PATH=/usr/bin/ffmpeg
REMOTE_IMPORT_FFPROBE_PATH=/usr/bin/ffprobe
REMOTE_IMPORT_FFMPEG_TIMEOUT_SECONDS=3600
```

Use names and configuration conventions consistent with the repository.

Validate every environment variable at startup.

## 3. HLS probe response

Extend the existing Remote Import probe endpoint.

A direct file should keep its existing response behavior.

For an HLS master playlist, return safe metadata equivalent to:

```json
{
  "data": {
    "sourceType": "hls_master",
    "fileName": "example.mkv",
    "fileNameSource": "hls-derived",
    "mimeType": "application/vnd.apple.mpegurl",
    "isLive": false,
    "durationSeconds": 5423.5,
    "variants": [
      {
        "id": "stable-generated-id",
        "bandwidth": 6500000,
        "averageBandwidth": 5800000,
        "width": 1920,
        "height": 1080,
        "frameRate": 25,
        "codecs": ["avc1.640028", "mp4a.40.2"],
        "audioGroup": "audio-main",
        "label": "1080p · 5.8 Mbps"
      },
      {
        "id": "stable-generated-id",
        "bandwidth": 3200000,
        "averageBandwidth": 2800000,
        "width": 1280,
        "height": 720,
        "frameRate": 25,
        "codecs": ["avc1.4d401f", "mp4a.40.2"],
        "audioGroup": "audio-main",
        "label": "720p · 2.8 Mbps"
      }
    ],
    "audioTracks": [
      {
        "id": "stable-generated-id",
        "language": "id",
        "name": "Indonesian",
        "isDefault": true,
        "isAutoSelect": true
      }
    ]
  }
}
```

Do not expose:

- Full signed child-playlist URLs.
- Full signed segment URLs.
- Encryption key URLs.
- Internal temporary paths.
- Internal IP addresses.
- Raw playlist content.

Use opaque stable selection IDs generated from normalized playlist metadata.

Do not trust a client-supplied variant URL.

When an import is created, resolve the selected variant ID again from the
server-side playlist.

## 4. Manifest parser

Use a maintained HLS/M3U8 parser compatible with the current TypeScript stack
when an appropriate dependency is not already present.

Do not parse HLS using line splitting and ad hoc regular expressions alone.

The parser must safely handle at least:

- `#EXTM3U`
- `#EXT-X-STREAM-INF`
- `#EXT-X-MEDIA`
- `#EXTINF`
- `#EXT-X-ENDLIST`
- `#EXT-X-PLAYLIST-TYPE`
- `#EXT-X-TARGETDURATION`
- `#EXT-X-MEDIA-SEQUENCE`
- `#EXT-X-DISCONTINUITY`
- `#EXT-X-DISCONTINUITY-SEQUENCE`
- `#EXT-X-MAP`
- `#EXT-X-BYTERANGE`
- `#EXT-X-KEY`
- `#EXT-X-PROGRAM-DATE-TIME`
- `#EXT-X-VERSION`
- `#EXT-X-INDEPENDENT-SEGMENTS`

Preserve tags needed for correct local remuxing.

Resolve relative URIs using the final manifest URL, not the original
pre-redirect URL.

Apply a maximum nested-playlist depth and reject loops.

Reject manifests exceeding the configured size.

Reject playlists with excessive variants or segments.

Reject recursive references.

## 5. Mandatory SSRF protection for every HLS resource

Do not validate only the initial M3U8 URL.

Every remote URI referenced by HLS must use the existing secure HTTP fetcher and
SSRF protection.

This includes:

- Master playlists.
- Child media playlists.
- Video segments.
- Audio playlists.
- Audio segments.
- Subtitle playlists.
- Subtitle segments.
- Initialization maps.
- AES-128 keys.
- Redirect targets.
- Any URI discovered after refreshing a live playlist.

For every resource:

1. Parse the URL.
2. Allow only HTTP and HTTPS.
3. Reject embedded credentials.
4. Resolve DNS.
5. Validate every resolved address.
6. Reject private, loopback, link-local, reserved, multicast, Docker-internal,
   and cloud metadata addresses.
7. Validate again on every redirect.
8. Limit redirects.
9. Enforce connect, header, idle, and total timeouts.
10. Enforce strict response-size limits.
11. Redact query parameters in logs.
12. Do not forward authorization headers across hosts.
13. Do not accept arbitrary client-provided headers.

Block malicious playlist entries such as:

```text
file:///etc/passwd
http://127.0.0.1:4000/private
http://mysql:3306/
http://redis:6379/
http://169.254.169.254/
http://metadata.google.internal/
```

Also test:

- IPv4-mapped IPv6.
- Decimal IP representations.
- Encoded host variants.
- DNS resolving to a private IP.
- Public URL redirecting to a private IP.
- Segment URL redirecting to a private IP.
- Key URL redirecting to a private IP.
- Child playlist redirecting to a private IP.

Do not allow FFmpeg to fetch the original remote playlist or remote segments
directly because that would bypass the application's secure HTTP and SSRF
controls.

## 6. Secure local HLS materialization

Implement HLS downloading using a secure local-materialization architecture.

Required flow:

```text
Remote M3U8
    ↓
Secure application HTTP fetcher
    ↓
Parse and validate manifest
    ↓
Securely download playlists, segments, maps, and permitted keys
    ↓
Store using generated local filenames
    ↓
Create rewritten local media playlist
    ↓
Run FFmpeg only against local files
    ↓
Produce MKV or MP4
    ↓
Upload using the existing 9Drive upload pipeline
```

FFmpeg must not receive the user-provided remote URL as its input.

Create a job directory equivalent to:

```text
REMOTE_IMPORT_TEMP_DIR/{userId}/{jobId}/
```

Use safe generated names:

```text
manifest-master.m3u8
manifest-video.m3u8
video-segment-000001.ts
video-segment-000002.ts
audio-segment-000001.aac
init-video-000001.mp4
key-000001.bin
output.part.mkv
output.mkv
```

Never use untrusted segment URL paths as local filesystem paths.

Requirements:

- Prevent path traversal.
- Do not create symlinks.
- Use restrictive permissions.
- Keep all files under the job directory.
- Validate paths before read, write, rename, and delete.
- Use atomic rename where appropriate.
- Never delete outside the configured temporary root.
- Track temporary disk usage.
- Enforce the existing maximum import size while downloading segments.
- Include manifest, map, key, segment, and output sizes in limits.
- Detect insufficient temporary disk space where practical.

## 7. Variant selection

For a master playlist, support:

- Automatic quality selection.
- Manual variant selection.

Automatic selection should choose the best valid variant under configured
limits.

Add optional configuration equivalent to:

```dotenv
REMOTE_IMPORT_HLS_MAX_HEIGHT=2160
REMOTE_IMPORT_HLS_MAX_BANDWIDTH=0
```

A value of zero may mean unlimited if consistent with the repository.

Prefer:

1. A variant with valid video codecs.
2. The highest resolution within configured limits.
3. The highest average bandwidth or bandwidth within limits.
4. A deterministic tie-breaker.

Do not select an audio-only variant when a video variant is expected.

The user interface should show:

```text
Automatic (best available)
2160p · 15.2 Mbps
1080p · 5.8 Mbps
720p · 2.8 Mbps
480p · 1.2 Mbps
```

Do not display duplicate or meaningless variants.

When dimensions are missing, show bitrate or another safe label.

On job execution:

- Fetch the master playlist again.
- Resolve the opaque selected variant ID.
- Confirm that the variant still exists.
- Fail clearly or fall back according to an explicitly documented rule.
- Never accept a raw child-playlist URL from the frontend.

## 8. Audio handling

Support these cases:

1. Audio multiplexed in the selected video variant.
2. A separate default audio rendition referenced by the variant.
3. User-selected audio rendition when multiple supported options exist.

The probe should return safe audio-track metadata.

The frontend may show an Audio Track selector only when multiple choices exist.

Default selection:

1. Playlist-marked default audio.
2. Auto-select audio.
3. First valid supported audio rendition.

Preserve the chosen language metadata when possible.

Do not add audio transcoding in the first implementation.

Use stream copy.

If the selected video and audio cannot be safely muxed into the requested
container, return a clear error or use the documented automatic container
fallback.

## 9. Subtitle handling

Subtitle support is optional for the first implementation.

At minimum:

- Detect subtitle renditions.
- Do not fail an otherwise valid import merely because subtitles exist.
- Do not burn subtitles into video.
- Do not transcode video to add subtitles.
- Document whether subtitles are ignored, muxed, or saved separately.

If implementing subtitles now:

- Support WebVTT where FFmpeg can mux it safely.
- Prefer MKV when MP4 cannot preserve the subtitle track.
- Use the same SSRF protection for subtitle playlists and segments.
- Let the user select subtitles or choose none.
- Do not download every subtitle language by default.

## 10. HLS encryption policy

Support only:

```text
METHOD=AES-128
```

and only when:

- The key URI is HTTP or HTTPS.
- The key is retrievable through the secure fetcher.
- The key response size is strictly limited.
- Every redirect is validated.
- The key is stored only inside the job directory.
- The key is removed during cleanup.
- The playlist uses an identity-compatible key format.
- No DRM license flow is involved.

Reject:

```text
METHOD=SAMPLE-AES
METHOD=SAMPLE-AES-CTR
KEYFORMAT values representing DRM systems
FairPlay
Widevine
PlayReady
License-server workflows
```

Use a stable error code such as:

```text
HLS_DRM_NOT_SUPPORTED
HLS_ENCRYPTION_NOT_SUPPORTED
```

Never log key contents or complete key URLs.

Do not persist encryption key contents in MySQL or Redis.

## 11. Byte-range and initialization-map support

Support `EXT-X-MAP`.

Download initialization data through the secure fetcher and rewrite the local
playlist to reference the generated local map file.

Support `EXT-X-BYTERANGE`.

For byte-range resources:

- Issue validated HTTP Range requests.
- Verify `206 Partial Content` where required.
- Validate `Content-Range`.
- Materialize the selected range into its own safe local file, or preserve a
  correct rewritten local byte-range representation.
- Never append a complete `200 OK` response as though it were a partial range.
- Enforce total-byte limits.
- Retry safely.

Add tests for:

- Explicit byte-range offsets.
- Implicit consecutive offsets.
- Shared source objects.
- Invalid Content-Range.
- Source ignoring Range.
- Initialization map with a byte range.

## 12. Finite VOD imports

For a finite media playlist:

- Download every required segment exactly once.
- Preserve original sequence order.
- Preserve discontinuities.
- Validate that all required resources completed.
- Generate a local rewritten playlist.
- Ensure the rewritten playlist ends correctly.
- Remux into the selected output container.
- Verify the output using ffprobe.
- Upload only after verification succeeds.

A source with `EXT-X-ENDLIST` should be treated as finite.

An EVENT playlist that eventually reaches an end state may also be imported.

## 13. Live HLS support

Support live HLS only through an explicit recording duration.

Do not create an infinite Remote Import job.

When the probe detects a live playlist, the UI must show:

```text
Live HLS stream detected
Recording duration is required
```

Add an input:

```text
Recording Duration
```

Validate against configured minimum and maximum values.

Conceptual create request:

```json
{
  "url": "https://example.com/live/master.m3u8",
  "folderId": "folder-id",
  "fileName": "live-recording.mkv",
  "connectedAccountId": null,
  "hls": {
    "variantId": "variant-id",
    "audioTrackId": "audio-id",
    "outputContainer": "mkv",
    "recordingDurationSeconds": 3600
  }
}
```

Live recording flow:

1. Fetch the selected media playlist.
2. Record the current media sequence.
3. Poll the playlist according to a safe interval derived from target duration.
4. Download newly observed segments.
5. Deduplicate sequence numbers and segment identities.
6. Preserve discontinuities.
7. Continue until the requested recording duration is reached.
8. Stop gracefully.
9. Create a finite local playlist.
10. Remux the captured segments.
11. Verify and upload the output.

Requirements:

- Do not repeatedly download old sliding-window segments.
- Handle media-sequence increments.
- Handle temporary manifest fetch failures.
- Stop on cancellation.
- Respect the overall recording deadline.
- Do not exceed maximum recording duration.
- Do not continue indefinitely when the source stalls.
- Persist sufficient progress to recover or fail clearly after worker restart.
- Clearly document whether a worker restart can resume a live recording.

If reliable live recording cannot be implemented safely within the existing
architecture, fully support VOD first and reject live playlists with a stable
error. Do not silently treat a live playlist as a finished file.

## 14. Output format

Add an output container option:

```text
Automatic
MKV
MP4
```

Recommended default:

```text
Automatic
```

Behavior:

- Use stream copy by default.
- Do not transcode video or audio.
- Prefer MP4 only when all selected streams are compatible.
- Prefer MKV when there are separate audio tracks, subtitles, discontinuities,
  or uncertain container compatibility.
- If Automatic chooses MP4 and stream-copy muxing fails because of container
  compatibility, retry once using MKV.
- If the user explicitly selected MP4, do not silently change to MKV without a
  clear documented behavior.
- Never generate duplicate filename extensions.

Examples:

```text
movie.m3u8 → movie.mkv
movie.mp4 → movie.mp4
movie.mkv → movie.mkv
movie → movie.mkv
```

The final stored filename must match the actual output container.

## 15. FFmpeg integration

Install FFmpeg and ffprobe in the remote-import worker image.

Do not unnecessarily add FFmpeg to the frontend or database images.

At worker startup:

- Verify FFmpeg exists.
- Verify ffprobe exists.
- Log safe version information.
- Fail readiness or job execution with a clear error when unavailable.

Run FFmpeg using `spawn` with an argument array.

Never use:

```text
exec("ffmpeg " + userInput)
```

Never construct a shell command containing user input.

FFmpeg must read only the local rewritten playlist.

Use a minimal protocol whitelist appropriate for local materialized HLS.

Do not include HTTP, HTTPS, TCP, or TLS in FFmpeg's protocol whitelist because
remote fetching must remain inside the secure application fetcher.

Conceptual command for MKV:

```text
ffmpeg
-nostdin
-hide_banner
-loglevel warning
-progress pipe:1
-protocol_whitelist file,crypto
-i /safe/job/path/local.m3u8
-map 0
-c copy
-y
/safe/job/path/output.part.mkv
```

Conceptual command for MP4:

```text
ffmpeg
-nostdin
-hide_banner
-loglevel warning
-progress pipe:1
-protocol_whitelist file,crypto
-i /safe/job/path/local.m3u8
-map 0
-c copy
-movflags +faststart
-y
/safe/job/path/output.part.mp4
```

Adapt arguments based on actual stream and subtitle handling.

Additional requirements:

- Set the process working directory to the safe job directory.
- Do not pass untrusted metadata as arbitrary FFmpeg arguments.
- Capture stdout and stderr safely.
- Limit retained stderr size.
- Parse `-progress pipe:1` output.
- Use an AbortSignal or equivalent cancellation control.
- On cancellation, send a graceful termination signal.
- After a timeout, force-kill the process.
- Ensure child processes do not survive worker termination.
- Rename `.part` to the final output only after FFmpeg succeeds.
- Never upload a partial output.

## 16. FFprobe verification

After remuxing, verify the output with ffprobe.

Use JSON output and inspect at least:

- Container format.
- Duration.
- File size.
- Video stream existence when expected.
- Audio stream existence when expected.
- Codec names.
- Width and height.
- Stream duration where available.

Reject:

- Empty output.
- Zero-byte output.
- Missing expected video.
- Unreadable container.
- Obviously truncated output.
- Output outside configured size limits.

Do not upload until verification succeeds.

Store safe media metadata on the Remote Import record when consistent with the
existing schema.

## 17. Progress reporting

Extend Remote Import stages with equivalents of:

```text
probing
parsing_playlist
selecting_variant
downloading_manifest
downloading_segments
recording_live
remuxing
verifying
selecting_storage
uploading
registering
cleaning
finished
```

For finite playlists, report:

- Segments completed.
- Total segments.
- Bytes downloaded.
- Known total bytes when available.
- Media duration downloaded.
- Total media duration.
- Current download speed.
- Remux progress.
- Upload progress.

For live recording, report:

- Recorded duration.
- Requested duration.
- Segments captured.
- Download speed.
- Current stage.

The UI should show messages such as:

```text
Downloading HLS segments · 128 / 420
Recording live stream · 00:18:32 / 01:00:00
Remuxing media · 74%
Uploading to Google Drive · 42%
```

Throttle database and realtime progress writes.

Always persist final state transitions.

Do not allow progress values outside 0–100.

## 18. Database changes

Inspect the existing Remote Import model and add only fields that are genuinely
needed.

Possible additions include equivalents of:

```text
sourceType
hlsPlaylistType
hlsVariantId
hlsVariantBandwidth
hlsVariantWidth
hlsVariantHeight
hlsAudioTrackId
hlsAudioLanguage
hlsOutputContainer
hlsIsLive
hlsRecordingDurationSeconds
hlsMediaDurationSeconds
hlsSegmentCount
hlsCompletedSegmentCount
remuxProgress
outputDurationSeconds
outputCodecSummary
```

Use the repository's existing ID, enum, naming, mapping, and index conventions.

Do not store complete playlists unless necessary.

Do not store signed child URLs or key URLs in plaintext.

Add an appropriate Prisma migration.

Ensure existing direct-file Remote Imports continue working without migration
issues.

## 19. API changes

Extend the existing probe and create APIs instead of creating unrelated
parallel APIs.

Conceptual create input:

```json
{
  "url": "https://example.com/master.m3u8",
  "folderId": "folder-id",
  "fileName": "Movie Name.mkv",
  "connectedAccountId": null,
  "hls": {
    "variantId": "variant-id-or-auto",
    "audioTrackId": "audio-id-or-auto",
    "subtitleTrackId": null,
    "outputContainer": "auto",
    "recordingDurationSeconds": null
  }
}
```

Rules:

- `hls` options are valid only for HLS sources.
- A live source requires recording duration.
- A finite source must reject unnecessary live-only options.
- Variant IDs must be resolved server-side.
- Folder ownership must be verified.
- Account ownership must be verified.
- Maximum active jobs must still apply.
- Retry must preserve the selected HLS options.
- Cancel must stop playlist polling, segment downloads, and FFmpeg.
- Delete history must not delete a successfully uploaded file.

## 20. Retry and resume

Retry behavior:

- Reuse securely downloaded segments when their metadata still matches.
- Do not redownload completed valid segments unnecessarily.
- Validate local segment files before reuse.
- Resume from the missing segment where practical.
- If the playlist or selected variant changed incompatibly, restart safely.
- Do not produce duplicate final files.
- Do not create duplicate provider uploads.
- Preserve existing upload-only retry behavior when remux output is complete.
- Clean obsolete local manifests before rebuilding them.

Track segment completion using either:

- A compact persisted manifest in the job directory.
- Database state.
- Another repository-consistent approach.

Do not create one database row per segment unless clearly justified.

## 21. Cancellation

Cancellation must stop:

- Manifest probing.
- Playlist refresh.
- Active segment requests.
- Queued segment requests.
- AES key requests.
- FFmpeg.
- ffprobe.
- Provider upload.

After cancellation:

- Mark the job cancelled.
- Do not register a partial output.
- Remove partial FFmpeg output.
- Clean or schedule cleanup of segments.
- Do not allow automatic queue retries.
- Avoid orphan child processes.

## 22. Frontend changes

Update the existing Import from URL modal.

After probing an HLS URL, display:

```text
Source Type
HLS Video
```

For a master playlist, display:

```text
Quality
Automatic (best available)
1080p · 5.8 Mbps
720p · 2.8 Mbps
480p · 1.2 Mbps
```

When multiple audio tracks exist, display:

```text
Audio
Automatic
Indonesian
English
Japanese
```

Display:

```text
Output Format
Automatic
MKV
MP4
```

When live:

```text
Live HLS stream detected
Recording Duration
```

Use a duration control consistent with the existing form components.

Filename behavior:

- Keep existing automatic filename detection.
- For HLS, replace `.m3u8` with the selected output extension.
- Do not overwrite a manually edited filename.
- Update an auto-generated extension when output format changes.
- Do not update a manually provided extension unexpectedly.
- Validate that the final extension matches the effective output container.

The Start Import button should remain disabled when:

- Probe is still loading.
- HLS metadata is invalid.
- No valid variant exists.
- A live source has no valid recording duration.
- The filename is invalid.
- Destination is invalid.

Do not disable import only because total file size is unknown.

## 23. Remote Imports page

Extend each Remote Import item to display HLS-specific information safely:

```text
HLS · 1080p · Indonesian
Downloading segments · 128 / 420
Remuxing · 74%
Recording · 00:18:32 / 01:00:00
```

Do not display:

- Full signed playlist URL.
- Segment URLs.
- Key URLs.
- Raw playlist bodies.

Reuse the overflow-safe responsive layout already implemented.

Long filename, error, and safe display URL values must remain inside the card.

## 24. Docker changes

Update the worker Docker image to install a pinned or distribution-supported
FFmpeg package.

Ensure:

- `ffmpeg -version` works.
- `ffprobe -version` works.
- The worker uses a non-root user when supported.
- The temporary volume is writable by the worker.
- FFmpeg only accesses the temporary job directory.
- The backend does not need FFmpeg unless it also performs HLS work.
- No new internal service is exposed publicly.

Update Docker health checks or startup validation where appropriate.

Run:

```text
docker compose config
docker compose build
```

Verify the worker starts successfully.

## 25. Stable error codes

Add or reuse stable error codes equivalent to:

```text
HLS_DISABLED
HLS_INVALID_MANIFEST
HLS_MANIFEST_TOO_LARGE
HLS_PLAYLIST_DEPTH_EXCEEDED
HLS_PLAYLIST_LOOP
HLS_TOO_MANY_VARIANTS
HLS_TOO_MANY_SEGMENTS
HLS_NO_VALID_VARIANT
HLS_SELECTED_VARIANT_NOT_FOUND
HLS_AUDIO_TRACK_NOT_FOUND
HLS_LIVE_DURATION_REQUIRED
HLS_LIVE_NOT_SUPPORTED
HLS_LIVE_DURATION_INVALID
HLS_SEGMENT_DOWNLOAD_FAILED
HLS_SEGMENT_TOO_LARGE
HLS_SEGMENT_RANGE_INVALID
HLS_MAP_DOWNLOAD_FAILED
HLS_KEY_DOWNLOAD_FAILED
HLS_ENCRYPTION_NOT_SUPPORTED
HLS_DRM_NOT_SUPPORTED
HLS_SOURCE_CHANGED
HLS_REMUX_FAILED
HLS_OUTPUT_INVALID
FFMPEG_NOT_AVAILABLE
FFMPEG_TIMEOUT
FFPROBE_FAILED
```

User-facing errors must not expose internal IPs, local paths, stack traces, signed
URLs, or secrets.

## 26. Tests

Use the repository's existing test framework.

Create controlled local HLS fixtures and servers. Do not depend on public
internet streams.

Backend unit tests must cover:

- Source-type detection.
- M3U8 content type.
- `#EXTM3U` body detection.
- Master playlist parsing.
- Media playlist parsing.
- Variant sorting.
- Automatic variant selection.
- Audio rendition selection.
- Relative URI resolution.
- Playlist depth limits.
- Playlist loops.
- Segment-count limits.
- Filename generation.
- Output extension handling.
- Live detection.
- Duration validation.
- Unsupported encryption.
- DRM rejection.
- Local path safety.
- Progress calculation.

SSRF tests must cover malicious URIs in:

- Initial playlist.
- Child playlist.
- Video segment.
- Audio segment.
- Subtitle segment.
- Initialization map.
- AES key.
- Redirect target.

Integration fixtures must cover:

1. Simple VOD MPEG-TS playlist.
2. VOD playlist without `.m3u8` URL extension.
3. Master playlist with 1080p, 720p, and 480p variants.
4. Relative child-playlist URLs.
5. Absolute child-playlist URLs.
6. Redirecting master playlist.
7. Redirecting segment URL.
8. Separate default audio.
9. Fragmented MP4 with `EXT-X-MAP`.
10. Byte-range playlist.
11. AES-128 playlist.
12. SAMPLE-AES rejection.
13. Playlist missing `EXT-X-ENDLIST`.
14. Live sliding-window simulation.
15. Playlist containing a private-IP segment.
16. Playlist containing a `file:` segment.
17. Segment returning 404.
18. Segment returning 500 and succeeding on retry.
19. Segment with invalid Content-Length.
20. Segment exceeding maximum size.
21. Worker cancellation during segment download.
22. Cancellation during FFmpeg.
23. Retry using existing downloaded segments.
24. FFmpeg remux failure.
25. ffprobe verification failure.
26. Successful provider upload.
27. No duplicate final file after worker retry.

Frontend tests must cover:

- Direct-file UI remains unchanged.
- HLS probe displays source type.
- Variant selector appears.
- Automatic variant is selected by default.
- Audio selector appears only when needed.
- Output format selector works.
- `.m3u8` filename becomes `.mkv` or `.mp4`.
- Manual filename is not overwritten.
- Live duration is required.
- Invalid duration blocks submission.
- HLS progress stages render correctly.
- Cancel works.
- Retry works.
- Long HLS metadata does not overflow.

## 27. Manual verification

Create local test fixtures using tools available in the development environment.

Verify at least:

### Simple VOD

- Paste a finite VOD M3U8.
- Probe identifies HLS.
- Import starts.
- Segments download.
- FFmpeg remuxes.
- ffprobe verifies.
- Output uploads.
- File appears in the selected virtual folder.
- Output plays correctly.

### Master playlist

- Paste a master M3U8.
- Variant list appears.
- Select 720p.
- Confirm the downloaded result is the selected variant.

### Automatic variant

- Select Automatic.
- Confirm the best eligible variant is selected.

### Live playlist

- Paste a simulated live playlist.
- Confirm recording duration is required.
- Record a short permitted duration.
- Confirm the output is finite and playable.

### Cancellation

- Cancel during segment download.
- Confirm network requests stop.
- Confirm no upload occurs.
- Confirm temporary files are cleaned.

### Security

Attempt playlists referencing:

```text
http://127.0.0.1/
http://mysql:3306/
http://169.254.169.254/
file:///etc/passwd
```

Confirm every case is blocked.

## 28. Required verification commands

Determine exact commands from the repository and run all applicable commands:

- Prisma formatting.
- Prisma validation.
- Prisma generation.
- Prisma migration.
- Backend lint.
- Backend type check.
- Backend unit tests.
- Backend integration tests.
- Worker tests.
- Frontend lint.
- Frontend type check.
- Frontend tests.
- Frontend build.
- Docker Compose validation.
- Docker image build.
- Playwright tests if configured.

Also verify:

```text
ffmpeg -version
ffprobe -version
```

Do not claim success unless commands were actually executed.

Fix all failures introduced by this implementation.

Separate unrelated pre-existing failures clearly.

## 29. Acceptance criteria

The implementation is complete only when:

- Existing direct-file imports still work.
- M3U8 is detected without relying only on its extension.
- A master playlist exposes selectable variants.
- Automatic quality selection works deterministically.
- A finite media playlist imports successfully.
- Segments are downloaded through the secure application fetcher.
- FFmpeg never fetches the original remote URLs directly.
- Every playlist, segment, map, and permitted key URI receives SSRF validation.
- MPEG-TS HLS can be remuxed.
- Fragmented MP4 HLS can be remuxed.
- Separate default audio works or is rejected with a documented limitation.
- AES-128 works only within the declared safe scope.
- DRM and SAMPLE-AES are rejected.
- A live playlist requires an explicit bounded duration.
- Progress survives page refresh.
- Cancellation stops downloads and FFmpeg.
- Retry does not create duplicate files.
- The final output is verified before upload.
- The output is uploaded through the existing storage pipeline.
- The file appears in the selected virtual folder.
- Temporary data is cleaned.
- Signed URLs and encryption keys are not exposed.
- Existing Remote Import security controls remain active.
- Backend and frontend builds pass.
- Relevant automated tests pass.
- Docker images build successfully.

## 30. Final report

At the end provide:

1. Repository analysis.
2. Architecture implemented.
3. Direct-file versus HLS flow.
4. Manifest parser selected.
5. SSRF protections for nested resources.
6. Variant and audio selection behavior.
7. VOD behavior.
8. Live recording behavior.
9. Encryption and DRM policy.
10. FFmpeg and ffprobe integration.
11. Output-container behavior.
12. Database migration.
13. API changes.
14. Frontend changes.
15. Docker changes.
16. Files created and modified.
17. Tests added.
18. Commands executed and exact results.
19. Manual verification results.
20. Remaining limitations.

Do not introduce unrelated features or redesigns.

Do not claim HLS support is complete until an actual controlled M3U8 fixture has
successfully completed the full flow:

```text
probe
→ variant selection
→ segment download
→ local playlist creation
→ FFmpeg remux
→ ffprobe verification
→ provider upload
→ virtual filesystem registration
```
