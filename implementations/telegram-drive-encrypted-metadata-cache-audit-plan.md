# Telegram Drive — Audit & Plan for Encrypted Filename / Metadata with Database Cache + In-App Encrypt/Decrypt Utility

## Objective

Perform a complete audit of the existing Telegram Drive implementation, then produce a concrete implementation plan for:

1. Obfuscating the **physical filename stored in Telegram**
2. Encrypting recoverable Telegram metadata such as the original filename/path
3. Preserving the logical 9Drive filename/path in the database
4. Persisting the latest encrypted Telegram metadata in the database so normal read paths do not repeatedly decrypt
5. Performing crypto mainly at **store/update/sync boundaries**, not on normal reads
6. Supporting existing Telegram files that already use plaintext metadata
7. Adding an **Encrypt / Decrypt utility inside the 9Drive application**
8. Supporting manual repair of existing Telegram messages/files before running Telegram Sync
9. Keeping Store, Remote Import, Sync, WebDAV, Jellyfin, and normal download behavior compatible

This task is:

```text
AUDIT + DESIGN + IMPLEMENTATION PLAN
```

Do not implement the encryption system yet unless explicitly instructed in a later task.

Do not modify:

```text
references/teledrive
```

Use it only as a read-only architectural reference where useful.

Do not copy Teledrive source code.

---

# 1. Core Design Principle

The 9Drive database must remain the canonical working state.

Telegram encrypted metadata is primarily for:

```text
recovery
sync
reconciliation
re-indexing
manual repair
portability
```

Normal application reads should use the database directly.

Do NOT decrypt Telegram metadata for routine operations such as:

```text
UI listing
WebDAV PROPFIND
WebDAV GET
Jellyfin playback
normal download
folder browsing
search
```

Preferred architecture:

```text
                         ┌────────────────────────┐
                         │      9Drive DB         │
                         │                        │
                         │ name                   │
                         │ parentFolderId         │
                         │ mimeType               │
                         │ size                   │
                         │ logical path           │
                         │                        │
                         │ Telegram mapping       │
                         │ encryptedMetadata      │
                         │ metadataFingerprint    │
                         │ cryptoVersion          │
                         │ physicalFilename       │
                         └───────────┬────────────┘
                                     │
                      normal reads use DB only
                                     │
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
            UI                    WebDAV                  Jellyfin
         no decrypt             no decrypt              no decrypt
```

Crypto should happen mainly at synchronization boundaries.

---

# 2. Current Telegram Metadata Context

The current Telegram storage implementation uses metadata such as:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual path>
```

Example:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

The planned secure format should hide the original filename/path from Telegram while remaining recoverable by 9Drive.

Conceptually:

```text
Telegram Physical Filename:
tg_<opaque-id>.bin

Telegram Metadata:
9drive:id=abc123
9drive:meta=v1:<encrypted-payload>
```

After decryption:

```json
{
  "name": "episode-01.mkv",
  "path": "Movies/Anime/One Piece/episode-01.mkv",
  "mimeType": "video/x-matroska",
  "size": 123456789
}
```

Do not blindly implement this format before auditing the current code.

The audit must determine the safest migration path.

---

# 3. Cryptography Rule

Do NOT use a plain hash if the original filename/path must be recoverable.

A plain hash is one-way.

Separate:

```text
Physical Filename Obfuscation
```

from:

```text
Recoverable Metadata Encryption
```

Preferred conceptual design:

```text
Master Secret
    │
    ├── HKDF → filename HMAC key
    │
    └── HKDF → metadata encryption key
