# Telegram Drive — Encrypted Filename / Metadata with Database Cache

Audit report and implementation plan. Scope: obfuscate the physical filename stored in Telegram, encrypt recoverable Telegram metadata, keep the 9Drive database canonical, cache the latest encrypted payload in the database, and provide an in-app Encrypt/Decrypt/Legacy-Conversion utility with manual-repair support.

This document is the deliverable of `implementations/telegram-drive-encrypted-metadata-cache-audit-plan.md` (AUDIT + DESIGN + PLAN only — no implementation was performed, and none is described as already done).

---

## A. Executive Summary

The current Telegram Drive implementation stores **plaintext** logical metadata on every Telegram document:

- Physical filename (Telegram `DocumentAttributeFilename`): the **logical 9Drive filename** (e.g. `episode-01.mkv`).
- Caption metadata: `9drive:id=<file-uuid>` and `9drive:path=<folder/file.ext>` as plaintext lines.

The database is already canonical for all normal reads (UI, WebDAV, Jellyfin, download) — Telegram metadata is only consulted by sync/recovery. That is exactly the architecture the target design requires. The work needed is therefore additive: an encrypted, versioned metadata format, a database cache for it, and crypto performed only at store/update/sync boundaries.

Key findings that shape the design:

1. **Upload already decouples display name from bytes source.** `uploadTelegramDocument` sends `DocumentAttributeFilename = opts.name` while `filePath` is only the staging file (`backend/src/modules/telegram/telegram.service.ts:511-516`). Obfuscating the physical filename requires **no provider change** — just pass a different `name`.
2. **The stable 9Drive file ID is known before the Telegram upload.** Both upload and remote-import create a provisional `File` row, stamp `telegramStableId = file.id`, resolve the logical path, build the caption, and only then upload (`backend/src/modules/uploads/upload.routes.ts:88-106`, `backend/src/modules/remote-imports/processor.ts:284-339`). The opaque physical filename can be keyed on the stable ID from the start.
3. **Caption editing already exists.** `updateTelegramDocumentCaption` → `client.editMessage` (`backend/src/modules/telegram/telegram-caption.service.ts:89-91`), fired best-effort after rename/move via `telegram-caption-refresh.ts`. Metadata migration (Mode B) and rename/move caption updates reuse it as-is.
4. **Read paths never consult Telegram metadata.** WebDAV PROPFIND/GET resolve purely from DB `Folder.name`/`File.name`; downloads resolve by `providerFileId = telegram://<channelId>/<messageId>`. The "zero decrypt on normal reads" requirement is already satisfied structurally — it must simply be preserved.
5. **One pre-existing gap, unrelated to crypto:** `streamProviderFileToReadable` (`backend/src/modules/webdav/webdav-virtual-fs.ts:406`) streams S3 and Google Drive only; a WebDAV GET on a Telegram file falls through to the Google branch and fails. Flagged for repair in Phase 10.

Recommended design: **HMAC-SHA256 opaque physical filename** (`tg_<opaque>.bin`), **AES-256-GCM encrypted metadata** (`9drive:meta=v1:<payload>`), master key with HKDF-derived subkeys, persisted ciphertext + fingerprint on the `File` row, legacy `9drive:path` fully supported, sync fast path by ciphertext equality, and a backend-driven in-app crypto utility.

Status of each area is itemized in the final summary (see end of this document).

---

## B. Current Store Flow

### B.1 Normal upload (multipart + resumable)

`backend/src/modules/uploads/upload.routes.ts` — `finalizeNonGoogleUpload` (lines 61-109), Telegram branch (lines 88-106):

```text
User upload (Busboy buffer)
  ↓
resolveUploadPlacement() → connected account + folder
  ↓
writeBufferToTemp(session.id) → <UPLOAD_TEMP_DIR>/<sessionId>.multi   (bytes source)
  ↓
prisma.file.create(providerFileId: 'pending', status: 'uploading')    ← 9Drive ID known here
  ↓
telegramStableId = provisionalFile.id   (File.id == telegramStableId)
  ↓
logicalPath = logicalPathForFileId(userId, fileId)     (DB folder ancestry)
  ↓
caption = buildInitialCaption(stableId, logicalPath)   → "9drive:id=…\n9drive:path=…"
  ↓
uploadTelegramDocument(config, { filePath: tmpPath, name: fileName, mimeType, sizeBytes, caption })
  → remoteId = telegram://<channelId>/<messageId>
  ↓
prisma.file.update(providerFileId: remoteId, status: 'active')
  ↓
temp file unlink (finally)
```

On upload failure the provisional row is soft-deleted (`status: 'deleted'`, `deletedAt`), so a failed upload never leaves an active orphan mapping.

Answers to the audit questions (§9 of the plan doc):

