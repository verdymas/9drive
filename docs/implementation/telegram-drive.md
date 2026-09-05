# Telegram Drive Storage Provider

9Drive can use a Telegram account as a private storage provider. Files are
uploaded as documents into a private channel created by 9Drive, and the
database stays the source of truth for the virtual file tree — Telegram is
**flat blob storage**, not a folder hierarchy.

## Implemented architecture

- `backend/src/modules/telegram/telegram.service.ts` — MTProto client lifecycle
  and provider primitives: upload (local file → channel document), open/stream
  (channel document → readable stream), list, batch delete, channel
  resolve/normalize, error classification. Built on `teleproto` (the maintained
  GramJS-compatible fork of the archived `telegram` package).
- `backend/src/modules/telegram/telegram-auth.service.ts` — stepwise auth wizard
  (phone → OTP → optional 2FA) that ends with an encrypted `StringSession`
  stored on the account config. Supports **fresh connect** (API ID + API Hash
  from the wizard form) and **reconnect** (stored credentials reused).
  Authentication no longer creates or resolves a storage channel — that is a
  separate, explicit step (§3, §5).
- `backend/src/modules/telegram/telegram-channel.service.ts` — explicit storage
  channel setup: list candidate private channels, create a new private channel,
  or select an existing one. Every selection is capability-probed (read/write/
  delete) before it is persisted.
- `backend/src/modules/telegram/telegram-usage.service.ts` — indexed-only usage
  (`usedBytes` + `fileCount`); never a fake byte quota.
- `backend/src/modules/telegram/telegram-metadata.ts` — encoder / parser /
  normalizer for the 9Drive caption metadata (stable id + logical path).
  Pure functions, no I/O. First source of truth for the caption format.
- `backend/src/modules/telegram/telegram-caption.service.ts` — wraps the
  Telegram `editMessage` call to refresh a document's caption after a
  rename/move on the 9Drive side. Builds the encoded caption via the
  metadata module. Best-effort: failures never roll back DB renames.
- `backend/src/modules/telegram/telegram-ingest.service.ts` —
  caption-driven ingest: scans the storage channel, parses each document's
  caption, reconciles the matching `File` row by `9drive:id` (stable
  identity) or `providerFileId` (physical identity), and updates the
  folder + filename from `9drive:path`. Documents without metadata are
  routed to the existing "Recovered from Telegram" inbox.
- `backend/src/modules/telegram/telegram-index.service.ts` — recovery index
  that delegates per-document reconciliation to `ingestTelegramDocument`.
  Caption lookup is skipped for documents that already have a physical
  row (legacy ingest path) and only fetched when an unrecognised
  document is discovered.
- `backend/src/modules/telegram/telegram.routes.ts` — mounted in `app.ts`;
  auth start/verify, channel list/create/select, connection test, index,
  caption-driven `import`, and per-file `sync-caption`.
- `backend/src/modules/files/file-logical-path.ts` — walks the virtual
  folder ancestry to produce the `9drive:path=Projects/APP-V/docs/architecture.md`
  form used in captions. Pure helper, no DB writes.
- Storage routing (`upload-placement.service.ts`, `storage-routing.service.ts`)
  treat Telegram like S3: an unlimited provider (`provider: null`) with a
  per-file document cap. A Telegram account is only routable once a storage
  channel is configured — channel-less accounts are excluded from automatic
  routing, batch planning, and manual pins (`TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED`).
- Uploads (`upload.routes.ts`) stream through the backend: multipart buffers to
  a temp file for the Telegram branch; the browser resumable path stages chunks
  to `UPLOAD_TEMP_DIR` and finalizes on the last chunk. Files are never stored
  on disk beyond the temp staging step.
- Downloads/streams dispatch to `openTelegramDocument` in the stream dispatcher;
  batch ZIP downloads and folder-level physical deletes have Telegram branches.

## 9Drive metadata in Telegram messages

9Drive treats the Telegram channel as a mirror/import channel — the **9Drive
DB is the authoritative logical filesystem**. To survive re-uploads, channel
moves, and filename changes, every Telegram storage document carries a
caption with the 9Drive identity of the file:

    9drive:id=<stable-file-id>
    9drive:path=Projects/APP-V/docs/architecture.md

The metadata rules (single source of truth — see
`implementations/9drive-telegram-path-metadata-prompts/README.md`):

- **9Drive is the authoritative logical filesystem.** The DB is the source
  of truth; the caption is metadata, not a filesystem.
- **Telegram Topics are NOT mapped one-to-one to 9Drive folders.** Topics
  are out of scope; the whole design is folder-agnostic.
- **Filename remains the actual filename.** The filename stored in the
  Telegram document attribute is independent of the logical path.