```

Physical Telegram filename:

```text
HMAC-SHA256(secret-derived-key, stable file identity)
```

Encrypted metadata:

```text
AES-256-GCM
```

or another established authenticated encryption mechanism already supported by the project runtime.

Do not implement custom cryptography.

Base64 is NOT encryption.

---

# 4. Performance / Cache Principle

The latest encrypted Telegram payload should be persisted in the database alongside the Telegram provider mapping.

This is important because encryption/decryption should not run repeatedly without a reason.

Conceptual provider mapping fields:

```text
channelId
messageId
providerRemoteId
physicalFilename
encryptedMetadata
metadataFingerprint
cryptoVersion
cryptoKeyId/version if needed
```

The existing database model may use different names.

Do NOT create schema changes during this audit.

First inspect the current schema and determine the best place to persist this information.

---

# 5. Canonical vs Cached State

There must be only ONE canonical decrypted working state:

```text
9Drive DB fields
```

Examples:

```text
File.name
File.parentFolderId
File.mimeType
File.size
folder hierarchy
```

Do NOT introduce a second canonical field such as:

```text
decryptedTelegramMetadata
```

that duplicates the same logical state.

That would create multiple sources of truth.

Instead:

```text
Canonical:
9Drive DB logical fields

Cached recovery representation:
encryptedMetadata
metadataFingerprint
cryptoVersion
physicalFilename
```

---

# 6. Metadata Fingerprint

Design a deterministic fingerprint for the canonical metadata that determines whether encrypted metadata needs regeneration.

Conceptually:

```text
canonical metadata
      ↓
stable serialization
      ↓
SHA-256
      ↓
metadataFingerprint
```

Possible inputs:

```text
version
fileId
normalized logical path
logical filename
mimeType
size
```

The fingerprint is NOT a security boundary.

It is only for:

```text
cache invalidation
change detection
avoiding unnecessary re-encryption
```

The audit/design report must specify exactly which canonical fields should be included.

---

# 7. Why Persist the Ciphertext

Authenticated encryption such as AES-GCM should use a random nonce/IV.

Therefore encrypting the same plaintext twice should normally produce different ciphertext.

Example:

```text
encrypt(metadata)
→ ciphertext A

encrypt(metadata)
→ ciphertext B
```

This is expected.

Therefore:

```text
encrypt once when metadata changes
save ciphertext in DB
reuse the saved ciphertext
```

is preferred over repeatedly regenerating encrypted metadata.

---

# 8. Audit Existing Telegram Storage Lifecycle

Trace the COMPLETE lifecycle:

```text
A. Normal Upload / Store
B. Remote Import
C. HLS / Remux output
D. Telegram upload
E. Telegram message/caption creation
F. Database persistence
G. Download
H. Rename
I. Move
J. WebDAV
K. Jellyfin
L. Telegram Sync
M. Reconciliation
N. Recovery
O. Manual repair
```

For each stage identify:

```text
INPUT
TRANSFORMATION
OUTPUT
PERSISTENCE
```

---

# 9. Audit Normal Store

Trace:

```text
User Upload
    ↓
9Drive file record
    ↓
final logical filename/path
    ↓
Telegram crypto metadata generation
    ↓
Telegram upload
    ↓
DB mapping persistence
```

Determine:

1. When the stable 9Drive file ID becomes available
2. Where final logical filename is known
3. Where final virtual path is known
4. Where Telegram physical filename is generated
5. Where Telegram metadata is generated
6. Whether Telegram upload can receive a different physical filename from the logical filename
7. Where provider mapping is persisted
8. Whether encrypted metadata can be persisted there without affecting unrelated providers

---

# 10. Desired New Store Flow

The planned future flow should conceptually be:

```text
Upload / Remote Import
        ↓
Create 9Drive file
        ↓
final file.id known
        ↓
final logical metadata known
        ↓
build canonical recovery metadata
        ↓
calculate metadataFingerprint
        ↓
encrypt ONCE
        ↓
generate opaque physical filename
        ↓
┌──────────────────────────────┐
│ persist Telegram mapping     │
│ physicalFilename             │
│ encryptedMetadata            │
│ metadataFingerprint          │
│ cryptoVersion                │
└──────────────────────────────┘
        ↓
Telegram upload
```

The exact transaction/order must be determined from the existing architecture.

Do not blindly copy this sequence if it could leave partial state.

---

# 11. Audit Remote Import

Trace:

```text
Remote URL
    ↓