1. **Stable 9Drive ID known before upload?** Yes — provisional row created first; `id` is Prisma-generated UUID.
2. **Final logical filename known?** Yes — `fileName` from the upload session / record before upload.
3. **Final virtual path known?** Yes — `logicalPathForFileId` resolves folder ancestry before upload.
4. **Physical filename generated where?** `uploadTelegramDocument` uses `opts.name` (logical name) directly as `DocumentAttributeFilename`. No separate physical name exists today.
5. **Metadata generated where?** `buildInitialCaption` (`telegram-caption.service.ts:119`) → `encodeCaption` (`telegram-metadata.ts:139-167`).
6. **Can Telegram upload receive a physical filename different from the logical one?** Yes — `sendFile`'s `DocumentAttributeFilename` is independent of the bytes-source path; callers pass whatever string they want.
7. **Provider mapping persisted where?** On the `File` row itself: `providerFileId` (+ `telegramStableId`).
8. **Can encrypted metadata be persisted there without affecting other providers?** Yes — nullable columns on `File` are null for non-Telegram rows (see §E).

### B.2 Remote Import

`backend/src/modules/remote-imports/remote-import.service.ts` — filename resolution (line 107): explicit user name > probe-detected name > URL path segment > `download`, sanitized; HLS: `hlsFinalFileName` replaces `.m3u8`/`.m3u` with the output container extension (`.mkv` default).

`backend/src/modules/remote-imports/processor.ts` — `uploadTempFile` (lines 284-339) reproduces the **same** provisional-row → `telegramStableId` → logical path → `buildInitialCaption` → `uploadTelegramDocument` sequence as normal upload, for both Direct and Worker-relayed imports. For HLS imports (`processHlsImport`), the remuxed output (`output.<ext>.part`) is the bytes source, and the **user-supplied `record.fileName`** is the canonical upload name — pipeline-derived names (`video-000001.ts`, `output.mkv.part`) never reach Telegram.

**Finding:** the Telegram upload sequence is duplicated between `upload.routes.ts` and `processor.ts`. The crypto design must be centralized (single service) and both call sites must converge on it; do not duplicate crypto logic (plan §11).

### B.3 HLS / Remux

- Temp segments: `video-000001.ts` / `audio-000001.ts` (`hls/materializer.ts:52-71`).
- FFmpeg output: `<jobDir>/output.<ext>.part` (`hls/pipeline.ts:296`).
- Pipeline-derived display name (`hls/output.ts:57-62`) is **metadata-only**; the processor never uses it as canonical (`processor.ts:679-690`).

Crypto must use the final logical 9Drive identity (`record.fileName`, resolved path) — never temp/remux/container/URL-basename (plan §12).

---

## C. Current Physical Filename Flow

`uploadTelegramDocument` (`backend/src/modules/telegram/telegram.service.ts:497-529`):

```typescript
const sent = await client.sendFile(channel, {
  file: opts.filePath,                    // bytes source (temp staging file)
  caption,
  forceDocument: true,
  attributes: [new te.Api.DocumentAttributeFilename({ fileName: opts.name })],
})
```

- **Current physical filename source:** the logical 9Drive filename (`opts.name` → `fileName` from the upload record). Not a temp path, not a provider key.
- **Obfuscation insertion point:** callers already choose the string; crypto can substitute `tg_<opaque>.bin` for `name` while keeping `filePath` unchanged. No provider-layer change.
- **Downloads never match by filename:** all Telegram reads resolve by `providerFileId` → `parseTelegramRemoteId` → `client.getMessages({ ids: [messageId] })` → `iterDownload(message.media)`. Physical-name obfuscation cannot break download/WebDAV/Jellyfin/sync identity (plan §23, §51).

---

## D. Current Metadata Flow

### D.1 Serializer

`backend/src/modules/telegram/telegram-metadata.ts`:

- Keys: `9drive:id`, `9drive:path` (lines 26-27); stable-id regex `[A-Za-z0-9._-]{1,36}` (line 30); caption limit `TELEGRAM_CAPTION_MAX = 1024` (line 38).
- `encodeCaption` (lines 139-167): `9drive:id=<uuid>` first, then `9drive:path=<NFC-normalized path>`; drops the whole caption (returns null) on invalid stable id or oversize; preserves user `extraLines` when space allows.
- `encodePath` (lines 111-128): rejects `\0 \n \r / : * ?` and `.`/`..` segments; single-line ≤ 1024.

### D.2 Parser

`parseCaption` (lines 175-226): line-based (LF, CRLF-normalized), case-sensitive lowercase keys, first-wins on duplicates, structured `diagnostics` (id/path seen/kept/reason), `extraLines` preserved, never throws. Used by sync ingest and caption refresh.

### D.3 Caption edit / update

`backend/src/modules/telegram/telegram-caption.service.ts:89-91`:

```typescript
await client.editMessage(channel, { message: messageId, text: nextCaption })
```

Fired best-effort (fire-and-forget, errors swallowed) after rename/move by `backend/src/modules/telegram/telegram-caption-refresh.ts`, which resolves the current logical path, re-encodes, compares old vs new caption, edits if changed, and writes an audit log. DB update always happens first (synchronous); the Telegram edit never blocks the response.

### D.4 Size constraints

