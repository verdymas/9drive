# Teledrive Reference Analysis

Reverse-engineering analysis of the `references/teledrive` repository (read-only reference). Teledrive is a self-hosted web file manager that uses the user's private Telegram channel as blob storage. This document extracts reusable architectural concepts and maps them against 9Drive's existing architecture.

---

## 1. Architecture Overview

Teledrive is a **monorepo** with three workspaces plus docs:

| Workspace | Role |
|-----------|------|
| `apps/api` | FastAPI backend, SQLAlchemy async, Alembic, Pydantic, Uvicorn |
| `apps/web` | React / Vite / TanStack Query + Table frontend |
| `packages/shared` | Shared TypeScript types |

Processes (`npm run dev:full`): API, web UI, **Celery worker**, **Celery Beat**, and Redis (Docker). SQLite for local dev, PostgreSQL for production.

### Layered API-first design

```
Vite + React web UI
  -> HTTP API
    -> FastAPI routers + Pydantic schemas
    -> Auth + encrypted Telegram credential/session storage
    -> Drive metadata repository (SQLAlchemy)
    -> Storage adapter interface
      -> Local staging storage
      -> Telegram MTProto private-channel adapter
```

Two important architectural decisions:

1. **Telegram is only a storage transport.** The product is a file manager — no chat, contacts, groups, or messaging UI. It is "not a Telegram client."
2. **The web app never calls Telegram directly.** Every client (web, future mobile/CLI) goes through the same HTTP API, which owns the Telegram session.

### Key modules

- `app/api/*` — FastAPI routers: `auth.py`, `files.py`, `storage.py`, `server_files.py`, `system.py`, `webdav.py`.
- `app/core/*` — `config.py` (Pydantic settings), `database.py`, `security.py` (bcrypt/JWT/Fernet), `rate_limit.py`, `dependencies.py` (auth + CSRF).
- `app/models/*` — SQLAlchemy models (see section 4).
- `app/repositories/drive_repository.py` — single metadata repository with all drive CRUD + sync status transitions.
- `app/services/*` — `telegram_private_channel.py`, `telegram_credentials.py`, `sync_service.py`, `local_file_storage.py`, `deletion_service.py`, `manifest_service.py`, `server_files.py`, `mount_cache.py`, `worker_scheduling.py`, `text_editor.py`.
- `app/worker/tasks.py` — Celery tasks + Beat schedule.

---

## 2. Telegram Integration Approach

### Pure MTProto, user-account transport — no Bot API

Teledrive uses **Telethon over MTProto** with a *user account* (phone + OTP + optional 2FA), not a bot token. Every Telegram interaction is MTProto:

- `send_code_request(phone)` / `sign_in(...)` — auth code + 2FA
- `CreateChannelRequest` — lazily create the private channel
- `send_file(... force_document=True)` — upload document
- `iter_dialogs()` / `get_entity()` — find the storage channel
- `get_messages` / `download_media` / `iter_download` — read documents
- `delete_messages(revoke=True)` — delete documents

### Authentication flow (in-app wizard)

The API exposes a guided login state machine (`next_step`):

1. `PUT /auth/telegram-credentials` — store API ID + API Hash (Fernet-encrypted).
2. `POST /auth/telegram-login/start` — `send_code_request(phone)`; persist encrypted phone, `phone_code_hash`, and intermediate session → `next_step="code"`.
3. `POST /auth/telegram-login/verify` with `{code}` — `sign_in(phone, code, code_hash)`. On 2FA → re-save pending session → `next_step="password"`.
4. `POST /auth/telegram-login/verify` with `{password}` — `sign_in(password=...)` → `next_step="done"`.

State is serialized via Telethon's **`StringSession`** (`client.session.save()`) and encrypted per user between steps.

### Session handling

- Portable Telethon `StringSession` strings are stored **encrypted** on the `users` table.
- A fresh `TelegramClient` is created per operation from the session string and disconnected in `finally` — no long-lived connection.
- **Operator fallback:** if a user has not configured their own Telegram account, they transparently inherit operator-level `.env` credentials (`TELEGRAM_API_ID/HASH/SESSION`). Per-user encrypted credentials take precedence.