Remote Import
    ↓
filename resolution
    ↓
optional Worker Relay
    ↓
optional HLS/remux
    ↓
final canonical filename
    ↓
destination folder
    ↓
9Drive file
    ↓
Telegram provider
```

Verify that Remote Import eventually converges into the same centralized Telegram crypto/metadata flow as normal upload.

Do not duplicate encryption logic inside Remote Import.

---

# 12. Audit HLS / Remux

Determine whether HLS/remux modifies:

```text
filename
extension
MIME type
temporary path
final path
```

The crypto layer must use the FINAL logical 9Drive identity.

Never generate Telegram metadata from:

```text
temporary remux path
concat file
worker path
container path
remote URL basename
```

---

# 13. Audit Current Telegram Physical Filename

Find the exact code responsible for the physical Telegram filename.

Document:

```text
Current physical filename source:
<exact file/function/property>
```

Determine whether it comes from:

```text
logical filename
temporary filename
remote import filename
provider key
storage key
```

Verify whether Telegram upload allows the physical filename to differ from the logical 9Drive filename.

---

# 14. Audit Current Telegram Metadata

Find exactly where these are generated:

```text
9drive:id=
9drive:path=
```

Inspect:

- serializer
- parser
- caption/message format
- edit/update behavior
- size constraints
- sync parser
- legacy compatibility
- database storage

---

# 15. Audit `9drive:id`

Verify that:

```text
9drive:id
```

is the stable logical 9Drive file identity.

Trace it through:

```text
store
remote import
rename
move
sync
recovery
WebDAV
```

It should remain stable across rename and move operations.

This stable ID is the preferred input for a stable opaque physical filename.

---

# 16. Audit `9drive:path`

Verify:

- source of truth
- generation
- rename update
- move update
- sync parsing
- recovery use
- WebDAV use
- plaintext exposure

The future design should move path/name recovery data into encrypted metadata.

---

# 17. Audit Telegram Sync

Trace:

```text
Telegram message
    ↓
extract 9drive:id
    ↓
extract metadata
    ↓
match DB file
    ↓
compare cached encrypted payload
    ↓
decrypt only if required
    ↓
reconcile canonical DB state
```

Determine where this optimization can be integrated.

---

# 18. Desired Sync Fast Path

If Telegram returns:

```text
9drive:id=abc123
9drive:meta=v1:XYZ
```

and DB contains:

```text
fileId = abc123
encryptedMetadata = v1:XYZ
```

then:

```text
Telegram payload == cached DB payload
```

should allow:

```text
skip decrypt
```

when the existing sync semantics confirm there is nothing else requiring metadata inspection.

Conceptual flow:

```text
Telegram message
      ↓
extract 9drive:id
      ↓
find DB mapping
      ↓
encrypted payload equals cached DB payload?
      │
      ├── YES
      │      ↓
      │   metadata unchanged
      │      ↓
      │   skip decrypt
      │
      └── NO
             ↓
           decrypt
             ↓
           validate
             ↓
           reconcile DB
             ↓
           save latest encrypted payload
```

Audit whether this is safe with the existing sync implementation.

---

# 19. Sync Must Not Trust Ciphertext Equality Alone for Physical Existence

The fast path should only skip metadata decryption.

It must NOT skip necessary checks for:

```text
Telegram message existence
physical remote identity
size changes if provider considers them relevant
deletion detection
channel/message mapping integrity
```

The audit must clearly distinguish:

```text
metadata unchanged
```

from:

```text
remote object unchanged
```

---

# 20. Manual Telegram Edit + Sync

This use case is REQUIRED.

Example:

DB currently stores:

```text
encryptedMetadata = v1:OLD
```

User manually edits Telegram caption to:

```text
9drive:id=abc123
9drive:meta=v1:NEW
```

During sync:

```text
NEW != OLD
```

therefore sync should:

```text
decrypt NEW
    ↓
validate metadata
    ↓
reconcile logical DB fields
    ↓