Full caption must stay ≤ 1024 chars. Worst-case `9drive:meta=v1:<payload>` line is ~300–450 chars (see §J.4) — fits comfortably; no constraint change needed.

---

## E. Current Database Mapping

Prisma (MySQL), `backend/prisma/schema.prisma`.

`File` model (lines 271-317) — relevant fields:

```prisma
id                 String   @id @default(uuid()) @db.Char(36)
userId             String
connectedAccountId String
folderId           String?
provider           String   // 'google_drive' | 's3' | 'telegram'
providerFileId     String   // THE provider mapping (single string, all providers)
name               String
mimeType           String
sizeBytes          BigInt
status             String   // 'uploading' | 'active' | 'deleted'
telegramStableId   String?  // dedicated Telegram column (precedent for new columns)
@@index([userId, telegramStableId])
```

- **One table, all providers.** For Telegram, `providerFileId = "telegram://<channelId>/<messageId>"`; for Google Drive it is the Google file ID. The `provider` discriminator determines interpretation.
- **No JSON/metadata column on `File`.** Telegram-specific data gets a dedicated nullable column (`telegramStableId`). The same pattern is the right home for the new cache fields.
- Telegram storage is **physically flat** (no folder hierarchy in the channel); folders are virtual, DB-only.

### E.1 Where the new cached fields belong (plan §52)

Nullable columns on `File`, following the `telegramStableId` precedent:

```prisma
physicalFilename     String?   // tg_<opaque>.bin  (or with extension when configured)
encryptedMetadata    String?   // v1:<base64url(iv):base64url(tag):base64url(cipher)>
metadataFingerprint  String?   // sha256 of canonical recovery metadata
cryptoVersion        String?   // 'v1' (null → legacy/plaintext)
```

`NULL` for all non-Telegram rows and legacy Telegram rows → Google Drive / S3 behavior and legacy rows are completely unaffected. No separate mapping table is warranted — the `files` table is already the mapping table. (No migrations were run during this audit.)

---

## F. Sync Flow

`backend/src/modules/telegram/telegram-sync.service.ts` (+ worker/queue/scheduler) and `backend/src/modules/telegram/telegram-ingest.service.ts`.

### F.1 Enumeration

`scanChannel` (line 359): paginated `client.iterMessages(channel, { min_id, limit })` in descending message-id order; cursor persisted in `TelegramSyncState.lastMessageId`; `full: true` resets to 0; FloodWait retried.

### F.2 Classification (`classifyOne`, line 489)

1. **Physical match:** remote ID (`telegram://<channelId>/<messageId>`) in pre-loaded `fileByProviderFileId` map. Size + mime match → `matched`. Size or mime mismatch → `conflict`.
2. **Orphan** (no physical match): caption fetched on demand (`fetchCaptionForRemoteId` → `client.getMessages`) → `parseCaption` → `ingestTelegramDocument`:
   - `9drive:id` → lookup by `(userId, telegramStableId)` → reconcile.
   - `9drive:path` only → lookup by physical identity `(userId, provider, providerFileId)`.
   - No metadata → inbox folder ("Recovered from Telegram").

`updateFromParsed` (`telegram-ingest.service.ts:202`): a differing caption path is treated as an **intentional rename/move** — updates `name`/`folderId`; size changes update `sizeBytes`. No conflict flag.

### F.3 Deletion detection

Pass 2 (lines 460-483): every pre-scan DB row not seen in `seenFileIds` → `REMOTE_FILE_MISSING` (soft-deleted rows excluded).

### F.4 State tables

- `TelegramSyncState`: cursor + status (`never_synced | syncing | up_to_date | changes_detected | needs_attention | sync_failed`).
- `TelegramSyncRun`: per-run stats.
- `TelegramSyncIssue`: append-only reconciliation issues; **already has `metadata Json?`** — the natural place to record crypto-related issues (wrong key, malformed payload) without new schema.

### F.5 Where the fast path integrates

In `ingestTelegramDocument` / `classifyOne` orphan path: after `parseCaption` returns `stableId` + `meta`, compare `meta` with `File.encryptedMetadata` before any decrypt (plan §18-§20, §45). Sync does not decrypt on the physical-match path at all (nothing new to check there).

---

## G. Read-Path Analysis

### G.1 WebDAV

Library: `webdav-server` v2.6.3. Custom get/head handlers (`backend/src/modules/webdav/webdav.routes.ts:34-130`); `VirtualFileSystem.resolvePath` (`webdav-virtual-fs.ts:143`) walks **DB `Folder.name` / `File.name` segments only** — never Telegram metadata. PROPFIND (custom `recursivePropfind` for Depth: -1, plus library default) reads DB names only. Read-only enforced (all write methods → 403).

**No decrypt on PROPFIND / HEAD / GET / Range GET — structurally guaranteed today; must be preserved.** Jellyfin is a WebDAV client (no plugin in this repo): discovers via PROPFIND, streams via GET + Range.

**Flagged pre-existing defect (unrelated to crypto):** `streamProviderFileToReadable` (`webdav-virtual-fs.ts:406`) handles `s3` and Google Drive only; a Telegram file falls through to the Google branch and fails. Fix in Phase 10.

