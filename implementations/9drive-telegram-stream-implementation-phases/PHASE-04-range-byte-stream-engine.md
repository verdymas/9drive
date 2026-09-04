# Phase 04 — Telegram Byte-Range Streaming Engine

## Goal

Implement the core Telegram byte-serving engine using PyroFork/raw MTProto patterns learned from the references.

## Workflow

PLAN FIRST. Prove the selected PyroFork API/version and offset semantics before coding.

## Required Reads

Support:

```text
full read
start-end range
start-open-ended range
invalid range
```

## Data Plane

Conceptually:

```text
HTTP Range
  ↓
normalize start/end
  ↓
resolve Telegram file location
  ↓
offset + requested byte count
  ↓
upload.GetFile / appropriate PyroFork primitive
  ↓
yield chunks
  ↓
stop exactly at requested end
```

## Hard Requirements

Do NOT:

- download the whole file for a small range
- always start at byte 0
- Buffer.concat an entire media file
- return incorrect bytes under a 206 status

## Alignment

Audit Telegram offset/limit alignment requirements.

If needed:

```text
requested offset
→ aligned Telegram offset
→ fetch
→ trim prefix/suffix
→ emit exact HTTP bytes
```

## HTTP Semantics

Valid range:

```http
206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes START-END/TOTAL
Content-Length: LENGTH
```

Full read: 200 with correct length.
Invalid range: use standards-compatible behavior consistent with existing WebDAV, normally 416.

## Logical Metadata Separation

Do not require `9drive:path`, logical filename, or encrypted metadata to serve bytes.

## Tests

Use deterministic byte fixtures/mocks to verify exact first/middle/end/open-ended ranges, full read, invalid range, alignment trimming, missing file, stale reference refresh.

Record TTFB/bytes/duration hooks for later benchmark.