### Credential encryption

Two Fernet schemes in `core/security.py`:

- **App secrets** (API ID/HASH, session): Fernet keyed by `SHA-256(encryption_key)` — one key for all users.
- **Per-user manifests**: Fernet keyed by `HMAC-SHA256(encryption_key, "teledrive-manifest:<user_id>")` — recovery snapshots are only decryptable by the original application key.

Password hashing uses **bcrypt**; JWTs are `HS256`.

---

## 3. Upload Pipeline

Teledrive's upload is a **two-phase** model: stage locally, then sync to Telegram.

### Phase 1 — Local staging

`LocalFileStorage` (under `STORAGE_TEMP_PATH`) writes uploaded bytes to a temp object and returns a `local://<object_id>` remote id. `save_upload` reads in 1 MiB chunks with a byte cap (`teledrive_max_upload_bytes`, default 1 GiB); on error the partial file is unlinked.

### Phase 2 — Async sync to Telegram

- `POST /files/upload` stages the file, creates a `File` row with `local://` remote id and `sync_status="local"`, then either marks it `waiting_for_telegram_session` (if credentials absent) or enqueues a FastAPI background task `sync_uploaded_file`.
- `FileSyncService.sync_file` calls the Telegram adapter's `upload_document` (creating/reusing the private channel, `send_file(force_document=True)`), then `mark_synced` (swaps remote id to `telegram://<channel>/<msg_id>`) and **deletes the local staging object only after the mapping commits**.

### Chunk handling / retry

- **Upload:** streamed chunk-by-chunk to disk; there is no custom chunked/part-list protocol — Telegram MTProto handles upload resumption internally. Retry is at the *sync* stage, not byte-chunk granularity.
- **Sync retry:** files stuck at `local`/`waiting_for_telegram_session` are retried via the `POST /files/{id}/sync` endpoint or the worker.
- **Deletion retry** (separate): durable `deletion_jobs` with capped exponential backoff (max ~12 attempts, delay `min(3600, 2^attempt)`), Celery Beat sweeping every 60s, and stale-processing lease reclaim (300s timeout).

### Progress

Uploads report a synchronous HTTP response returning the created item; blob upload progress is not surfaced beyond staging. There is no segmented progress reporting to the client.

### Text-edit revision flow

Saving an edited file uploads a new Telegram document, then atomically switches the metadata mapping (`replace_file_content` with an optimistic `expected_revision` check; conflict → 409). The **prior** Telegram document is queued as a deletion job with durable retry.

---

## 4. Database Model

SQLAlchemy models (Alembic migrations, SQLite/PostgreSQL):

### `users`

- `id`, `email` (unique), `password_hash` (bcrypt), `is_operator` (first user becomes operator)
- `drive_initialized`
- Telegram: `telegram_api_id_encrypted`, `telegram_api_hash_encrypted`, `telegram_session_encrypted`, plus transient login state `telegram_login_phone_encrypted`, `telegram_login_code_hash_encrypted`, `telegram_login_session_encrypted`
- `server_files_config_encrypted`
- timestamps

### `drive_items` — the unified files+folders table

- `id` (UUID string), `user_id` (indexed), `kind` `"file"|"folder"` (indexed), `name` (indexed), `parent_id` (nullable self-FK, indexed)
- `size`, `mime_type`
- **Telegram metadata:** `storage_provider` (default `"telegram-private-channel"`), `storage_remote_id` (`telegram://<channel>/<message_id>` or `local://...`), `storage_channel_name`
- **Sync state machine:** `sync_status` (`local|syncing|synced|failed|waiting_for_telegram_session|pending_upload`), `sync_error`
- `deleted_at` (soft delete = trash), timestamps

### `deletion_jobs`