### G.2 Jellyfin

No dedicated module. Comments in `webdav.routes.ts` confirm Jellyfin accesses 9Drive via the WebDAV endpoint. Logical filenames/paths come from the DB via the WebDAV VFS. No decrypt, no physical-name involvement.

### G.3 Normal download

`backend/src/modules/files/file.routes.ts:488` → `streamProviderFile` (`stream-file.ts`) → `streamTelegramFile` (`telegram.service.ts:590`): resolves by `providerFileId` only; Content-Disposition uses DB `file.name`. Range is **not** currently honored for Telegram streaming (full 200 always) — a pre-existing limitation worth fixing alongside Phase 10.

### G.4 Performance contract (plan §55)

| Path | Decrypts? |
|---|---|
| UI listing / search | No (DB only) |
| WebDAV PROPFIND / HEAD / GET / Range | No |
| Jellyfin playback / seek / resume | No |
| Normal download | No |
| Sync | Only when ciphertext is new/changed, legacy conversion requires it, or manual repair changed it |

---

## H. Rename / Move

`backend/src/modules/files/file.routes.ts` — PATCH `/files/:id` (lines 339-392):

1. DB update synchronous (`name`, `folderId`).
2. For Telegram: `void refreshTelegramCaption(...).catch(...)` — best-effort caption `editMessage` with the new logical path. Never blocks, never re-uploads content.

PATCH `/files/batch` (lines 98-170): same pattern. Folder rename/move (`backend/src/modules/folders/folder.routes.ts:182-282`): after DB update, refreshes captions for **all descendant Telegram files**.

Physical Telegram object, messageId, and displayed filename are never touched by rename/move.

**Implications for the target design:** the rename/move flow already has the right shape. It gains only: recompute `metadataFingerprint` → if changed, encrypt once → save ciphertext → include `9drive:meta` in the caption passed to `editMessage`. No content re-upload, no physical-name change (plan §24-§25).

---

## I. Existing File Migration

Current live state: **all** Telegram documents use plaintext `9drive:path` and plaintext logical filenames. Migration modes (plan §36):

- **Mode A — New files only (default).** New uploads/imports use opaque names + encrypted metadata. Nothing existing is touched.
- **Mode B — Metadata migration.** Rewrites captions `9drive:path` → `9drive:meta` via the existing `editMessage` path. No content change; works regardless of physical filename; safe because caption editing already exists and sync already reconciles caption drift. Per-file, explicit action (utility + "Update Telegram Metadata" affordance) or a controlled batch; never silent.
- **Mode C — Physical filename migration (optional, deferred).** Telegram allows editing message attributes in principle, but safe behavior across providers/clients is not assured; may require re-upload. **Not required** for metadata encryption. Deferred out of v1.

Legacy rows in the DB (`encryptedMetadata = NULL`) keep working indefinitely: parser priority handles both formats (§J.5), sync treats a null cache as "no cached ciphertext" and decrypts when `9drive:meta` is present, and the caption-refresh path can upgrade metadata-only when asked.

---

## J. Crypto Design

### J.1 Principles

- DB is the single canonical logical state; Telegram encrypted metadata is a **cached recovery representation** — never a second source of truth, never decrypted for routine reads.
- No custom cryptography; `node:crypto` primitives only.
- No plain hash for recoverable metadata (a hash is one-way). Obfuscation (filename) and encryption (metadata) are separate concerns.
- Base64 is not encryption.

### J.2 Physical filename obfuscation (plan §27-§28)

**Recommended: HMAC-SHA256(derived filename key, stable 9Drive file ID).**

```text
filenameKey = HKDF-SHA256(masterKey, salt, "9drive:telegram:filename:v1")
opaque      = HMAC-SHA256(filenameKey, file.id)            // 64 hex chars
```

- Format: `tg_<opaque>.bin` when `TELEGRAM_OBFUSCATE_FILE_EXTENSION=true` (default); `tg_<opaque>.<logical-ext>` when false (extension from DB `File.name`, never decrypted).
- Deterministic and **stable across rename and move** (keyed on file ID, which never changes).
- Exposes nothing about the original name.
- Alternatives considered and rejected: `HMAC(original path)` (changes on rename/move), random UUID (breaks determinism and rename-stability), encrypted filename (unnecessary complexity; filename need not be recoverable from Telegram — the DB and encrypted metadata hold the logical name).

### J.3 Encryption (plan §30)

**AES-256-GCM** via `node:crypto`, random 12-byte IV per encryption (never reused), 16-byte auth tag, versioned payload:

```text
payload = base64url(iv) ":" base64url(tag) ":" base64url(ciphertext)
caption = "9drive:meta=v1:" + payload
```

Matches the existing serialization convention in `backend/src/utils/crypto.ts` (AES-256-GCM, `iv:tag:ciphertext`), which is the single at-rest encryption primitive used throughout the codebase (tokens, sessions, provider configs) and should be mirrored or extended rather than reinvented. No ECB, no custom schemes.