save NEW as latest encryptedMetadata
    ↓
update metadataFingerprint based on resulting canonical DB state
```

Next sync:

```text
NEW == NEW
```

so decryption can be skipped.

---

# 21. Do Not Cache a Second Decrypted Object

Do NOT plan a field such as:

```text
decryptedTelegramMetadata
```

if the same information already exists in normal 9Drive fields.

The DB already contains the logical working state.

The encrypted payload is a cached recovery representation, not a second source of truth.

---

# 22. WebDAV / Jellyfin Read Path

Verify and preserve:

```text
WebDAV
    ↓
9Drive DB logical file
    ↓
Telegram remote identity
    ↓
stream
```

There should be no metadata decrypt on:

```text
PROPFIND
HEAD
GET
Range GET
Jellyfin seek
Jellyfin resume
```

This is a critical performance requirement.

---

# 23. Download Read Path

Normal download should use:

```text
9Drive logical DB state
Telegram channelId/messageId/provider remote ID
```

not decrypted Telegram metadata.

Obfuscated physical filename must not break download.

---

# 24. Rename Flow

Future rename:

```text
Movies/old.mkv
    ↓
Movies/new.mkv
```

Expected flow:

```text
update canonical DB state
        ↓
calculate new metadataFingerprint
        ↓
fingerprint changed?
        │
        ├── NO → no crypto/update
        │
        └── YES
               ↓
            encrypt metadata once
               ↓
            save ciphertext to DB
               ↓
            update Telegram caption
```

Keep unchanged:

```text
9drive:id
Telegram messageId
Telegram physical object
opaque physical filename
```

Do not re-upload file content for rename.

---

# 25. Move Flow

Future move:

```text
Movies/file.mkv
    ↓
Movies/Anime/file.mkv
```

Expected:

```text
update parent folder in DB
        ↓
new logical path
        ↓
new fingerprint
        ↓
encrypt once
        ↓
save ciphertext
        ↓
update Telegram metadata
```

Physical filename and Telegram file should remain unchanged.

---

# 26. Crypto Service

Plan one backend service such as:

```text
TelegramCryptoService
```

Responsibilities:

```text
deriveKeys()
generatePhysicalFilename()
buildRecoveryMetadata()
calculateMetadataFingerprint()
encryptMetadata()
decryptMetadata()
detectMetadataVersion()
parseLegacyMetadata()
serializeTelegramCaption()
```

Do not duplicate crypto logic across:

```text
Store
Remote Import
Sync
WebDAV
UI endpoints
```

---

# 27. Physical Filename Obfuscation

Compare and recommend:

```text
HMAC(stable file ID)
HMAC(original path)
random UUID
encrypted filename
```

Preferred default:

```text
HMAC-SHA256(derived filename key, stable 9Drive file ID)
```

Conceptual filename:

```text
tg_<opaque-id>.bin
```

Benefits:

```text
stable across rename
stable across move
does not expose original filename
deterministic for one file/key
```

Do not use:

```text
SHA256(filename + public salt)
```

as the primary privacy/security mechanism.

---

# 28. Physical Extension Policy

Plan configuration:

```env
TELEGRAM_OBFUSCATE_FILE_EXTENSION=true
```

When enabled:

```text
tg_<opaque>.bin
```

When disabled:

```text
tg_<opaque>.mkv
```

The logical extension and MIME remain in:

```text
9Drive DB
encrypted recovery metadata
```

---

# 29. Encrypted Metadata Format

Plan a versioned format:

```text
9drive:id=abc123
9drive:meta=v1:<encrypted-payload>
```

Decrypted payload may contain only recovery-relevant fields:

```json
{
  "name": "episode-01.mkv",
  "path": "Movies/Anime/One Piece/episode-01.mkv",
  "mimeType": "video/x-matroska",
  "size": 123456789
}
```

Avoid storing unnecessary DB data in Telegram metadata.

---

# 30. Encryption Algorithm

Prefer standard authenticated encryption.

Recommended for Node.js:

```text
AES-256-GCM
```

The design must include:

```text
random nonce/IV per encryption
authentication tag
version
ciphertext
Base64URL-safe serialization
```

Do not reuse IVs.

Do not use ECB.

Do not implement custom encryption.

---

# 31. Key Derivation

Prefer one master key with domain-separated derived subkeys.

Conceptually:

```text
TELEGRAM_METADATA_MASTER_KEY
        │
        ├── HKDF("9drive:telegram:filename:v1")
        │       ↓
        │   filename HMAC key
        │
        └── HKDF("9drive:telegram:metadata:v1")
                ↓
            encryption key