- **`9drive:id` is stable identity.** Two Telegram messages with the same
  `9drive:id` always refer to the same 9Drive file, regardless of channel,
  message id, or filename.
- **`9drive:path` is the logical location.** The final path segment is the
  filename in 9Drive; the rest is the folder chain.
- **Telegram deletion must not automatically delete a 9drive file.** The
  ingest path is additive only — missing messages are skipped, never used
  to soft-delete rows.
  *(Opt-in: TELEGRAM_SYNC_TRASH_MISSING=true soft-deletes a row on the first full scan that finds its message gone. Default preserves this rule.)

### Stable identity — `File.telegramStableId`

The `File` table gains a nullable `telegram_stable_id` (Prisma
`@@index([userId, telegramStableId])`). This is the DB column that mirrors
the `9drive:id=` caption field. It is independent of `providerFileId`
(which is the **physical** identity — the Telegram message id in the
channel). Legacy rows stay null; the first ingest that meets a
`9drive:id=` caption stamps it.

### Caption format

- One caption per document, ≤ 1024 chars (Telegram's caption limit).
- First line: `9drive:id=<stableId>` — `<stableId>` matches
  `[A-Za-z0-9._-]{1,36}` (UUIDs fit).
- Second line, when location is known: `9drive:path=<logicalPath>`.
  The path is NFC-normalized, slash-joined, no leading/trailing slash,
  no backslashes, no control characters. `.`/`..` segments are rejected
  (a path such as `../../outside/file.mkv` is treated as malformed and
  routed to the inbox — it can never escape the user's 9Drive root,
  spec §8/§21). The encoder likewise omits the path line when it
  contains a `.`/`..` segment.
- Extra lines (user-written notes, descriptions) are preserved verbatim
  in the caption; the parser keeps them in `extraLines`.
- Duplicate `9drive:id=` fields in one caption: first wins; later ones
  are dropped and counted in `diagnostics.idReason = 'duplicate'`.
- Malformed metadata is never thrown — it is routed to the inbox.

### Stable identity, logical path, filename — distinct concepts

| Concept       | DB column                  | Telegram caption field |
| ------------- | -------------------------- | ---------------------- |
| Stable id     | `File.telegramStableId`    | `9drive:id=`           |
| Logical path  | `File.folderId` + name     | `9drive:path=`         |
| Filename      | `File.name`                | document attribute     |
| Physical id   | `File.providerFileId`      | `telegram://channel/msg` |

Filename is the **actual filename** — never the logical path with `/`
replaced by something else. Renames/moves update `File.name` and
`File.folderId` independently; the caption is refreshed accordingly.

### Ingest (Telegram → 9Drive)

The caption-driven ingest lives in `telegram-ingest.service.ts`:

1. Parse the caption via `telegram-metadata`.
2. On `9drive:id=` hit: find the existing `File` row by
   `(userId, telegramStableId)` and reconcile `name`, `folderId`,
   `mimeType`, `sizeBytes`, `providerFileId`.
3. On `9drive:path=` hit only (no id): find the row by
   `providerFileId` and stamp `telegramStableId` if absent.
4. With no metadata at all: place the document in the existing
   "Recovered from Telegram" inbox folder.

`POST /telegram/accounts/:accountId/import` runs the full scan. It is
idempotent: re-running with the same channel state yields no DB writes.

### Export (9Drive → Telegram)

When a 9Drive file lives on a Telegram account, the upload path writes
the caption with `9drive:id=<stableId>` and the encoded
`9drive:path=<logicalPath>`. The stable id is the file's UUID — generated
once at upload time and stable for the file's whole lifetime. A re-upload
reuses the same id.

### Caption refresh (rename / move)

`PATCH /files/:id` and `POST /files/batch` (when the folder changes)
invoke `updateTelegramDocumentCaption` best-effort: the DB commit is the
source of truth, a Telegram edit failure logs and never blocks the
response, and the next `import` reconciles any drift. Telegram path /
rename is DB-only — there is no Drive API call (the existing
Telegram-as-flat-store invariant is preserved).

`POST /telegram/files/:fileId/sync-caption` is the explicit on-demand
caption refresh — resolves the current logical path from the DB and
calls `editMessage`. No-op when the caption already matches.

### Deletion safety in both directions

- **9Drive file deletion does NOT delete the Telegram message.** The
  soft-delete path (`DELETE /files/:id`, `DELETE /files/batch`) keeps
  the message intact. Only the explicit "permanent delete" path
  (`DELETE /files/batch/permanent`) calls `deleteTelegramDocuments`.
- **Telegram message disappearance does NOT delete the 9Drive file.**
  The ingest path is additive only; the next scan skips a missing
  remoteId. A 9Drive file stays present even after the Telegram message
  is manually deleted, with `providerFileId` pointing to a now-stale
  reference. Permanent delete is the only way to reconcile.
  *(Opt-in: TELEGRAM_SYNC_TRASH_MISSING=true trashes a row on the first full scan that flags it missing. Off by default.)

### No Topic-to-folder mapping

The whole design is folder-agnostic. Telegram Topics (forum topics) are
not used; they cannot be created or selected by 9Drive on the user's
behalf. Logical folders are derived exclusively from `9drive:path=` in
the caption; the storage channel is a flat list of documents.

## Database changes

- `TelegramStorageConfig` (`telegram_storage_configs`) — per-account encrypted
  API ID/Hash + `StringSession`, plus the resolved storage channel
  (`channelId`, `channelTitle`).
- `TelegramAuthState` (`telegram_auth_states`) — short-lived wizard state
  (encrypted creds, intermediate session, `phone_code_hash`, TTL 15 min).
- `StorageAccount.fileCount` (`file_count`) — indexed file count used by
  placement/routing eligibility and the usage UI.
- `File.telegramStableId` (`telegram_stable_id`) — nullable column mirroring
  the `9drive:id=` caption field; index `files_user_telegram_stable_id_idx`
  on `(user_id, telegram_stable_id)`. No backfill: legacy rows stay null
  until the first ingest that meets a caption stamps them.

Migration is generated offline (`prisma migrate diff` old→new schema) and
follows the repo's fixed-timestamp migration convention.

## API endpoints

All under the authenticated Telegram router:

- `POST /telegram/auth/start` — `{ accountId? | phone, apiId?, apiHash? }`.
  Fresh connect requires `apiId` + `apiHash`; reconnect reuses stored
  credentials. Returns `{ authId, nextStep: 'code' }`.
- `POST /telegram/auth/verify` — `{ authId, code? }` or `{ authId, password? }`.
  OTP success may return `{ nextStep: 'password' }` when 2FA is enabled; final
  success returns `{ nextStep: 'done', account }` (account serializer with
  `telegram: { channelId, channelTitle, status }` — `status` is
  `storage_channel_required` until a channel is configured).
- `GET /telegram/accounts/:accountId/channels` — list the account's dialogs
  that qualify as storage-channel candidates (broadcast private channels only;
  never Saved Messages, personal chats, or groups).
- `POST /telegram/accounts/:accountId/channel` — `{ action: 'create', title? }`
  or `{ action: 'select', channelId }`. Creates a new private channel or uses an
  existing one, capability-probes it (read/write/delete), and persists it as the
  account's storage destination. Doubles as "Change Channel". Fails loudly with
  `TELEGRAM_CHANNEL_VALIDATION_FAILED` / `TELEGRAM_CHANNEL_READ_ONLY` /
  `TELEGRAM_CHANNEL_IN_USE` when the channel is unusable or bound elsewhere —
  never silently switches destination.
- `POST /telegram/accounts/:accountId/test` — validates the saved connection:
  `getMe`, channel resolve, plus read/write/delete capability checks. Returns a
  structured `{ ok, status, checks, message }` payload.
- `POST /telegram/accounts/:accountId/index` — non-destructive recovery index
  of the channel history (legacy safety net for documents without metadata).
- `POST /telegram/accounts/:accountId/import` — caption-driven ingest; reads
  every caption and reconciles by 9Drive identity. Body `{ limit?: number }`.
  Returns `{ scanned, matched, updated, created, inboxed, skipped }`.
- `POST /telegram/files/:fileId/sync-caption` — on-demand caption refresh
  from the current logical path. Body `{ path?: string }` (default:
  resolve from DB). Returns
  `{ ok, channelId, messageId, previousCaption, nextCaption, changed }`.

Connected accounts surface Telegram surface via the shared serializer:
`telegram: { channelId, channelTitle, status }` on `GET /connected-accounts`,
`PATCH /connected-accounts/:id`, and the auth-wizard `done` payload. Quota
fields (`totalBytes`/`availableBytes`) are `null`; `usedBytes` and `fileCount`
are the only meaningful usage numbers.

## Authentication flow

1. Wizard collects phone + (fresh) API ID + API Hash; `start` creates an
   intermediate `TelegramAuthState`, calls `client.sendCode`, persists the
   `phone_code_hash` and intermediate session (encrypted).
2. User submits the OTP; the client invokes `Api.auth.SignIn`. A
   `SessionPasswordNeededError` advances the state to `awaiting_password` and
   the wizard requests the 2FA password (via `signInWithPassword`).
3. On success the connected account is created or reused, the encrypted
   `StringSession` is stored, the auth state is deleted, usage is synced, and an
   audit event (`telegram.connect` / `telegram.reconnect`) is written. The
   account starts with **no storage channel** (`telegram.status =
   storage_channel_required`); the user configures one next.

Credentials, sessions, codes, and passwords are never returned to the client and
never logged.

## Storage channel setup

1. After authentication the account is unusable for storage until a private
   channel is configured. Uploads, routing, batch planning, and storage-summary
   totals all exclude channel-less Telegram accounts; manual pins fail fast with
   `TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED`.
2. The channel wizard (`POST /telegram/accounts/:id/channel`) offers **Create
   new** (a fresh broadcast channel titled `TELEGRAM_STORAGE_CHANNEL`, default
   `9drive`, or a custom title) and **Use existing** (picked from
   `GET /telegram/accounts/:id/channels`, which lists only broadcast private
   channels — Saved Messages, personal chats, and groups are never candidates).
3. In both cases the the file is capability-probed (read/write/delete) before it
   is persisted. A failed probe aborts the upload — the previous channel (if any) stays in
   place, and the destination is never silently switched.
4. A channel already bound to another of the user's accounts fails with
   `TELEGRAM_CHANNEL_IN_USE` (enforced by the unique `providerAccountId`).
5. `POST /telegram/accounts/:id/test` runs the full check: `getMe`, channel
   resolve, read/write/delete. The result drives the status vocabulary
   (`ready` / `error` / `storage_channel_required` / `authentication_required` /
   `connected`).

## Storage flow

- Every connected Telegram account stores in exactly one private channel chosen
  explicitly by the user (created by 9Drive or selected from existing dialogs).
- Physical identity of a file is `remoteId = telegram://<channelId>/<messageId>`.
- Logical identity of a file is `telegramStableId` (mirrors `9drive:id=`).
- Virtual folders remain database-only — `provider-folder.service.ts` treats
  Telegram as a virtual flat store (no physical folder creation/rename/delete).
- Sync (`/sync/all`, `/sync/account/:id`) completes Telegram accounts as a
  **no-op**: the DB is authoritative, and the missing-reconciler must never run
  against channel history (documents without a DB row are simply not indexed
  yet). Recovery happens through the explicit `index` or `import` routes.

## Upload / download flow

- **Multipart** (`POST /uploads`): the Telegram branch buffers the file to
  `UPLOAD_TEMP_DIR`, stamps `telegramStableId = <fileUuid>` on the provisional
  `File` row, resolves the current logical path via `logicalPathForFileId`,
  encodes the caption with `buildInitialCaption`, calls `uploadTelegramDocument`
  with the encoded caption, and flips the row `active` on success. The caption
  carries the file's identity on the very first upload.
- **Resumable** (browser path — the frontend always uses this): chunks stage to
  `UPLOAD_TEMP_DIR` with offset validation; the status route reports staged
  bytes as the offset; the final chunk calls `finalizeNonGoogleUpload`, which
  uploads to the channel (with the same caption logic) and commits the DB row.
- Placement: automatic routing includes Telegram (provider pool
  `['google_drive', 's3', 'telegram']`); a Telegram account is excluded until a
  storage channel is configured. The per-file document cap
  (`TELEGRAM_MAX_FILE_BYTES`, default 2 GiB) is enforced in the planner's
  eligibility and in manual-pin placement (`TELEGRAM_FILE_TOO_LARGE`). Manual
  pins ignore Auto Allocation but still quota/cap/channel check strictly.
- Downloads and previews stream through `openTelegramDocument`; batch ZIP
  downloads pull from the same primitive.

## Remote Import integration

- `processor.ts` `uploadTempFile` dispatches Telegram uploads (temp file →
  `uploadTelegramDocument`).
- Quota-sync dispatch points call `syncTelegramUsage` for Telegram accounts.
- Remote Import destination selection is independent from worker selection, and
  Telegram appears as a valid destination in the frontend selector.

## Usage calculation

Indexed-only, computed from active `File` rows per account:

- `usedBytes` = `SUM(sizeBytes)` of active files.
- `fileCount` = count of active files.

`totalBytes` and `availableBytes` stay `null`. The Quota Tracker renders "Files"
and "Total Stored Size" for Telegram and never shows Available Size, Total
Capacity, Quota, or a percentage. Channel-less Telegram accounts are hidden
from the Quota Tracker and the sidebar/filter storage lists; `/storage/summary`
excludes them from its totals too.

## Retry / error handling

- `classifyTelegramError` maps MTProto failures to stable JSON error codes:
  revoked/unauthorized sessions → `TELEGRAM_SESSION_INVALID` (401), flood waits
  → `TELEGRAM_FLOOD_WAIT` (429, retryable), invalid API credentials →
  `TELEGRAM_CREDENTIALS_INVALID`, missing documents → `TELEGRAM_FILE_NOT_FOUND`
  (404), generic failures → 502.
- Metadata-specific errors: `TELEGRAM_METADATA_INVALID` (400) for malformed
  captions or paths that the encoder cannot round-trip.
- Reauth-required Telegram accounts fail placement and sync with the shared
  `GOOGLE_REAUTH_REQUIRED` code (message is provider-aware) so the existing
  frontend reconnect special-case keeps working.
- Temp staging files are removed after commit; failed uploads clean up their
  staged bytes.
- The caption refresh is best-effort: a Telegram edit failure logs a
  `telegram.caption_update` audit row and a structured `console.error` but does
  not roll back the 9Drive rename. The next `import` reconciles any drift.

## Security considerations

- API ID/Hash, `StringSession`, and auth-state fields are encrypted at rest
  (`TOKEN_ENCRYPTION_KEY`).
- Sessions/codes/passwords never cross the API boundary or logs.
- Remote IDs are validated before parsing; delete is a batched remote-id delete
  scoped to the owning account.
- Stable ids in captions are not secrets — they're the file's UUID, which is
  already exposed elsewhere in the app — but they are not logged either.
- No shell commands, no user input in command construction.

## Tests performed

- `telegram.service.test.ts` — remote-id round-trip, channel-id normalization,
  error classification (8 tests).
- `telegram-auth.service.test.ts` — fresh-connect validation (API ID/Hash
  required, positive integer API ID, phone required).
- `telegram-usage.service.test.ts` — indexed-only usage, zero-usage case.
- `telegram-metadata.test.ts` — encoder/parser round-trip, deep paths, Unicode,
  CRLF handling, duplicate-key diagnostics, malformed inputs, oversized
  captions, path-traversal rejection (`.`, `..`) in the parser, normalizer,
  encoder, and `buildLogicalPath` (28 tests).
- `telegram-caption.service.test.ts` — caption refresh no-op when matching,
  legacy-row no-op, missing-telegram-doc no-op, classified TELEGRAM_NETWORK
  on edit failure (7 tests).
- `telegram-ingest.service.test.ts` — by stable id, by providerFileId, no
  metadata → inbox, folder chain (`ensureFolderPathBySegments`), traversal guard
  (never creates `.`/`..` folders), `joinLogicalPath` (11 tests).
- `file-logical-path.test.ts` — pure ancestry walker + DB-backed
  `logicalPathForFileId` (4 tests).
- `storage-routing.test.ts` — Telegram never receives a file over the document
  cap; S3/Telegram plan with `provider: null`; channel-less Telegram accounts
  are excluded from automatic routing, batch planning, and manual pins.
- `upload-placement.test.ts` — manual Telegram pin over the cap →
  `TELEGRAM_FILE_TOO_LARGE`; manual pin on a channel-less account →
  `TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED`; channel-configured pin proceeds.
- `sync-boundary.test.ts` — Telegram accounts complete as a no-op with zero
  provider writes and no missing cleanup.
- Full backend build (`tsc`) and the complete backend test suite pass.
- Frontend builds (`tsc && vite build`).

## Known limitations

- **No live smoke test** — a real Telegram account is required for the wizard
  (OTP/2FA), channel creation/selection, capability probing, and a real
  upload/download round trip; this environment had no credentials, so the MTProto
  network path is verified only by unit tests and the build.
- **No live DB migration run** — the offline-generated migration has not been
  applied to a running MySQL (no local credentials available); `prisma migrate
  deploy` should be exercised in the target environment.
- Telegram has no quota API; the 2 GiB default cap matches free-account
  document limits but must be tuned (`TELEGRAM_MAX_FILE_BYTES`) for premium
  accounts or provider changes.

## Telegram Synchronization

Synchronization reconciles the configured Telegram storage channel
against the 9Drive database. The DB is authoritative for the logical
filesystem — the channel is a mirror — so the sync NEVER deletes data.
The reconciliation ledger is a separate, append-only set of tables
(`telegram_sync_state`, `telegram_sync_runs`, `telegram_sync_issues`).

### Architecture

```
POST /telegram/sync                         ─ AutoSyncService (setInterval)
                │                                   │
                ▼                                   ▼
         enqueueTelegramSync ─── BullMQ queue ─── runTelegramSync
                │           (telegram-sync)        │
                ▼                                   ▼
                                       scanChannel ── reconcile ── issues
                                       (per-account lock, single-flight)
```

The orchestrator lives in `backend/src/modules/telegram/telegram-sync.service.ts`.
The worker lives in `telegram-sync.worker.ts` and is registered in the
API process on boot. The queue + dedup are in `telegram-sync.queue.ts`.
The periodic sweeper is in `telegram-sync.scheduler.ts`.

### Source of truth

9Drive is the source of truth for logical paths, folders, filenames,
ownership, and metadata. Telegram is the source of truth for message
existence, message ids, file identity, file size, and message metadata.
The sync reconciles the two in this order (spec §11):

1. **Physical identity** — match by `providerFileId`
   (`telegram://<channelId>/<messageId>`). High confidence; the
   channel + message id is globally unique and immutable.
2. **`9drive:id` caption** — the strongest logical identity. A row
   keyed on `(userId, telegramStableId)` is matched, then the
   `9drive:path` caption is used to **verify / correct** the
   destination folder. Existing files in the recovery folder are
   moved to the correct location; never duplicated.
3. **`9drive:path` caption only** — match by `providerFileId`,
   then use the path to position the row. Missing folders in the
   chain are auto-created.
4. **Recovery folder** — genuine last resort. Used when no
   `9drive:id` / `9drive:path` is present, when the path is
   malformed, or when traversal is detected. Never used merely
   because a folder does not exist or the file is currently in
   another folder.

The sync never assumes two files are identical based on filename
alone (spec §7).

### Caption reading on full sync

The full-sync path (`runTelegramSync` → `scanChannel` → `classifyOne`)
fetches the caption for **every orphan** document (a Telegram doc with
no matching `providerFileId`) and passes it to the caption-driven
ingest service. This mirrors the recovery `POST /telegram/accounts/:id/import`
endpoint. A transient caption fetch failure (network, FloodWait) is
swallowed and falls back to the no-caption behaviour (recovery inbox).

### Per-document structured log

For every orphan the sync emits one `[telegram-sync]` info log line
with the shape:

```json
{
  "event": "telegram.sync.document",
  "runId": "...",
  "accountId": "...",
  "remoteId": "telegram://<channel>/<message>",
  "matchStrategy": "9drive_id" | "9drive_path" | "recovered" | "none",
  "virtualPath": "Movies/Anime/file.mkv" | null,
  "pathResolution": "success" | "failed",
  "parentFolderId": "..." | null,
  "fileId": "..." | null,
  "action": "created" | "updated" | "matched" | "inboxed",
  "reason": "missing_metadata" | "unresolvable_path"   // only on recovery
}
```

The log never includes session strings, API hashes, OTPs, or other
authentication secrets. Operators can grep `[telegram-sync]` to follow
exactly how each Telegram document was resolved.

### Per-strategy statistics

The `TelegramSyncRunSummary` and `telegram.sync` audit log payload
include three additional counters that break down how orphan documents
were resolved:

- `matchedByIdCount` — caption had a `9drive:id` that matched an
  existing row.
- `matchedByPathCount` — caption had only a `9drive:path` (no id) that
  the ingest service used to position the row.
- `recoveredCount` — landed in the "Recovered from Telegram" inbox
  (no metadata, malformed path, or path traversal).

The existing per-run counters (`scannedCount`, `matchedCount`,
`importedCount`, etc.) are unchanged.

### Initial sync

When a Telegram Drive account connects for the first time, the
`TelegramSyncState` row is absent. The first `runTelegramSync` call
sees `last_message_id = null` and scans the entire channel
(`min_id = 0`). Subsequent runs advance the cursor to the highest
seen message id. Orphan Telegram documents (no matching DB row) are
routed through the caption-driven ingest service: documents with
`9drive:id` update by logical identity, documents with
`9drive:path` are positioned by the path (creating missing folders),
and documents with no usable caption are placed in the "Recovered
from Telegram" inbox folder.

### Incremental sync

`TelegramSyncState.last_message_id` is the pagination cursor. Every
run reads it and resumes at `min_id = last_message_id`. The cursor
advances to `max(page.maxId)` after every page. The next run sees
only the documents added since the previous run completed.

### Full resync

`POST /telegram/sync` accepts `{ full: true }` to ignore the cursor
and rescan the entire channel. The Telegram side never returns
deleted messages, so a full resync is also the safest way to confirm
that the cursor hasn't drifted (e.g. a manual cleanup of the
channel).