### J.4 Key derivation (plan §31)

```text
TELEGRAM_METADATA_MASTER_KEY            (env secret, ≥ 32 bytes)
    ├── HKDF-SHA256(salt, "9drive:telegram:filename:v1")  → filename HMAC key (32 B)
    └── HKDF-SHA256(salt, "9drive:telegram:metadata:v1")  → AES-256-GCM key (32 B)
```

Salt from `TELEGRAM_CRYPTO_SALT` (non-secret, default `9drive-telegram-v1`). Master key is the real secret; the salt is not a substitute. Domain-separated HKDF (`crypto.hkdfSync`) means one master key feeds both subkeys without key reuse.

Size budget: plaintext ≈ `{name (≤255) + path (≤1024) + mime (≤191) + size}` JSON-escaped ≈ 1.5–2 KB worst case → AES-GCM ciphertext + iv + tag ≈ 2.1–2.6 KB → base64url ≈ **2.8–3.5 KB**... **exceeds the 1024-char caption limit for pathological paths.** Two mitigations, in order: (1) truncate the encrypted path at a safe cap and rely on DB reconciliation (path is recoverable in practice — sync only needs `name` + enough path to re-anchor), or (2) store `name`+`size`+`mimeType` in the encrypted payload and keep `path` plaintext-encoded in a **reduced** form — **do not fall back to that in v1**; keep the format clean, cap the plaintext, and document the tradeoff. The format version field (`v1`) lets a future payload layout evolve without breaking parsers.

### J.5 Metadata format + parser priority (plan §29, §35)

```text
9drive:id=abc123
9drive:meta=v1:<payload>
```

Decrypted payload (recovery-relevant fields only):

```json
{
  "name": "episode-01.mkv",
  "path": "Movies/Anime/One Piece/episode-01.mkv",
  "mimeType": "video/x-matroska",
  "size": 123456789
}
```

Parser priority (sync ingest, §45):

1. `9drive:id` (stable identity — unchanged, never encrypted)
2. `9drive:meta` (encrypted; decrypt only when it differs from the DB cache)
3. legacy `9drive:path` (plaintext — must keep working indefinitely)
4. safe recovery fallback (inbox)

`encodeCaption`/`parseCaption` gain a `9drive:meta` key alongside the existing two; `extraLines` handling and the 1024 limit are unchanged.

### J.6 Fingerprint (plan §6)

```text
metadataFingerprint = SHA-256("v1|" + fileId + "|" + normalizedPath + "|" + name + "|" + mimeType + "|" + sizeBytes)
```

Inputs: version, file ID, normalized logical path, logical filename, MIME type, size. **Not a security boundary** — it only drives cache invalidation and change detection. Rename/move change the fingerprint → re-encrypt once → update caption. No fingerprint change → no crypto work.

### J.7 Central service (plan §26)

`backend/src/modules/telegram/telegram-crypto.service.ts` — single implementation, used by store, remote import, sync, caption refresh, and the utility endpoints:

```text
deriveKeys()                    HKDF subkeys from master key + salt
generatePhysicalFilename(fileId)
buildRecoveryMetadata({name, path, mimeType, size})
calculateMetadataFingerprint(...)
encryptMetadata(plaintext)      AES-256-GCM, random IV
decryptMetadata(payload)        throws typed errors on tamper/wrong key/bad version
detectMetadataVersion(payload)
parseLegacyMetadata(caption)    delegate to telegram-metadata.ts
serializeTelegramCaption({stableId, meta, extras})  → 9drive:id + 9drive:meta
```

### J.8 Env additions (plan §32-§34)

`backend/src/config/env.ts` (zod), grouped under the existing Telegram section; `.env.docker.example` placeholders (this repo has no `.env.example`):

```env
# Telegram Drive metadata protection
TELEGRAM_METADATA_ENCRYPTION_ENABLED=false
TELEGRAM_METADATA_MASTER_KEY=
TELEGRAM_CRYPTO_SALT=9drive-telegram-v1
TELEGRAM_OBFUSCATE_FILENAME_ENABLED=false
TELEGRAM_OBFUSCATE_FILE_EXTENSION=true
```

Validation rules (zod `superRefine`): when encryption is enabled, master key must be present and ≥ 32 chars, else **fail safely** at startup — never auto-generate, never silently fall back to plaintext for new protected uploads. Master key never reaches the frontend, logs, or API responses; UI shows only `Configured / Not Configured / Invalid`. Docs warn: losing the master key makes encrypted Telegram metadata unrecoverable.

### J.9 Key rotation (plan §49)

Deferred to v2. The `v1` version field and HKDF domain labels let the format evolve. Document that rotation will require re-encryption + caption rewrite of protected rows (Mode B machinery).

---

## K. In-App Crypto Utility

Backend-driven only; the master key never leaves the backend (plan §37-§40, §44).

### K.1 Endpoints (authenticated via existing `requireAuth` — no RBAC exists; ownership checks per user)