```

---

# 32. `.env.example`

Audit current env conventions and plan fields similar to:

```env
# Telegram Drive metadata protection
TELEGRAM_METADATA_ENCRYPTION_ENABLED=false

# Cryptographically secure master secret.
# Never commit the real value.
TELEGRAM_METADATA_MASTER_KEY=

# Optional non-secret KDF context/salt/version label.
TELEGRAM_CRYPTO_SALT=9drive-telegram-v1

# Obfuscate physical Telegram filenames.
TELEGRAM_OBFUSCATE_FILENAME_ENABLED=false

# Hide original file extension.
TELEGRAM_OBFUSCATE_FILE_EXTENSION=true
```

Important:

```text
TELEGRAM_METADATA_MASTER_KEY
```

is the real secret.

The salt/context is not a replacement for the master key.

Do not put real secrets in `.env.example`.

---

# 33. Key Validation

If encryption is enabled and key is:

```text
missing
invalid
wrong length/format
```

fail safely.

Do not silently fall back to plaintext for new protected uploads.

Do not auto-generate a new key on each startup.

---

# 34. Key Backup Warning

Documentation and UI should clearly warn:

```text
If TELEGRAM_METADATA_MASTER_KEY is lost,
encrypted Telegram metadata cannot be recovered.
```

Never display the actual key in the UI.

Show only:

```text
Configured
Not Configured
Invalid
```

---

# 35. Legacy Compatibility

Future parser priority:

```text
1. 9drive:meta=v1:...
2. legacy 9drive:path=...
3. safe recovery fallback
```

Existing Telegram messages such as:

```text
9drive:id=abc123
9drive:path=Movies/file.mkv
```

must continue to work during migration.

---

# 36. Existing File Migration Modes

Plan migration as separate modes.

## Mode A — New Files Only

Only new Telegram uploads use:

```text
opaque physical filename
encrypted metadata
```

Legacy files remain untouched.

## Mode B — Metadata Migration

Convert caption metadata:

```text
9drive:path
    ↓
9drive:meta
```

without changing file content.

## Mode C — Physical Filename Migration

Optional and separate.

Only if Telegram/provider behavior allows it safely.

May require re-upload.

Do not require physical filename migration for metadata encryption.

---

# 37. In-App Encrypt / Decrypt Utility

The application MUST include an admin utility.

Plan:

```text
Settings
└── Telegram Drive
    └── Security
        ├── Encryption Status
        ├── Filename Obfuscation Status
        └── Crypto Utility
            ├── Encrypt
            ├── Decrypt
            └── Legacy → Encrypted
```

Cryptography must happen on the backend.

Do NOT send the master key to the frontend.

---

# 38. Encrypt Utility

Input:

```text
9Drive ID
Filename
Virtual Path
MIME Type (optional)
Size (optional)
```

Output:

```text
Physical Filename:
tg_<opaque>.bin