### Orphan handling

A Telegram document with no matching `File` row in the DB is an
**orphan**. The sync reads the orphan's caption and routes it through
the caption-driven ingest service:

- `9drive:id` matches an existing row → update by logical identity
  (recompute folder chain from `9drive:path`).
- `9drive:path` only → match by `providerFileId`, then position the
  row by the path. Missing folders in the chain are auto-created.
- No usable caption → import into the "Recovered from Telegram" inbox
  folder.

The run summary surfaces orphans as `importedCount` / `orphanCount`
plus the per-strategy breakdown (`matchedByIdCount`,
`matchedByPathCount`, `recoveredCount`). The user reviews the run via
`GET /telegram/sync/runs`.

### Missing remote handling

A `File` row whose Telegram message no longer exists (the message was
manually deleted in Telegram, or the channel was re-created) is
flagged as a `REMOTE_FILE_MISSING` issue. The 9Drive row is NEVER
deleted by the sync — the user can resolve the discrepancy via the
existing 9Drive-side permanent-delete flow
(`DELETE /files/batch/permanent`), which removes both the 9Drive
row and the Telegram message. **No automatic re-upload** happens on
missing-remote (spec §13).

**Opt-in auto-trash:** with `TELEGRAM_SYNC_TRASH_MISSING=true`, a row
whose message is absent from a full scan is soft-deleted — moved to
Trash, never hard-deleted, recoverable via
`POST /files/batch/restore`. The trash step requires a *clean* scan
(`stats.errorCount === 0`): Pass 1 swallows per-document errors and
continues, so a row absent only because its page errored must not be
mistaken for a deleted message. Such a run still flags the issue but
withholds the soft-delete. Full scans only — an incremental run has
no complete view of the channel. The flag is off by default; the
spec's never-delete rule is the default behavior.