```text
POST /api/telegram/security/encrypt
    { fileId?, name, path, mimeType?, size? } → { physicalFilename, telegramMetadata, encryptedPayload }
POST /api/telegram/security/decrypt
    { telegramMetadata | rawPayload }         → { version, fileId?, name, path, mimeType, size }
POST /api/telegram/security/convert-legacy
    { telegramMetadata }                      → { telegramMetadata }   // path → meta
GET  /api/telegram/security/status            → { encryption: configured|notConfigured|invalid, obfuscation: enabled|disabled }
```

### K.2 UI

Settings → Telegram Drive → Security:

- **Encryption status** / **Filename obfuscation status** (status chip only, never the key).
- **Encrypt utility**: inputs (ID, filename, virtual path, MIME, size) → outputs (physical filename, `9drive:meta` line, raw payload) with copy buttons.
- **Decrypt utility**: paste `9drive:meta=v1:...` or raw payload → shows version, ID, filename, path, MIME, size.
- **Legacy → Encrypted**: paste `9drive:id=…\n9drive:path=…` → produces `9drive:meta` line.
- **Update Telegram Metadata** (optional, per plan §43): explicit button on a Telegram file — verifies target message ownership (configured storage channel + configured account only), preserves the physical file, edits caption only, then re-runs sync semantics. Manual copy/paste remains a valid fallback; never edit personal chats / Saved Messages / unrelated channels.

### K.3 Manual repair workflow (plan §41-§42 — core acceptance criterion)

```text
1. Settings → Telegram Drive → Security → Crypto Utility
2. Enter correct 9Drive ID + original filename/path
3. Generate encrypted metadata → copy the 9drive:meta line
4. Manually edit the existing Telegram message caption (replace 9drive:path with 9drive:meta)
5. Run Telegram Sync
6. Sync: caption meta != DB cached ciphertext → decrypt new payload
7. Validate → reconcile DB name/path via existing updateFromParsed
8. Persist the new ciphertext as latest encryptedMetadata; recompute fingerprint
9. Next sync: equal ciphertext → skip decrypt
```

Works even when the physical Telegram filename is still plaintext (metadata-only repair; Mode B does not require Mode C).

---

## L. Failure / Consistency

### L.1 Transaction / failure ordering (plan §53)

Existing architecture is DB-first + best-effort caption sync; the target design keeps that shape:

| Scenario | Current behavior | Target behavior |
|---|---|---|
| DB write fails | upload aborts, temp cleaned | unchanged |
| Telegram upload succeeds, DB mapping write fails | provisional row soft-deleted; next sync sees orphan → inbox | unchanged; encrypted payload written in same update as `providerFileId` (single `prisma.file.update`) |
| DB ciphertext updated, caption `editMessage` fails | caption refresh is fire-and-forget | unchanged — next sync detects mismatch and reconciles (caption drift is already a sync-reconciled state) |

Idempotency: `uploadTelegramDocument` result is stored exactly once; sync is incremental and resumable via `TelegramSyncState`. No new transaction machinery needed.

### L.2 Wrong key / tampering (plan §46)

- `decryptMetadata` throws typed errors on auth-tag failure (tamper **or** wrong key — GCM cannot distinguish; same safe handling for both).
- Sync: per-message error recorded as a `TelegramSyncIssue` (the table already has `metadata Json?`), run continues. **Never** guess, overwrite, silently accept, or abort the whole run.
- Legacy rows are never decrypted; absence of `9drive:meta` is not an error.

### L.3 Failure codes (plan §47)

```text
TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED
TELEGRAM_CRYPTO_KEY_INVALID
TELEGRAM_METADATA_ENCRYPT_FAILED
TELEGRAM_METADATA_DECRYPT_FAILED
TELEGRAM_METADATA_MALFORMED
TELEGRAM_METADATA_UNSUPPORTED_VERSION
```

### L.4 Logging (plan §48)

`console.info('[telegram-crypto]', JSON.stringify({ event, operation: 'encrypt', cryptoVersion: 'v1', fileId, cacheHit, metadataChanged }))` — matching the existing `[module]` + `event` convention. Never log the master key, derived keys, IVs, or full decrypted metadata. Error messages truncated (`.slice(0, 200)` convention).

---