Telegram Metadata:
9drive:id=<id>
9drive:meta=v1:<encrypted-payload>
```

Provide:

```text
Copy Physical Filename
Copy Telegram Metadata
Copy Encrypted Payload
```

---

# 39. Decrypt Utility

Accept:

```text
9drive:meta=v1:<encrypted-payload>
```

or raw payload.

Output:

```text
Version
9Drive ID if relevant
Filename
Virtual Path
MIME
Size
```

Never expose the master key.

---

# 40. Legacy → Encrypted Utility

Accept:

```text
9drive:id=abc123
9drive:path=Movies/Anime/file.mkv
```

Provide:

```text
Convert to encrypted format
```

Output:

```text
9drive:id=abc123
9drive:meta=v1:<encrypted>
```

Do not automatically modify Telegram.

---

# 41. Manual Repair Workflow

This workflow is REQUIRED because some files already exist in Telegram and may need manual correction.

Expected:

```text
1. Open Settings → Telegram Drive → Security → Crypto Utility
2. Enter correct 9Drive ID
3. Enter correct original filename/path
4. Generate encrypted Telegram metadata
5. Copy generated metadata
6. Manually edit existing Telegram message/caption
7. Run Telegram Sync
8. Sync detects ciphertext differs from DB cache
9. Sync decrypts new payload
10. Sync reconciles DB path/name
11. Sync stores the new ciphertext in DB
12. Future sync can skip decrypt if ciphertext is unchanged
```

This is a core acceptance criterion.

---

# 42. Metadata-Only Repair

Manual repair must work even if the physical Telegram filename remains legacy/plaintext.

Do not require physical filename migration before sync can recover the logical path.

---

# 43. Optional Direct Telegram Caption Update

Audit whether the provider can safely edit metadata/caption on an existing Telegram storage message.

If supported, the plan may include:

```text
Update Telegram Metadata
```

Requirements:

```text
explicit user action
configured storage provider only
configured storage channel only
verify target message ownership
preserve physical file
update metadata only
```

Never edit personal chats, Saved Messages, or unrelated channels.

Manual copy/paste remains a valid fallback.

---

# 44. Backend API Security

Plan authenticated admin-only endpoints, conceptually:

```text
POST /api/telegram/security/encrypt
POST /api/telegram/security/decrypt
POST /api/telegram/security/convert-legacy
```

Use existing conventions.

Never expose the master key.

---

# 45. Sync Recovery Priority

Audit current behavior first.

Recommended future resolution order:

```text
1. 9drive:id
2. cached Telegram remote identity
3. encrypted 9drive:meta
4. legacy 9drive:path
5. safe recovery fallback
```

The exact order should respect existing identity semantics.

---

# 46. Wrong Key Handling

If encrypted metadata exists but the configured key is wrong:

```text
do not guess
do not overwrite
do not silently accept
```

Return/record a safe error.

A malformed or wrong-key message must not abort the entire sync run.

---

# 47. Failure Codes

Plan explicit errors:

```text
TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED
TELEGRAM_CRYPTO_KEY_INVALID
TELEGRAM_METADATA_ENCRYPT_FAILED
TELEGRAM_METADATA_DECRYPT_FAILED
TELEGRAM_METADATA_MALFORMED
TELEGRAM_METADATA_UNSUPPORTED_VERSION
```

---

# 48. Logging

Safe logs may include:

```text
operation=encrypt
cryptoVersion=v1
fileId=...
cacheHit=true
metadataChanged=false
```

Do NOT log secrets or full decrypted metadata.

---

# 49. Key Rotation

Audit whether key rotation belongs in v1 or should be deferred.

At minimum, ensure the metadata format can evolve.

Do not over-engineer if unnecessary.

---

# 50. WebDAV / Jellyfin Compatibility

The crypto system must NOT alter logical paths.

Example:

```text
Telegram:
tg_8f32....bin

DB:
Movies/Anime/movie.mkv

WebDAV:
Movies/Anime/movie.mkv

