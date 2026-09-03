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
- `backend/src/modules/telegram/telegram-index.service.ts` — recovery index that
  scans channel history and imports unknown documents without deleting anything.
- `backend/src/modules/telegram/telegram.routes.ts` — mounted in `app.ts`; auth
  start/verify, channel list/create/select, connection test, index.
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

## Database changes

- `TelegramStorageConfig` (`telegram_storage_configs`) — per-account encrypted
  API ID/Hash + `StringSession`, plus the resolved storage channel
  (`channelId`, `channelTitle`).
- `TelegramAuthState` (`telegram_auth_states`) — short-lived wizard state
  (encrypted creds, intermediate session, `phone_code_hash`, TTL 15 min).
- `StorageAccount.fileCount` (`file_count`) — indexed file count used by
  placement/routing eligibility and the usage UI.

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
- `POST /telegram/accounts/:accountId/index` — non-destructive recovery index of
  the channel history.

Connected accounts surface Telegram via the shared serializer:
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
3. In both cases the channel is capability-probed (read/write/delete) before it
   is persisted. A failed probe aborts with `TELEGRAM_CHANNEL_VALIDATION_FAILED`
   or `TELEGRAM_CHANNEL_READ_ONLY` — the previous channel (if any) stays in
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
- Virtual folders remain database-only — `provider-folder.service.ts` treats
  Telegram as a virtual flat store (no physical folder creation/rename/delete).
- Sync (`/sync/all`, `/sync/account/:id`) completes Telegram accounts as a
  **no-op**: the DB is authoritative, and the missing-reconciler must never run
  against channel history (documents without a DB row are simply not indexed
  yet). Recovery happens only through the explicit index route.

## Upload / download flow

- **Multipart** (`POST /uploads`): the Telegram branch buffers the file to
  `UPLOAD_TEMP_DIR`, calls `uploadTelegramDocument`, creates a provisional
  `File` row, and flips it active on success.
- **Resumable** (browser path — the frontend always uses this): chunks stage to
  `UPLOAD_TEMP_DIR` with offset validation; the status route reports staged
  bytes as the offset; the final chunk calls `finalizeNonGoogleUpload`, which
  uploads to the channel and commits the DB row.
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
- Reauth-required Telegram accounts fail placement and sync with the shared
  `GOOGLE_REAUTH_REQUIRED` code (message is provider-aware) so the existing
  frontend reconnect special-case keeps working.
- Temp staging files are removed after commit; failed uploads clean up their
  staged bytes.

## Security considerations

- API ID/Hash, `StringSession`, and auth-state fields are encrypted at rest
  (`TOKEN_ENCRYPTION_KEY`).
- Sessions/codes/passwords never cross the API boundary or logs.
- Remote IDs are validated before parsing; delete is a batched remote-id delete
  scoped to the owning account.
- No shell commands, no user input in command construction.

## Tests performed

- `telegram.service.test.ts` — remote-id round-trip, channel-id normalization,
  error classification (8 tests).
- `telegram-auth.service.test.ts` — fresh-connect validation (API ID/Hash
  required, positive integer API ID, phone required).
- `telegram-usage.service.test.ts` — indexed-only usage, zero-usage case.
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

- Durable retry/queue for Telegram uploads (currently the caller retries).
- Channel pre-warm/parallel part uploads for very large documents.
- Optional per-file size autosplit for files over the cap.
- Telegram usage caching to avoid per-request aggregates.