### Conflict handling

A DB row whose Telegram metadata (size / mimeType) disagrees with the
current channel state is flagged as a `TELEGRAM_METADATA_MISMATCH`
issue. The user reviews via
`GET /telegram/accounts/:accountId/sync-issues?kind=TELEGRAM_METADATA_MISMATCH`
and resolves via `POST /telegram/sync-issues/:id/resolve`. Sync
NEVER auto-resolves a conflict.

### Reconciliation rules (spec §26)

| DB row                     | Telegram message                  | Outcome                |
| -------------------------- | --------------------------------- | ---------------------- |
| exists, matches            | exists, matches metadata          | `matched`              |
| exists, matches | no Telegram message              | `REMOTE_FILE_MISSING` |
| no DB row                  | exists                            | `imported` (inbox)     |
| exists, mismatched metadata| exists                            | `TELEGRAM_METADATA_MISMATCH` |

### Retry behavior

- `client.iterMessages` errors are classified by
  `classifyTelegramError`. FloodWait waits the requested seconds and
  retries up to `TELEGRAM_SYNC_FLOOD_WAIT_RETRIES` times per page.
- Transient errors (TELEGRAM_NETWORK, FLOOD_WAIT) abort the run with
  status `sync_failed` and surface the last error. NO files are
  marked missing on transient errors (spec §25).
