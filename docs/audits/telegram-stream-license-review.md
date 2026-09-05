# License Review — Telegram Stream Implementation

This document is the Phase 12 deliverable: a license review of the
reference projects consulted during the design of `telegram-stream`.

## Conclusion (TL;DR)

**No source code was copied from any reference repository.** The
implementation re-implements the same architectural patterns
(byte-range → MTProto offset mapping, FILE_REFERENCE refresh, FloodWait
handling, session reuse across ranges, disconnection cancellation,
throughput telemetry) **independently**, in TypeScript/Node.js for the
gateway and Python for the byte engine. The byte reads themselves go
through Telethon's own `iter_download`, an MIT-licensed upstream
dependency, not through any reference's code. The references are
read-only and live under `references/`. There is no import, no
vendoring, no patching, and no shared code path.

## Reference projects reviewed

| Reference | License | Source consulted for | Code copied? |
|---|---|---|---|
| `references/telegram-stremio` | AGPL-3.0 | FastAPI data plane, `upload.GetFile` byte-range mapping, `ByteStreamer` prefetch pattern, `custom_dl.py` | **No.** Patterns re-implemented independently; the shipped engine uses Telethon's own `iter_download` rather than a hand-rolled chunk loop, and the prefetch prototype was deleted unused. |
| `references/tgfs` | AGPL-3.0 | Range → Telegram offset mapping, multi-part `part_sizes` walk | **No.** 9Drive's files are single-document per `File` row, so the part-walk is unnecessary. |
| `references/telegram-drive-webdav` | Mixed (Tauri/Rust; repo has multiple components) | WebDAV Range/206/seek behavior | **No.** The implementation reuses 9Drive's existing WebDAV server. |
| `references/teledrive` | AGPL-3.0 | Telethon `StringSession`, FastAPI WebDAV, per-user encrypted storage | **No.** 9Drive keeps its own GramJS/teleproto stack and its own storage layout. |

## Why this matters

The references are all **copyleft** (AGPL-3.0, with at least one
component under a different license). Because the implementation does
not import or vendor any of their code, 9Drive's source tree is
unaffected by the references' license terms. A 9Drive operator can
delete the entire `references/` directory without changing the
behavior or licensing of the project.

## What was independently re-implemented

The following patterns appear in **multiple** open-source projects
(telegram-stremio, tgfs, teledrive, telegram-drive-webdav) and are
therefore **unprotectable by any single license**. Each is either
reimplemented fresh in `services/telegram-stream/app/telegram/` or
delegated to Telethon:

- `upload.GetFile(location, offset, limit)` — an MTProto API call, not a
  copyable code unit. The shipped engine reaches it through Telethon's
  own `iter_download`; 9Drive writes no `GetFile` loop of its own.
- Bounded `asyncio.Queue` prefetch with ordered output — a generic async
  pattern. A ~120-line implementation existed as a prototype and was
  **deleted unused** when `iter_download` proved sufficient; no such code
  ships.
- Stale `FILE_REFERENCE` refresh — handled by dropping the cached
  location so the next range re-fetches the message (`FileResolver` +
  `engine.iter_bytes`). The `FileResolver` is the only implementation in
  this repo; no code was lifted from any reference.
- FloodWait mapping — `engine._classify` turns Telethon's
  `FloodWaitError` into a `429` with the wait in the message. No regex on
  error strings, no retry loop: an isinstance check on the library's own
  exception type.
- Disconnection cancellation — Starlette throws `CancelledError` into the
  streaming generator; the `finally` block closes the download iterator.
  Framework primitives, no borrowed integration.
- Throughput telemetry — counted and emitted by `app/observability.py`,
  which has no upstream counterpart.

## What was NOT ported

The phase spec is explicit: "Do not port Stremio catalog / TMDB /
indexing / subscription features." None of these are present in the
9Drive tree. `telegram-stremio`'s MongoDB, its `multi_clients` /
`work_loads` registries, its `select_best_client` DC preference — all
out of scope. 9Drive has its own multi-account model
(`ConnectedAccount`) and the streaming service keys on
`providerId == connectedAccountId`.

`tgfs`'s multi-part `part_sizes` walk is not needed: 9Drive's storage
model is one document per `File` row. The architecture doc (§6 of
`telegram-stream-architecture-audit.md`) explains this.

## What was added to 9Drive that is *not* in the references

- HMAC-SHA256 internal auth with a strict 30-second skew window and
  Range-in-canonical-string (a deliberate defense against post-signature
  Range tampering).
- Header ownership split between the streaming service and the 9Drive
  backend (Content-Range vs Content-Type/ETag/Last-Modified).
- The `GET /telegram/stream/credentials/:id` control plane plus the
  GramJS→Telethon session repack (`telethon-session.ts`). No second
  session is stored: both formats carry the same four fields.
- A `webdav-no-decrypt.test.ts` regression: the WebDAV read path
  provably never loads the metadata crypto module.
- The `test_cross_side_contract.py` (Python) and
  `telegram-stream-auth.test.ts` (Node) cross-side tests that pin the
  canonical-string format and the HMAC digest shape. If either side
  changes its canonical string, both tests fail in lockstep —
  intentional, bilateral contract anchor.

## Audit trail

- `references/` is `.gitignore`-able in any downstream fork; deleting
  it does not change behavior.
- The implementation files are tracked in the main tree, not under
  `references/`. `git log` on the streaming service will show only
  9Drive-authored commits.
- The `telegram-stream` service depends on `telethon` (MIT), `cryptg`
  (MIT) and `fastapi` (MIT) and on no reference-clone code. Telethon is
  the same library `references/teledrive` happens to use; a shared
  upstream dependency is not shared code.

## Risk

The lowest risk is that an author of a reference repo later claims
that the patterns described in their documentation are themselves a
copyrightable creative work. The bar for that claim is high in
software copyright law (looking at the *expression*, not the
*function*; see *Google v. Oracle* and *Lotus v. Borland*). The
architectural patterns enumerated above are functional and unprotectable.
If, despite that, a claim is made, the response is straightforward:
demonstrate that no source was copied (this document, plus the
absence of imports in `services/telegram-stream/app/`).
