# Phase 03 — Captured Resource → Remote Import

Integrate Browser Capture with the existing Remote Import pipeline. Do not create a second downloader.

First inspect and plan the current Remote Import DTO/schema, probe, Worker selection, DirectRemoteFetchTransport, CloudflareRemoteFetchTransport, HLS, FFmpeg/remux, upload, queues, progress, retries, and errors.

When a captured resource is selected, show:
- filename
- destination folder/storage
- Direct or registered Worker
- optional safe captured request context

Create a secure action conceptually accepting:
- capturedResourceId
- filename
- destination
- workerId|null

Load the captured resource server-side; do not trust a client-submitted URL when an ID exists.

Reuse generic Worker resolution:
workerId=null → Direct
workerId!=null → Worker registry → driver → RemoteFetchTransport

No Cloudflare-specific logic in Browser Capture.

Forward only an allowlist of useful request context such as Referer, Origin, User-Agent, Range, and selected negotiation headers. Never blindly forward all browser headers.

For HLS, use the existing HLS pipeline. The extension never downloads or remuxes segments.

Filename priority:
1. explicit user filename
2. captured filename
3. Content-Disposition
4. page title
5. existing Remote Import logic
6. safe fallback

Mark the captured resource imported/consumed according to existing UX.

After creation, show Remote Import status/details.

Tests:
- PDF
- MP4
- HLS
- Direct
- Worker
- filename override
- destination
- expired/invalid resource
- ownership
- headers
- no direct fallback when Worker is explicitly selected

Do not use Playwright.