- A failed run releases the single-flight guard so the next manual
  or automatic sync can retry.

### Automatic sync

A `setInterval`-based sweeper runs every
`TELEGRAM_SYNC_INTERVAL_MINUTES` minutes (default 30, range 15–720).
It enqueues a sync for each connected Telegram account whose state
row's `last_scan_at` is older than the interval, OR has status
`never_synced`. Disabled by setting
`TELEGRAM_SYNC_AUTO_ENABLED=false`. The sweeper is `unref()`'d so it
never holds the process open, and is gated by an `inFlight` flag so
overlapping ticks never enqueue duplicate jobs.

### Manual sync

`POST /telegram/sync` enqueues a BullMQ job. The response carries the
job id and the queue status (`queued` or `already_queued` when a job
for the same `(accountId, trigger)` is in flight). The UI polls
`GET /telegram/sync/runs?accountId=...` and
`GET /telegram/accounts/:accountId/status` to render the spinner,
final state, and the "3 synchronization issues" link to the review
view.

### Usage calculation

Telegram sync uses the same indexed-only model as uploads:
`usedBytes` and `fileCount` are derived from active `File` rows.
No quota (`totalBytes` / `availableBytes`) is ever shown — sync
never invents a quota (spec §23). The connected-account serializer
extends the `telegram:` block with sync-only fields:

```ts
telegram: {
  channelId, channelTitle, status,
  syncStatus,          // never_synced | syncing | up_to_date | changes_detected | needs_attention | sync_failed
  lastSyncAt,          // ISO string of last_scan_at
  openIssuesCount,     // unresolved issues for the "Review" badge
}
```

### HTTP surface

- `POST /telegram/sync` — body `{ accountId, full? }`; returns
  `{ status, jobId, queued }`.
- `GET /telegram/sync/runs?accountId=&limit=` — recent runs for the UI
  history list.
- `GET /telegram/accounts/:accountId/status` — single status card:
  `{ status, lastMessageId, lastScanAt, errorCode, errorMessage,
  lastRun, openIssuesCount, liveJobId, knownStatuses }`.
- `GET /telegram/accounts/:accountId/sync-issues?kind=&limit=` —
  unresolved issues for the "Review" panel.
- `POST /telegram/sync-issues/:id/resolve` — mark an issue
  `resolvedAt = now()`.
- `POST /telegram/sync-issues/bulk-resolve` — body `{ accountId,
  kind? }`; resolves every matching unresolved issue in one call.

### Sync status vocabulary

|Status            | Meaning                                                       |
|------------------|---------------------------------------------------------------|
|`never_synced`    | No sync attempt yet.                                          |
|`syncing`         | A run is in flight (also the lock value).                      |
|`up_to_date`      | LastRun found no changes (all matched).                       |
|`changes_detected`| LastRun found >0 imported orphans (no missing/conflicts).     |
|`needs_attention` | LastRun produced missing or conflict issues.                  |
|`sync_failed`      | LastRun errored (transient or permanent).                      |