## M. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Master key loss → encrypted metadata unrecoverable | Startup validation, docs + UI warning, key-backup guidance. Encrypted metadata is recovery-only — DB stays usable. |
| 2 | Caption 1024-char limit vs payload size | Pathological-path mitigation (§J.4); versioned format allows future payload layout. |
| 3 | Wrong key + manual repair creates unrecoverable caption | Sync never overwrites; issue surfaced via `TelegramSyncIssue`; manual repair re-runs with corrected input. |
| 4 | Legacy compatibility regression | Parser priority keeps `9drive:path` first-class; existing tests extended, legacy fixtures kept. |
| 5 | Physical-name obfuscation breaks clients that match by filename | Nothing in 9Drive matches Telegram files by filename (downloads/sync/WebDAV all use `providerFileId`); documented. Jellyfin is a WebDAV client of logical names. |
| 6 | Caption `editMessage` flood limits during Mode B migration | Best-effort + per-file explicit actions; batch migration honors Telegram flood-wait retry conventions already used by sync. |
| 7 | WebDAV Telegram streaming gap blocks Jellyfin playback | Pre-existing, unrelated to crypto; fixed in Phase 10 (range-aware Telegram streaming). |
| 8 | Crypto work duplicated across call sites | Single `TelegramCryptoService`; both upload paths converge on it. |
| 9 | Nonce reuse / custom crypto | AES-256-GCM with random 12-byte IV per encryption via `node:crypto` only; no custom schemes. |
| 10 | New columns affect Google/S3 rows | Nullable columns, null for all non-Telegram rows; Prisma migration adds them without backfill. |

---

## N. Implementation Phases

Each phase lists target files and required tests. All tests use the existing Vitest conventions (`backend/vitest.config.mts`, `src/**/*.test.ts`, `vi.hoisted` + `vi.mock`); no Playwright, no new test frameworks.

### Phase 1 — Crypto foundation

**Files:** new `backend/src/modules/telegram/telegram-crypto.service.ts`; extend `backend/src/utils/crypto.ts` if sharing primitives; extend `backend/src/config/env.ts` (new TELEGRAM_* vars + `superRefine` validation); `backend/.env.docker.example` placeholders.

**Contents:** HKDF subkeys, AES-256-GCM encrypt/decrypt (random IV, typed errors), HMAC physical filename, stable serialization, fingerprint, config validation (fail-safe: enabled without valid key = startup error).

**Tests:** new `backend/src/modules/telegram/telegram-crypto.service.test.ts` — round trip; randomized ciphertext (fresh IV → different ciphertext for same plaintext); tamper detection (flip a byte → typed error); wrong key failure; stable physical filename for same file ID/key; fingerprint changes on rename/move inputs, stable otherwise; key-missing/key-invalid validation.

### Phase 2 — Database cache / provider metadata

**Files:** `backend/prisma/schema.prisma` (`File`: `physicalFilename`, `encryptedMetadata`, `metadataFingerprint`, `cryptoVersion`, nullable) + Prisma migration; cache read/write helpers on the crypto service or `file` module.

**Tests:** migration applies; non-Telegram rows remain NULL; read/write/clear cache helpers; legacy rows (NULL cache) behave like today.

### Phase 3 — Legacy-compatible metadata parser

**Files:** `backend/src/modules/telegram/telegram-metadata.ts` (add `9drive:meta` key to `encodeCaption`/`parseCaption`, `ParsedMetadata` gains `encryptedMeta` + diagnostics; keep `extraLines` and limit semantics).

**Tests:** extend `telegram-metadata.test.ts` — parse `9drive:meta=v1:...`; mixed id+meta; id+legacy path; malformed meta; duplicate meta; meta line preserved in `extraLines` when unrecognized; caption size guard.

### Phase 4 — Normal store / remote import

**Files:** `backend/src/modules/uploads/upload.routes.ts` (`finalizeNonGoogleUpload`), `backend/src/modules/remote-imports/processor.ts` (`uploadTempFile`) — both converge on: build recovery metadata from **final** canonical state (post-HLS `record.fileName`, resolved path), fingerprint, encrypt once, generate opaque name, persist cache fields in the same update as `providerFileId`, pass opaque name + `9drive:meta` caption to `uploadTelegramDocument`.

**Tests:** extend upload/remote-import tests (`processor-telegram-metadata.test.ts` etc.) — ciphertext persisted on active row; physical name is opaque; HLS final-metadata assertion (remux temp names never leak); failure path leaves no active orphan with cache fields.

### Phase 5 — Sync fast path

**Files:** `backend/src/modules/telegram/telegram-ingest.service.ts` (`ingestTelegramDocument`/`updateFromParsed`), `telegram-sync.service.ts` (`classifyOne` orphan path).

**Flow:** caption meta == DB `encryptedMetadata` → skip decrypt (still run all physical checks: existence via `providerFileId` match, size/mime conflict, deletion pass). Meta differs → decrypt → validate → reconcile via existing `updateFromParsed` → persist new ciphertext + fingerprint. Wrong key/tamper → `TelegramSyncIssue` (type + `metadata Json`), continue run. Legacy `9drive:path` path unchanged.

**Tests:** extend `telegram-sync.service.test.ts` / `telegram-ingest.service.test.ts` — equal ciphertext skips decrypt (mock spy not called); differing ciphertext decrypts + reconciles + persists; manual-edit flow (NEW != OLD → reconcile → next run skips); wrong-key message issues but does not abort run; legacy caption still ingests.

### Phase 6 — Rename / move

**Files:** `backend/src/modules/telegram/telegram-caption-refresh.ts` (+ call sites in `file.routes.ts`, `folder.routes.ts`).

**Flow:** after DB update, recompute fingerprint; unchanged → nothing; changed → encrypt once, save cache, `editMessage` caption with `9drive:meta` (no content re-upload, physical name unchanged).

