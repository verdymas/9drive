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
  no backslashes, no control characters.
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
  captions (25 tests).
- `telegram-caption.service.test.ts` — caption refresh no-op when matching,
  legacy-row no-op, missing-telegram-doc no-op, classified TELEGRAM_NETWORK
  on edit failure (7 tests).
- `telegram-ingest.service.test.ts` — by stable id, by providerFileId, no
  metadata → inbox, folder chain (`ensureFolderPathBySegments`), `joinLogicalPath`
  (10 tests).
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

## Future improvements

- Durable retry/queue for Telegram uploads (currently the current retries).
- Channel pre-warm/parallel part uploads for very large documents.
- Optional per-file size autosplit for files over the cap.
- Telegram usage caching to avoid per-request aggregates.
- A worker that watches new Telegram messages in real time and triggers an
  incremental ingest (the existing `index` / `import` paths are scan-based).