Jellyfin:
movie.mkv
```

WebDAV/Jellyfin normal read paths should not decrypt Telegram metadata.

---

# 51. Download Compatibility

Downloads should resolve the physical Telegram object using:

```text
channelId
messageId
provider remote ID
```

not the physical filename.

Physical filename obfuscation must not break normal download, WebDAV GET, Jellyfin playback, range requests, or Sync.

---

# 52. Database Persistence Audit

Determine where these future cached fields should live:

```text
physicalFilename
encryptedMetadata
metadataFingerprint
cryptoVersion
```

Possible locations:

```text
existing File provider metadata
storage object mapping
provider-specific metadata JSON
Telegram mapping table
```

Prefer the existing storage abstraction.

Do not create migrations during this audit.

---

# 53. Transaction / Failure Ordering

Audit how to avoid inconsistent states such as:

```text
DB ciphertext updated
Telegram caption update fails
```

or:

```text
Telegram upload succeeds
DB mapping write fails
```

The plan must define retry, reconciliation, sync detection, and idempotency using existing infrastructure where possible.

---

# 54. Testing Plan

The implementation plan must include tests for:

- encrypt → decrypt round trip
- randomized ciphertext via fresh nonce/IV
- tamper detection
- wrong key failure
- stable physical filename for same file ID/key
- rename changes fingerprint but not physical filename
- move changes fingerprint but not physical filename
- unchanged Telegram ciphertext skips decrypt where safe
- changed Telegram ciphertext triggers decrypt + reconcile + cache update
- legacy parser
- legacy conversion
- manual Encrypt utility
- manual Decrypt utility
- Normal Store
- Remote Import
- HLS/remux final metadata
- WebDAV no-decrypt read path
- Jellyfin logical filename/playback regression

---

# 55. Performance Validation

Normal read paths should perform:

```text
0 metadata decrypt operations
```

for:

```text
UI listing
WebDAV PROPFIND
WebDAV GET
Jellyfin playback
Jellyfin seek
normal download
```

Sync should decrypt only when encrypted metadata is new/changed, legacy conversion/recovery requires it, or manual repair changed Telegram metadata.

---

# 56. Do Not Use Playwright

Do not use Playwright for this project.

Use existing backend/unit/integration/frontend type/lint tooling.

---

# 57. Required Audit Report

Create:

```text
docs/audits/telegram-encrypted-metadata-cache-audit.md
```

Include:

## A. Executive Summary
## B. Current Store Flow
## C. Current Physical Filename Flow
## D. Current Metadata Flow
## E. Current Database Mapping
## F. Sync Flow
## G. Read-Path Analysis
## H. Rename / Move
## I. Existing File Migration
## J. Crypto Design
## K. In-App Crypto Utility
## L. Failure / Consistency
## M. Risks
## N. Implementation Phases

The report must end with a concrete implementation plan.

---

# 58. Suggested Implementation Phases

## Phase 1 — Crypto Foundation

Implement centralized crypto service, HKDF, AES-256-GCM, HMAC physical filename, stable serialization, fingerprinting, configuration validation.

## Phase 2 — Database Cache / Provider Metadata

Persist:

```text
encryptedMetadata
metadataFingerprint
physicalFilename
cryptoVersion
```

using existing provider mapping architecture.

## Phase 3 — Legacy-Compatible Metadata Parser

Support encrypted `9drive:meta` plus legacy `9drive:path`.

## Phase 4 — Normal Store / Remote Import

Encrypt only after final canonical metadata is known.

Persist and reuse ciphertext.

## Phase 5 — Sync Fast Path

```text
Telegram ciphertext == DB ciphertext
    → skip decrypt

Telegram ciphertext != DB ciphertext
    → decrypt + reconcile + persist