**Tests:** rename changes fingerprint + ciphertext but not physical filename; move same; unchanged metadata → no re-encryption (mock encrypt not called); caption edit failure leaves DB-consistent state.

### Phase 7 — In-app crypto utility

**Files:** new `backend/src/modules/telegram/telegram-security.routes.ts` (mounted in `app.ts`), service methods, `backend/src/modules/telegram/telegram-security.service.ts`; frontend: `frontend/src/pages/SettingsPage.tsx` Security section + `frontend/src/lib/telegram.ts` helpers.

**Endpoints:** `POST /api/telegram/security/encrypt|decrypt|convert-legacy`, `GET /api/telegram/security/status` — `requireAuth` + per-user ownership; master key never serialized.

**Tests:** route-level: encrypt/decrypt/convert round trips; status reflects config; no key material in any response.

### Phase 8 — Manual repair UX

**Files:** frontend Security utility UI copy affordances; sync-side already done in Phase 5.

**Tests:** utility output for a known ID/path decrypts to the same values (E2E-ish via service + route tests); acceptance walkthrough (generate → paste → sync → reconcile → cache updated) covered by Phase 5 tests.

### Phase 9 — Optional metadata migration

**Files:** `telegram-caption-refresh.ts` / security service (`convert-legacy` applied to a file + `editMessage`), an explicit per-file "Update Telegram Metadata" action (gated: configured account/channel, ownership verified, physical file preserved).

**Tests:** per-file conversion updates caption to `9drive:meta` while `providerFileId`/messageId unchanged; legacy files with NULL cache remain readable; flood-wait retries.

### Phase 10 — WebDAV / Jellyfin regression

**Files:** `backend/src/modules/webdav/webdav-virtual-fs.ts` (`streamProviderFileToReadable`: add Telegram branch via `streamTelegramFile`-style range-aware streaming), optionally `telegram.service.ts` Range support.

**Tests:** WebDAV GET/HEAD/Range on Telegram files streams bytes (new `webdav-*.test.ts`); PROPFIND shows logical names; Jellyfin-style Range seek works; no decrypt anywhere on this path (spy assertion).

### Phase 11 — Documentation / rollout

**Files:** `.env.docker.example`, `docs/` (Telegram Drive storage doc, WebDAV doc, security/migration guide — master-key backup warning), `implementations/9drive-telegram-drive-storage-provider.md` or sibling doc for the caption format change.

**Contents:** new env vars, format spec (`9drive:meta=v1`), migration modes A/B/C, manual-repair walkthrough, failure codes, key-rotation note.

---

## Final Summary (spec §61)

```text
Telegram Encrypted Metadata Cache Audit Complete

Current Physical Filename:   PLAINTEXT
Current Metadata:            PLAINTEXT
Canonical DB State:          READY
Provider Mapping Cache:      NEEDS CHANGES
Normal Store:                NEEDS CHANGES
Remote Import:               NEEDS CHANGES
HLS / Remux:                 READY
Telegram Upload:             READY
Rename:                      NEEDS CHANGES
Move:                        NEEDS CHANGES
Sync Cache Comparison:       NEEDS CHANGES
Conditional Decrypt:         NEEDS CHANGES
WebDAV Read Path:            NO DECRYPT (pre-existing Telegram streaming gap to fix)
Jellyfin Read Path:          NO DECRYPT
Legacy Compatibility:        READY
In-App Encrypt Utility:      PLANNED
In-App Decrypt Utility:      PLANNED
Legacy Conversion:           PLANNED
Manual Repair Workflow:      PLANNED
Overall:                     READY FOR IMPLEMENTATION

Recommended Physical Filename Strategy: HMAC-SHA256(derived filename key, stable 9Drive file ID) → tg_<opaque>.bin (extension optional via env)
Recommended Encryption Algorithm:        AES-256-GCM (node:crypto), random 12-byte IV, base64url(iv):base64url(tag):base64url(ciphertext)
Recommended Metadata Format:             9drive:id=<id> + 9drive:meta=v1:<payload> (payload: {name, path, mimeType, size})
Recommended Cache Persistence:            Nullable columns on File (physicalFilename, encryptedMetadata, metadataFingerprint, cryptoVersion)
Recommended Fingerprint:                 SHA-256("v1|fileId|normalizedPath|name|mimeType|sizeBytes")
Recommended Sync Fast Path:               Telegram ciphertext == DB ciphertext → skip decrypt; != → decrypt + reconcile + persist; wrong key → TelegramSyncIssue, never abort
Recommended Rollout:                      Mode A (new files only) → Mode B (metadata migration, per-file) → Mode C (physical filename, deferred/optional)

Implementation Phases:                   1 Crypto foundation · 2 DB cache · 3 Legacy parser · 4 Store/remote-import · 5 Sync fast path · 6 Rename/move · 7 In-app utility · 8 Manual repair UX · 9 Metadata migration · 10 WebDAV/Jellyfin regression · 11 Docs/rollout
```
