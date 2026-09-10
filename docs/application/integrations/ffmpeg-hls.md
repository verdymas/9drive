# Integration: FFmpeg + HLS

## Purpose
Remote Import can probe HLS master/media playlists, select variants/audio tracks, materialize segments, and remux them into the final media container.

## Core Files
`backend/src/modules/remote-imports/hls/`, especially:

- `manifest-service.ts`, `manifest.ts`
- `selection.ts`
- `segments.ts`, `segment-validator.ts`
- `materializer.ts`
- `ffmpeg.ts`
- `output.ts`
- `pipeline.ts`

## Runtime
The worker requires `ffmpeg` and `ffprobe`; executable paths are controlled by environment variables.

## Guardrails
Manifest/playlist depth, variant count, segment count, segment bytes, concurrency, attempts, live-recording duration, key bytes, maximum height/bandwidth, and FFmpeg timeout are all bounded by environment configuration. Preserve this bounded-resource design when adding HLS capabilities.