```

## Phase 6 — Rename / Move

Use fingerprint invalidation.

Only regenerate encrypted metadata when canonical recovery metadata changes.

## Phase 7 — In-App Crypto Utility

Implement backend-driven:

```text
Encrypt
Decrypt
Legacy → Encrypted
```

## Phase 8 — Manual Repair UX

Support manual Telegram caption edit followed by Sync.

## Phase 9 — Optional Metadata Migration

Convert legacy captions without requiring physical filename migration.

## Phase 10 — WebDAV / Jellyfin Regression

Ensure no decrypt on normal read paths.

## Phase 11 — Documentation / Rollout

Update `.env.example`, Telegram Drive docs, WebDAV docs, and security/migration documentation.

---

# 59. Future Acceptance Criteria

The future implementation should be complete only when:

1. Physical Telegram filenames can be opaque.
2. Original filename/path remain recoverable through authenticated encryption.
3. DB remains canonical logical filesystem state.
4. Latest encrypted Telegram payload is persisted in DB/provider mapping.
5. Metadata fingerprint is persisted for change detection.
6. UI/WebDAV/Jellyfin/download normal reads require no decrypt.
7. Store encrypts only after final canonical metadata is known.
8. Remote Import uses the centralized crypto service.
9. HLS/remux uses final logical identity.
10. Unchanged metadata does not trigger unnecessary re-encryption.
11. Rename/move invalidate fingerprint and update encrypted metadata.
12. Physical opaque filename remains stable across rename/move when file-ID HMAC is used.
13. Sync can skip decrypt when Telegram ciphertext equals DB cache.
14. Sync decrypts/reconciles when ciphertext differs.
15. Manual Telegram caption edits are detected and persisted.
16. Legacy `9drive:path` remains supported.
17. Metadata migration does not require physical filename migration.
18. App includes Encrypt, Decrypt, and Legacy → Encrypted.
19. Master key never reaches frontend or UI output.
20. `.env.example` contains placeholders only.
21. Wrong keys and tampering fail safely.
22. Existing Telegram remote identities remain valid.
23. WebDAV/Jellyfin logical paths remain unchanged.
24. Existing Google Drive behavior remains unaffected.
25. `references/teledrive` remains untouched.
26. Documentation explains master-key backup requirements.

---

# 60. Important Restrictions

This task is AUDIT + DESIGN + PLAN only.

Do NOT:

- implement encryption yet
- modify production Telegram messages
- rename physical Telegram files
- mass migrate metadata
- create migrations
- change schema
- rewrite Telegram Sync
- remove legacy support
- expose/send/log the master key
- use custom cryptography
- treat Base64 as encryption
- decrypt metadata on normal WebDAV/Jellyfin reads
- modify `references/teledrive`
- copy Teledrive code
- use Playwright

Safe read-only inspection and non-destructive tests are allowed.

---

# 61. Final Terminal Summary

Print:

```text
Telegram Encrypted Metadata Cache Audit Complete

Current Physical Filename:
PLAINTEXT / OPAQUE / MIXED

Current Metadata:
PLAINTEXT / PARTIAL / ENCRYPTED

Canonical DB State:
READY / NEEDS CHANGES

Provider Mapping Cache:
READY / NEEDS CHANGES

Normal Store:
READY / NEEDS CHANGES

Remote Import:
READY / NEEDS CHANGES

HLS / Remux:
READY / NEEDS CHANGES

Telegram Upload:
READY / NEEDS CHANGES

Rename:
READY / NEEDS CHANGES

Move:
READY / NEEDS CHANGES

Sync Cache Comparison:
READY / NEEDS CHANGES

Conditional Decrypt:
READY / NEEDS CHANGES

WebDAV Read Path:
NO DECRYPT / NEEDS CHANGES

Jellyfin Read Path:
NO DECRYPT / NEEDS CHANGES

Legacy Compatibility:
READY / NEEDS CHANGES

In-App Encrypt Utility:
PLANNED / BLOCKED

In-App Decrypt Utility:
PLANNED / BLOCKED

Legacy Conversion:
PLANNED / BLOCKED

Manual Repair Workflow:
PLANNED / BLOCKED

Overall:
READY FOR IMPLEMENTATION / NEEDS ARCHITECTURAL WORK

Recommended Physical Filename Strategy:
...

Recommended Encryption Algorithm:
...

Recommended Metadata Format:
...

Recommended Cache Persistence:
...

Recommended Fingerprint:
...

Recommended Sync Fast Path:
...

Recommended Rollout:
...

Implementation Phases:
...
```

The primary deliverable is:

```text
docs/audits/telegram-encrypted-metadata-cache-audit.md
```

The report must end with a concrete implementation plan, but this task must NOT implement that plan yet.