- `id`, `user_id` (indexed), `remote_id`, `status` (`pending|processing|failed|completed`), `attempts`, `next_attempt_at` (indexed), `last_error`
- `UNIQUE(user_id, remote_id)` — one durable job per remote object

### `manifest_snapshots`

- `id`, `user_id` (indexed), `remote_id` (Telegram id of the encrypted snapshot), `content_encrypted`, `created_at`

### `app_settings`

- `key` (PK), `bool_value` — e.g. `registration_enabled`

### Relationships / design notes

- **Single self-referential tree** (`parent_id`) for both files and folders — no separate folder table.
- **Telegram remote identity** stored as a single URI string (`telegram://<channel_id>/<message_id>`) on each file row.
- No relational FK constraints between tables (all user-scoped by `user_id` filters); `DriveRepository` enforces ownership in code.
- `deleted_at` implements trash; permanent delete collects a subtree and enqueues Telegram deletion jobs.

---

## 5. File Indexing — How Telegram Messages Become Files

Two directions:

1. **Forward (upload → Telegram):** uploads map a DB file row to a Telegram document via `send_file`; the returned `message.id` becomes `storage_remote_id`.

2. **Reverse (import/recovery):** `TelegramPrivateChannelStorage.list_documents()` calls `iter_messages(channel)` and synthesizes file records from each message's document:
   - filename from `DocumentAttributeFilename` (falls back to `telegram-document-<id>`)
   - `size` and `mime_type` from the document
   - `remote_id` built as `telegram://<channel_id>/<message_id>`

The reverse scan is used only for **recovery/import** (flat "Recovered from Telegram" folder), because Telegram documents carry no folder information — the original directory tree cannot be reconstructed from the channel alone.

The **primary source of truth for the file tree is the database**, not the channel. `DriveRepository` maintains the tree; the manifest system persists it encrypted.

---

## 6. Download / Streaming Flow

### Read path

`GET /files/{id}/download` branches on the remote id:

- **`telegram://`** → `StreamingResponse(telegram_storage.download_document_stream(...))`, which uses `client.iter_download(message.media, request_size=512 KiB)` and yields chunks (media_type from the file's mime_type, proper `Content-Disposition`).
- **`local://`** → `FileResponse` streaming straight from the staging path.

### No dedicated proxy

There is no separate download-proxy service. The API directly streams Telegram bytes to the client over MTProto. This is a **pull-through** model: cold reads always come from Telegram.

### Caching (WebDAV mount cache)

`MountCacheService` is a **local blob cache** (keyed by drive item id, separate from upload staging) used only by the WebDAV mount (Roadmap V2). Keyed by item id as `{safe-id}.bin`, atomically written via temp file + rename, and **evicted LRU by `atime`** when total exceeds `teledrive_mount_cache_max_bytes` (default 2 GiB). Cold reads hit Telegram; recent files served from cache.

### `.zip` download

`POST /files/download-zip` stages a `.zip` on the local storage root with a size cap (`teledrive_max_archive_bytes`, default 2 GiB), dedupes names, and streams it back with a background task that deletes the temp archive after the response.

---

## 7. Folder Virtualization — How Telegram Storage Becomes a Drive

Telegram is a **flat blob store**: a private channel of documents with no hierarchy. Virtualization happens entirely in the database:

- `drive_items` with `kind="folder"` form a self-referential `parent_id` tree — folders are **pure metadata** with no Telegram presence (`storage_remote_id = NULL`, only the channel name is stored).
- Files point at Telegram remote ids but the *location in the tree* is purely a DB concern; moving a file/folder just updates `parent_id` (no Telegram object moves).
- A virtual `Inbox` folder is seeded for a new user.
- `resolve_path` walks the tree by `name` per segment (no actual Telegram entity resolution).

This is a clean **logical/physical split**: the drive tree is DB-only; Telegram is a dumb content-addressed document store.

---

## 8. Error Handling

### Provider readiness

`TelegramPrivateChannelStorage.status()` returns a `StorageStatus` (`connected/ready/details`). Uploads check readiness and mark files `waiting_for_telegram_session` instead of failing hard when credentials are absent.

### Telegram API limits

- Auth endpoints are rate-limited in FastAPI (`slowapi`): telegram-login start 5/min, verify 10/min, register 5/min, login 10/min, upload 30/min, etc.
- `FloodWaitError` is surfaced to the user with the Telegram-required wait (`429`).
- Deletion jobs use **capped exponential backoff** (`min(3600, 2^attempt)`) across up to 12 attempts.

### Failed uploads

- Staging failures unlink partial files and raise.
- Sync failures set `sync_status="failed"` + `sync_error` and are retryable via `POST /files/{id}/sync` or the worker.
- Failed Telegram deletes are re-queued; a `?reconcile=true` path filters out jobs whose documents are already gone (keeping UI aligned with the channel).

### Reconnect / resilience

- Every MTProto operation opens a fresh client from the encrypted session string, so a dropped connection is naturally recovered on the next call.
- `deletion_jobs` use a **lease** (`PROCESSING_LEASE_SECONDS=300`): a crashed worker's `processing` rows are reclaimed as `failed` and retried.
- Manifest snapshot scheduling uses Redis keys (`scheduled`/`pending`) for **dedupe and coalescing** — a re-queued snapshot replaces the pending one rather than stacking.

### Recovery / disaster resilience

Teledrive stores an **encrypted metadata manifest** (`.teledrive-manifest.v1.enc`) inside the same Telegram channel, written on mutations via the worker, retaining the newest and queuing obsolete ones for deletion. This enables **restore after DB loss**:
- restore → decrypt + `restore_manifest_items` (recreates the full tree in one transaction)
- fallback → flat `import_documents` scan into "Recovered from Telegram" (no hierarchy)

**Key caveat:** the manifest is encrypted with the app `ENCRYPTION_KEY` — losing/changing it makes snapshots unreadable.

---

## 9. WebDAV Mount (Roadmap V2)

Exposes the virtual drive at `/dav/` with HTTP Basic or Bearer auth. Uses the local mount cache for reads/writes; cold reads pull from Telegram. Not block storage — intended for documents/media/archives, not active databases. rclone-compatible.

---

## 10. Comparison with 9Drive Architecture

### 10.1 Storage Adapter

| Aspect | Teledrive | 9Drive |
|--------|-----------|--------|
| Abstraction | `TelegramPrivateChannelStorage` single adapter + `LocalFileStorage`; `create_server_files_storage` switches local vs SFTP | `StorageProtocol` interface (`backend/src/modules/storage/storage-protocol.ts`) for **network daemons** (SMB); file data plane is a provider switch (Google/S3) |
| Scope | Adapter covers blob IO only (store/delete/list/download) | `StorageProtocol` is about protocol daemons; file IO via `files/stream-google-file.ts` + S3 |
| Folder virtualization | DB-only tree, adapter has no folder concept | `FolderStorageLocation` maps one virtual folder to 0..n physical homes per account |

**Concept worth adapting:** Teledrive's *provider readiness* (`status()`) surfaced to upload placement, and the `local://` staging remote id → provider remote id swap, mirror 9Drive's `local`/`pending_upload` file status. 9Drive is richer here (multi-account placement, materialization).

### 10.2 Remote Import

Teledrive has **no remote-import feature**; it imports only from its own Telegram channel (recovery). 9Drive's `remote-imports/` module (URL/HLS pipeline + `secure-fetcher`) is far more advanced and has no Teledrive equivalent. Teledrive's `server_files` (local + SFTP) is the closest analog to a "bring your own storage" surface.

### 10.3 Worker Relay

Teledrive uses **Celery + Redis**: Beat for periodic sweeps (deletion retry), queued `sync_file`/`snapshot_manifest` tasks, and `schedule_deletion_retry` with countdown. 9Drive's **Worker Relay** (`remote-fetch-workers/`, HMAC-signed versioned wire protocol, driver registry, direct/Cloudflare transports) is a distinct, more sophisticated concept — a remote fetch relay rather than an internal job queue. 9Drive also has an internal worker for its own queues.

**Concept worth adapting from Teledrive:** the **durable deletion/retry job table with lease-based stale reclaim and capped exponential backoff** (`deletion_jobs`) and **coalesced snapshot scheduling** via Redis keys — clean patterns 9Drive could apply to provider cleanup or manifest/sync side-effects.

### 10.4 File Browser

| Aspect | Teledrive | 9Drive |
|--------|-----------|--------|
| Frontend | React/TanStack Query, dense ops-console UI | React 19 + Vite, `AllFilesPage.tsx` with URL-param state (`folderId`, `q`) |
| Navigation | `parent_id` tree, `resolve_path` | query-param-driven folder navigation |
| Virtualization | DB-driven tree; no heavy client virtualization | **Not virtualized** on the frontend (full page loads); Teledrive also not virtualized |
| Storage status | UI shows `storage_status` (Telegram readiness) | UI shows connected-account quota (`QuotaTrackerPage`) |

9Drive's file browser is comparable; the main gap in both is client-side list virtualization (neither implements paged/infinite-scroll trees). Teledrive's **clear "storage ready or waiting" state surfacing** is a nice UX pattern.

### 10.5 Permission System

| Aspect | Teledrive | 9Drive |
|--------|-----------|--------|
| Model | Single operator; no sharing/permissions beyond operator gating (`require_operator`), CSRF + HttpOnly-cookie sessions | `FileShare` (public token + tokenHash + expiry), `FilePreviewToken` (hashed), `WorkspaceInvite` (inviter/invitee/target/role), public routes, provider "anyone" perms |
| Enforcement | Owner-scoped by `user_id` | Ownership `userId`-scoped; invite role enforcement not fully wired into browsing |
| Sessions | JWT in HttpOnly cookie + CSRF token | JWT bearer (in `localStorage` via auth.ts) + refresh |

Teledrive is much simpler — single-operator alpha, no multi-tenant sharing. 9Drive's permission system is strictly more developed (public tokens, invites, roles). Not suitable to port directly; Teledrive offers nothing 9Drive lacks here except the **HttpOnly-cookie + CSRF** session hardening pattern (9Drive stores JWTs in `localStorage`, a known XSS surface).

---

## 11. Features Worth Adapting for 9Drive

1. **Durable deletion/job queue with lease reclaim + capped exponential backoff.** `deletion_jobs` pattern (status, attempts, `next_attempt_at`, `PROCESSING_LEASE_SECONDS`, reconcile-vs-channel) is directly applicable to Google Drive/S3 object cleanup after virtual deletions. 9Drive's sync already has generation markers; adding a durable, retryable provider-delete ledger would harden cleanup.

2. **Storage readiness surfacing in the UI.** Teledrive's `storage_status` (`waiting_for_telegram_session`) is a clean way to tell the user why uploads are pending. 9Drive could surface `reauth_required`/disconnected accounts in the upload flow similarly.

3. **Encrypted metadata recovery manifest.** Storing an encrypted, per-user-keyed snapshot of the virtual tree *inside the provider* gives DB-loss recovery. 9Drive's virtual tree is richer (`FolderStorageLocation`), so a manifest would need to serialize locations too — but the concept (app-key-bound encryption + retain-newest + flat import fallback) is worth adapting as a backup/restore feature.

4. **Optimistic-concurrency text edit (revision check → 409).** 9Drive could adopt this for its text editor/files to prevent silent overwrite conflicts.

5. **Atomic staging→provider swap with cleanup-after-commit.** Teledrive's rule "delete local staging only after the remote mapping commits" is a solid consistency invariant; 9Drive's upload placement should ensure provider bytes are committed before any temp/checksum state is dropped.

6. **Coalesced worker side-effect scheduling** (Redis `scheduled`/`pending` keys) to avoid stacking redundant manifest/sync jobs.

---

## 12. Features NOT Suitable for 9Drive

1. **Telegram-as-storage (MTProto user channel).** 9Drive's model is Google Drive/S3 accounts with real quota, folders, and sharing. Replacing/adding Telegram blobs adds MTProto complexity, per-user phone/session management, 2 GiB file caps (Telegram limit), and flat-storage semantics — not aligned with 9Drive's multi-account, quota-driven, synchronized storage model.

2. **Single-operator / `is_operator` gating + Server Files (local + SFTP).** 9Drive is a multi-tenant, Google-OAuth-driven product. The operator-only local/SFTP server-files surface conflicts with 9Drive's connected-account model and unprivileged-upload security posture.

3. **Local file staging on disk.** Teledrive stages every upload to local disk before async sync. 9Drive streams directly to the provider (`Busboy` → Google Drive, "never store on disk"). Direct streaming is strictly better for 9Drive and should be preserved.

4. **Custom per-user Telegram auth wizard (phone/OTP/2FA).** 9Drive uses standard Google OAuth; a phone/OTP MTProto login reintroduces a whole credential class 9Drive avoids.

5. **The `drive_items` single-table for both files and folders.** 9Drive's split `Folder` + `FolderStorageLocation` + `File` model is more normalized and supports multi-homed virtual folders; reverting to a single tree table would be a regression.

6. **Login session via HttpOnly cookie is fine, but the whole async background "stage then sync" flow** is not — 9Drive already synchronously confirms provider placement on upload, which is the stronger guarantee.

---

## 13. Recommended Adaptation Plan (for 9Drive)

1. **Adopt the durable provider-delete ledger.** Add a `deletion_jobs`-style table (`(userId, provider, remoteId)` unique, status/attempts/`nextAttemptAt`/`lastError`, 300s processing lease) and a sweep job with capped exponential backoff. Wire permanent deletes, trash-empty, and file-replace into it alongside the existing sync missing-reconciler. Reconcile against the provider to remove already-gone objects.

2. **Add storage-readiness surfacing.** Extend connected-account status surfaced to the upload flow so `reauth_required`/disconnected accounts explain pending uploads, mirroring Teledrive's `waiting_for_telegram_session`.

3. **Design an encrypted recovery manifest** serializing `Folder` + `FolderStorageLocation` + `File` rows, app-key-bound (per-user HMAC Fernet like Teledrive), storing the newest snapshot and a flat-import fallback. Gate it behind existing backup primitives rather than shipping full restore initially.

4. **Introduce optimistic-concurrency for content edits** (revision check → 409) to prevent lost updates in the text editor and file overwrite paths.

5. **Adopt the coalesced worker-scheduling pattern** (Redis keys) for manifest/sync side-effects so redundant jobs collapse, reducing load on Google Drive APIs.

6. **Do not** port Telegram transport, local staging, operator/SFTP server files, or the unified drive_items table — 9Drive's direct-streaming, multi-account, OAuth model is the superior fit and should remain the foundation.

---

## Appendix — Reference Files

Teledrive key files (read-only reference, `references/teledrive`):

- Backend: `apps/api/app/api/{files,auth,storage,server_files,webdav}.py`, `apps/api/app/services/{telegram_private_channel,telegram_credentials,sync_service,local_file_storage,deletion_service,manifest_service,mount_cache,worker_scheduling}.py`, `apps/api/app/repositories/drive_repository.py`, `apps/api/app/models/{drive_item,user,deletion_job,manifest_snapshot,app_setting}.py`, `apps/api/app/core/{security,config,dependencies}.py`, `apps/api/app/worker/tasks.py`.
- Docs: `docs/architecture.md`, `README.md`, `DESIGN.md`.

9Drive comparison targets: `backend/src/modules/storage/storage-protocol.ts` (Storage Adapter), `backend/src/modules/remote-imports/` (Remote Import), `backend/src/modules/remote-fetch-workers/` (Worker Relay), `frontend/src/pages/AllFilesPage.tsx` + `layouts/DriveLayout.tsx` (File Browser), `backend/src/modules/{files,public,invites}/` (Permission System), `backend/prisma/schema.prisma` (schema).