### Concurrency protection

The single-flight guard is the atomic
`UPDATE telegram_sync_state SET status = 'syncing' WHERE id = ? AND
status != 'syncing'` transition. If the row already has `status =
'syncing'`, zero rows are affected and the service throws
`SYNC_ALREADY_RUNNING` (409). The same guard is applied in the
BullMQ producer via deterministic job ids
(`${accountId}~manual` / `${accountId}~auto`) — BullMQ dedups on
jobId, so two concurrent enqueues result in one queued job
(`{ status: 'already_queued' }`).

### Rate limiting

- `client.iterMessages(channel, { min_id, limit: 100 })` — Telegram
  caps responses at ~100/page; the env-controlled
  `TELEGRAM_SYNC_PAGE_SIZE` is the upper bound.
- `TELEGRAM_SYNC_CONCURRENCY` (default 2) is reserved for future
  parallel-page support; the current implementation processes one
  page at a time (pages are sequential to keep the cursor monotonic).
- FloodWait is respected per page; the retry budget is
  `TELEGRAM_SYNC_FLOOD_WAIT_RETRIES` (default 3).

### Tests performed

- `telegram-sync.service.test.ts` — initial sync (10 orphans → 10
  inbox imports), incremental sync (only documents after cursor),
  orphan detection, missing-remote detection (with soft-delete
  exclusion), metadata-mismatch detection, single-flight guard
  (`SYNC_ALREADY_RUNNING`), transient API failure (no files marked
  missing), `GOOGLE_REAUTH_REQUIRED` for reauth-required accounts,
  pagination safety (multi-page, short-page termination).
- `telegram-sync.queue.test.ts` — deterministic job ids, dedup on
  `jobId`, single-flight per `(accountId, trigger)`, graceful close.
- `telegram-sync.scheduler.test.ts` — sweep enqueues only eligible
  accounts, respects the syncing guard, respects the interval,
  idempotent `start` / `stop`.
- All pre-existing tests remain green (77 files, 1001 tests).

## Metadata protection (encrypted captions + opaque filenames)

Optional, off by default. When enabled, the Telegram document filename becomes
`tg_<hex>.bin` (HMAC-SHA256 of the immutable file id) and the caption carries an
AES-256-GCM `9drive:meta=v1:...` payload instead of a readable `9drive:path=`.

- Crypto lives in `telegram-crypto.service.ts`; cache read/write and the sync
  fast path in `telegram-metadata-cache.ts`; the user-facing utility in
  `telegram-security.service.ts` + `telegram-security.routes.ts`.
- `File` caches `encryptedMetadata`, `metadataFingerprint`, `cryptoVersion`,
  `physicalFilename` (all nullable — Google/S3 rows are unaffected).
- Reads never decrypt: downloads, WebDAV, and Jellyfin resolve by
  `providerFileId` and read names from the DB.
- Sync compares the caption's ciphertext to the cached copy; identical means no
  decryption at all. Unreadable payloads become `TELEGRAM_METADATA_UNREADABLE`
  sync issues and never abort a run.
- Legacy `9drive:path` captions keep working; migration is opt-in per file.

Full guide: `docs/implementation/telegram-metadata-security.md`.

## Future improvements

- Key rotation for `TELEGRAM_METADATA_MASTER_KEY` (v1 has none by design; the
  format's version tag reserves room for a dual-key scheme).
- Durable retry/queue for Telegram uploads (currently the current retries).
- Channel pre-warm/parallel part uploads for very large documents.
- Optional per-file size autosplit for files over the cap.
- Telegram usage caching to avoid per-request aggregates.
- A worker that watches new Telegram messages in real time and triggers an
  incremental ingest (the existing `index` / `import` paths are scan-based).