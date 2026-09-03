# Telegram Drive — Audit & Plan for Encrypted Filename / Metadata + In-App Encrypt/Decrypt Utility

## Objective

Perform a complete audit of the existing Telegram Drive implementation, then produce an implementation plan for:

1. Obfuscating the **physical filename stored in Telegram**
2. Encrypting recoverable Telegram metadata such as the original filename/path
3. Preserving the logical 9Drive filename/path
4. Supporting existing Telegram files that already use plaintext metadata
5. Adding an **Encrypt / Decrypt utility inside the 9Drive application**
6. Supporting manual repair of existing Telegram messages/files before running Telegram Sync
7. Keeping Store, Remote Import, Sync, WebDAV, and Jellyfin compatible

This task is:

```text
AUDIT + DESIGN + IMPLEMENTATION PLAN
```

Do not implement the encryption system yet unless explicitly instructed in a later task.

Do not modify `references/teledrive`.

Use it only as a read-only architectural reference where useful.

Do not copy Teledrive source code.

---

# 1. Current Telegram Metadata Context

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
  "mimeType": "video/x-matroska"
}
```

Do not blindly implement this format before auditing the current code.

The audit must determine the safest migration path from the existing metadata format.

---

# 2. Why This Is Needed

The current plaintext Telegram storage can expose information such as:

```text
One Piece Episode 01.mkv
Movies/Anime/One Piece/One Piece Episode 01.mkv
```

even if Telegram is only being used as physical storage.

The desired architecture is:

```text
9Drive logical filename/path
        ↓
kept in 9Drive database
        ↓
encrypted recovery metadata
        ↓
Telegram physical storage
```

Telegram should ideally see something opaque such as:

```text
tg_8a66fd3f4473f1a64d4c5f....bin
```

while 9Drive, WebDAV, Jellyfin, and the normal application UI continue to display:

```text
Movies/Anime/One Piece/episode-01.mkv
```

---

# 3. Important Cryptography Rule

Do NOT use a plain hash if the original filename/path must be recoverable.

A hash is one-way.

The design should separate:

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

or another established authenticated encryption mechanism already well-supported by the project runtime.

Do not implement custom cryptography.

Do not use reversible homemade encoding.

Base64 is NOT encryption.

---

# 4. Audit Existing Telegram Storage Lifecycle

Trace the COMPLETE lifecycle for Telegram-backed files:

```text
A. Normal Upload / Store
B. Remote Import
C. HLS / Remux output
D. WebDAV-originated logical changes if applicable
E. Telegram upload
F. Telegram message/caption creation
G. Database persistence
H. Download
I. Rename
J. Move
K. Telegram Sync
L. Reconciliation
M. Recovery
N. Manual repair
```

For each stage identify:

```text
INPUT
TRANSFORMATION
OUTPUT
PERSISTENCE
```

---

# 5. Audit Normal Store

Trace:

```text
User Upload
    ↓
9Drive file record
    ↓
final logical filename
    ↓
final virtual path
    ↓
Telegram provider
    ↓
physical Telegram filename
    ↓
Telegram caption/metadata
```

Determine:

1. When the 9Drive file ID becomes available
2. Where the final logical filename is determined
3. Where the final virtual path is determined
4. Where Telegram physical filename is generated
5. Where `9drive:id` is generated
6. Where `9drive:path` is generated
7. Whether the provider already has a metadata serialization helper
8. Whether the Telegram physical filename currently equals the logical filename
9. Whether Telegram upload can receive a different physical filename from the logical 9Drive filename

Report exact source files/functions.

---

# 6. Audit Remote Import

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
optional HLS processing/remux
    ↓
final canonical filename
    ↓
destination folder
    ↓
9Drive file
    ↓
Telegram provider
```

Determine whether Remote Import already converges into the same storage-provider flow as normal upload.

The secure design must ensure:

```text
Remote Import
Normal Upload
```

both eventually call the SAME Telegram crypto/metadata abstraction.

Do not duplicate crypto logic in Remote Import.

---

# 7. Audit HLS / Remux

Determine whether HLS/remux output can alter:

```text
filename
extension
MIME type
virtual path
temporary path
```

Ensure any future Telegram obfuscation uses the FINAL 9Drive identity, not:

```text
temporary filename
concat filename
remux output temp path
container filesystem path
remote URL basename
```

Audit only.

---

# 8. Audit Current Telegram Physical Filename

Find exactly how Telegram upload names physical files.

Document:

```text
Current physical filename source:
<file/function/property>
```

Determine whether it comes from:

```text
logical filename
remote import filename
temporary filename
storage key
provider-generated value
```

Determine whether the Telegram library allows specifying the physical filename independently.

---

# 9. Audit Current Telegram Caption / Metadata

Find the exact code that creates:

```text
9drive:id=
9drive:path=
```

Determine:

- serialization format
- newline format
- caption/message location
- any other metadata keys
- size limits
- edit support
- parser implementation
- backward compatibility constraints

Do not change it in this task.

---

# 10. Audit `9drive:id`

Verify exactly what `9drive:id` represents.

It should be the stable logical 9Drive file identity.

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

Determine whether it remains stable across logical path changes.

This stable ID is a strong candidate for generating an opaque physical Telegram filename.

---

# 11. Audit `9drive:path`

Verify the current lifecycle of:

```text
9drive:path
```

Determine:

- source of truth
- generation
- updates after rename
- updates after move
- parsing during sync
- use during recovery
- use by WebDAV
- whether it is currently plaintext in Telegram

The future design must avoid exposing the original path while preserving recoverability.

---

# 12. Audit Telegram Sync

Trace:

```text
Telegram message
    ↓
metadata parser
    ↓
9drive:id
    ↓
9drive:path
    ↓
file match
    ↓
folder resolution
    ↓
reconciliation
```

Determine where the future encrypted metadata parser should integrate.

The sync system should eventually support:

```text
1. encrypted `9drive:meta`
2. legacy plaintext `9drive:path`
3. recovery fallback
```

Do not remove legacy support in the first migration.

---

# 13. Audit WebDAV / Jellyfin Dependency

9Drive already exposes a database-backed virtual filesystem over read-only WebDAV.

Telegram physical filenames must NOT become the filenames exposed by WebDAV.

Required separation:

```text
Telegram:
tg_abc123....bin

9Drive DB:
Movies/Anime/One Piece/episode-01.mkv

WebDAV:
Movies/Anime/One Piece/episode-01.mkv

Jellyfin:
episode-01.mkv
```

Audit whether any WebDAV code incorrectly depends on the Telegram physical filename.

If yes, flag it as a blocking issue.

---

# 14. Audit Download Behavior

Telegram downloads should use provider physical identity:

```text
channel ID
message ID
provider remote ID
```

not the physical Telegram filename.

Verify this.

The future physical filename obfuscation must not break downloads.

---

# 15. Audit Rename / Move

Trace:

```text
rename
move
```

for Telegram-backed files.

The intended future behavior is:

```text
same 9drive:id
same Telegram physical object
same opaque Telegram filename
updated encrypted logical metadata
```

Do not re-upload the physical file merely because the logical path changed.

Audit whether Telegram caption/message metadata can be edited in-place.

---

# 16. Audit Existing Files

There are already files stored in Telegram.

Some may contain:

```text
9drive:id=...
9drive:path=...
```

and use plaintext physical filenames.

The new system MUST support migration and manual repair.

Do not assume all existing files can be automatically migrated.

Categorize existing Telegram messages:

```text
A. valid legacy metadata
B. missing path
C. missing ID
D. malformed metadata
E. wrong path
F. wrong filename
G. already recovered into wrong 9Drive folder
H. manually edited Telegram messages
```

---

# 17. Design: Physical Filename Obfuscation

Propose a deterministic or appropriately stable filename strategy.

Preferred conceptual format:

```text
tg_<opaque-id>.bin
```

Example:

```text
tg_64b147df38fd09318e1d58f8a913c541.bin
```

Preferred opaque ID concept:

```text
HMAC-SHA256(
    derived filename key,
    stable 9Drive file ID
)
```

Do NOT use:

```text
SHA256(filename + public salt)
```

as the primary security mechanism.

Do NOT rely on the filename itself as the input if rename stability is desired.

The audit/design report must explicitly compare:

```text
HMAC(file ID)
HMAC(original path)
random UUID
encrypted filename
```

and recommend the best approach for:

- privacy
- stability
- rename
- move
- migration
- collision resistance
- debugging
- recovery

---

# 18. Extension Strategy

Audit and plan whether Telegram physical files should use:

```text
.bin
```

or preserve the real extension:

```text
.mkv
.mp4
.pdf
```

Trade-off:

```text
preserve extension
    =
better physical readability
but leaks file type

.bin
    =
better privacy
```

The implementation plan should make this configurable.

Example:

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

The logical MIME type and extension must remain available in encrypted metadata / 9Drive DB.

---

# 19. Design: Encrypted Metadata

Propose a versioned encrypted payload.

Conceptually:

```text
9drive:id=abc123
9drive:meta=v1:<encrypted-payload>
```

Decrypted payload:

```json
{
  "name": "episode-01.mkv",
  "path": "Movies/Anime/One Piece/episode-01.mkv",
  "mimeType": "video/x-matroska"
}
```

Consider including only recovery-relevant metadata such as:

```text
name
path
mimeType
size
```

Do not blindly put sensitive or redundant DB data into Telegram.

---

# 20. Metadata Versioning

The encrypted format MUST be versioned.

Example:

```text
9drive:meta=v1:<payload>
```

This should support future:

```text
v2
v3
```

without breaking old Telegram messages.

Plan a dedicated codec/service such as:

```text
TelegramMetadataCodec
```

or equivalent existing abstraction.

---

# 21. Encryption Algorithm

Prefer a standard authenticated encryption algorithm.

Recommended default for Node.js:

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

Do NOT reuse a fixed IV.

Do NOT use ECB.

Do NOT implement custom encryption.

---

# 22. Key Derivation

Prefer one master key with derived subkeys.

Conceptually:

```text
TELEGRAM_METADATA_MASTER_KEY
        │
        ├── HKDF("9drive:telegram:filename:v1")
        │       ↓
        │   HMAC filename key
        │
        └── HKDF("9drive:telegram:metadata:v1")
                ↓
            encryption key
```

This avoids using the same raw key for multiple purposes.

---

# 23. `.env.example`

Audit current environment configuration conventions.

Plan configuration similar to:

```env
# Telegram Drive metadata protection
TELEGRAM_METADATA_ENCRYPTION_ENABLED=false

# 32-byte cryptographically secure secret.
# Set a real secret in .env; never commit it.
TELEGRAM_METADATA_MASTER_KEY=

# Optional non-secret KDF context/salt/version label if needed by implementation.
TELEGRAM_CRYPTO_SALT=9drive-telegram-v1

# Hide the original extension of physical Telegram uploads.
TELEGRAM_OBFUSCATE_FILE_EXTENSION=true
```

Important:

```text
TELEGRAM_METADATA_MASTER_KEY
```

is the actual secret.

`TELEGRAM_CRYPTO_SALT` is not a replacement for the secret key.

Do not put a real production secret into `.env.example`.

---

# 24. Key Validation

Plan startup/config validation.

If encryption is enabled but the key is missing or invalid:

```text
fail safely
```

Do not silently store plaintext metadata.

Do not generate a new key automatically on every startup.

A changing key would make previously encrypted Telegram metadata unrecoverable.

---

# 25. Key Backup Warning

The application must clearly document:

```text
If TELEGRAM_METADATA_MASTER_KEY is lost,
encrypted Telegram metadata cannot be decrypted.
```

Plan to show this warning in:

```text
docs
Settings → Telegram Drive → Security
```

Do not display the actual master key in the UI.

---

# 26. Crypto Service

Plan one reusable backend service.

Conceptually:

```text
TelegramCryptoService
```

Responsibilities:

```text
deriveKeys()
generatePhysicalFilename()
encryptMetadata()
decryptMetadata()
detectMetadataVersion()
parseLegacyMetadata()
serializeTelegramCaption()
```

Do not duplicate crypto logic in:

```text
Store
Remote Import
Sync
WebDAV
UI routes
```

---

# 27. New Upload Lifecycle

Plan:

```text
Normal Upload / Remote Import
            ↓
9Drive file created
            ↓
stable file.id known
            ↓
final logical path known
            ↓
TelegramCryptoService
      │               │
      │               └── encrypt recovery metadata
      ↓
generate opaque physical filename
            ↓
Telegram upload
            ↓
Telegram caption:
9drive:id=<file-id>
9drive:meta=v1:<encrypted>
```

The physical filename must not become the 9Drive logical filename.

---

# 28. Rename Lifecycle

Future rename:

```text
Movies/old.mkv
    ↓
Movies/new.mkv
```

Expected:

```text
9drive:id
    unchanged

Telegram physical filename
    unchanged

Telegram message ID
    unchanged

encrypted metadata
    updated
```

Do not re-upload file contents only for rename.

---

# 29. Move Lifecycle

Future move:

```text
Movies/file.mkv
    ↓
Movies/Anime/file.mkv
```

Expected:

```text
same file ID
same physical Telegram object
same opaque filename
updated encrypted path metadata
```

---

# 30. Legacy Compatibility

Plan parser priority:

```text
1. 9drive:meta=v1:...
2. legacy 9drive:path=...
3. recovery fallback
```

Example legacy:

```text
9drive:id=abc123
9drive:path=Movies/file.mkv
```

must continue to sync.

Do not require an immediate migration of all existing Telegram messages.

---

# 31. Existing File Migration

Design an optional migration process.

Possible flow:

```text
legacy Telegram message
        ↓
parse 9drive:id
        ↓
parse plaintext 9drive:path
        ↓
generate encrypted metadata
        ↓
edit Telegram caption/message
```

Physical filename migration should be evaluated separately.

Telegram may or may not support changing the physical filename of an existing uploaded document without re-uploading.

Do NOT assume it can.

The audit report must verify this capability.

---

# 32. IMPORTANT: In-App Encrypt / Decrypt Utility

The application MUST include a safe admin utility for manually encrypting and decrypting Telegram metadata.

This is needed because existing Telegram files may require manual repair before synchronization.

Add/plan:

```text
Settings
└── Telegram Drive
    └── Security
        └── Crypto Utility
            ├── Encrypt
            └── Decrypt
```

Do not perform cryptography directly in the browser.

The frontend must call authenticated backend endpoints that use:

```text
TelegramCryptoService
```

The master key must never be sent to the frontend.

---

# 33. Encrypt Utility

The Encrypt tab should accept logical metadata.

At minimum:

```text
9Drive ID
Filename
Virtual Path
MIME Type (optional)
Size (optional)
```

Example input:

```text
9Drive ID:
abc123

Filename:
episode-01.mkv

Virtual Path:
Movies/Anime/One Piece/episode-01.mkv

MIME:
video/x-matroska
```

Output:

```text
Physical Filename:
tg_<opaque>.bin

Telegram Metadata:
9drive:id=abc123
9drive:meta=v1:<encrypted-payload>
```

Provide convenient:

```text
Copy Physical Filename
Copy Telegram Metadata
Copy Encrypted Payload
```

actions.

---

# 34. Decrypt Utility

The Decrypt tab should accept:

```text
9drive:meta=v1:<encrypted-payload>
```

or the raw encrypted payload.

Output:

```text
Version:
v1

9Drive ID:
...

Filename:
...

Virtual Path:
...

MIME:
...

Size:
...
```

The decrypt utility is intended for:

```text
debugging
manual repair
migration
support
recovery
```

Do not expose the master key.

---

# 35. Manual Telegram Repair Workflow

This use case is REQUIRED.

There are already files in Telegram that may need manual editing.

Expected workflow:

```text
1. User opens 9Drive Crypto Utility
2. User enters correct:
   - 9Drive ID
   - original filename
   - original path
3. Application generates:
   - opaque physical filename suggestion
   - encrypted Telegram metadata
4. User copies the encrypted metadata
5. User manually edits the existing Telegram message/caption
6. User runs Telegram Sync
7. Sync decrypts metadata
8. File resolves to the correct 9Drive path
```

The UI should include a clear instruction for this workflow.

Important:

Physical filename renaming may not be possible without re-uploading.

Therefore the manual repair workflow MUST support:

```text
metadata-only repair
```

even if the Telegram physical filename remains legacy/plaintext.

---

# 36. Manual Repair Without Physical Rename

For old Telegram files, this should be valid:

```text
Physical Telegram filename:
One Piece Episode 01.mkv

Caption:
9drive:id=abc123
9drive:meta=v1:<encrypted-payload>
```

After Sync:

```text
9Drive logical path:
Movies/Anime/One Piece/One Piece Episode 01.mkv
```

The old physical filename may remain visible until a separate optional physical migration/re-upload occurs.

Do not block metadata migration because physical rename is unavailable.

---

# 37. Legacy Decrypt / Parse Utility

The application utility should also recognize legacy metadata:

```text
9drive:id=abc123
9drive:path=Movies/Anime/file.mkv
```

and show:

```text
Format:
Legacy plaintext

ID:
abc123

Path:
Movies/Anime/file.mkv
```

Provide an action:

```text
Convert to encrypted format
```

that generates:

```text
9drive:id=abc123
9drive:meta=v1:<encrypted>
```

without automatically modifying Telegram.

---

# 38. Optional Telegram Message Update Feature

Audit whether the existing Telegram provider can safely edit a specific storage message/caption.

If supported, the implementation plan may include:

```text
Update Telegram Metadata
```

inside the admin utility.

This must:

- require explicit user action
- show the target storage account/channel/message
- verify the message belongs to the configured Telegram storage channel
- never edit personal chats
- never edit Saved Messages
- never edit unrelated Telegram messages
- preserve physical file attachment
- update metadata only

Do not implement this unless the provider safely supports it.

Manual copy/paste remains a valid fallback.

---

# 39. In-App Security UX

Plan:

```text
Settings
└── Telegram Drive
    └── Security
        ├── Metadata Encryption
        │   ├── Enabled / Disabled
        │   ├── Version
        │   └── Key Status
        │
        ├── Physical Filename Obfuscation
        │   ├── Enabled / Disabled
        │   └── Hide Extension
        │
        └── Crypto Utility
            ├── Encrypt
            ├── Decrypt
            └── Legacy → Encrypted
```

Do NOT display:

```text
TELEGRAM_METADATA_MASTER_KEY
```

The UI may only show:

```text
Configured
Not Configured
Invalid
```

---

# 40. API Security

Plan authenticated admin-only endpoints.

Conceptually:

```text
POST /api/telegram/security/encrypt
POST /api/telegram/security/decrypt
POST /api/telegram/security/convert-legacy
```

Use existing routing/auth conventions.

Do not expose generic unauthenticated encryption/decryption endpoints.

Rate limit if the existing admin/API architecture supports it.

Never log plaintext secrets or the master key.

---

# 41. Logging

Safe logs may include:

```text
cryptoVersion=v1
operation=encrypt
fileId=...
success=true
```

Do NOT log:

```text
master key
derived key
nonce secret material
full decrypted metadata
Telegram session
API hash
OTP
password
```

Avoid logging original sensitive paths unless existing safe logging policy explicitly allows it.

---

# 42. Sync Integration

Future sync flow:

```text
Telegram message
        ↓
extract 9drive:id
        ↓
detect 9drive:meta
        ↓
decrypt
        ↓
{
  name,
  path,
  mimeType,
  size
}
        ↓
resolve 9Drive file
        ↓
resolve virtual path
```

Fallback:

```text
No 9drive:meta
    ↓
parse legacy 9drive:path
```

Then:

```text
no usable metadata
    ↓
Recovered from Telegram
```

---

# 43. Recovery Priority

Recommended future priority:

```text
1. 9drive:id
2. encrypted 9drive:meta
3. legacy 9drive:path
4. Telegram remote identity
5. safe recovery fallback
```

Audit current sync order before finalizing this.

---

# 44. WebDAV Compatibility

The encryption system must NOT alter WebDAV paths.

Example:

```text
Telegram:
tg_8f32....bin

Encrypted metadata:
9drive:meta=v1:...

Database:
Movies/Anime/movie.mkv

WebDAV:
Movies/Anime/movie.mkv
```

Jellyfin and rclone must never see:

```text
tg_8f32....bin
```

unless the database/recovery state is genuinely missing logical metadata.

---

# 45. Download Compatibility

Downloads must still use:

```text
channel ID + message ID
provider remote identity
```

not the physical filename.

Changing/obfuscating the physical Telegram filename must not break:

```text
WebDAV GET
Jellyfin playback
normal download
Telegram Sync
```

---

# 46. Database Source of Truth

The normal source of truth remains:

```text
9Drive database
```

for:

```text
logical filename
virtual folder hierarchy
logical path
MIME
```

Encrypted Telegram metadata exists for:

```text
recovery
re-indexing
sync reconciliation
manual repair
```

Do not move the primary filesystem hierarchy into Telegram.

---

# 47. Migration Strategy

The final plan must categorize migration into:

## Mode A — New Files Only

New Telegram uploads use encrypted metadata.

Legacy files continue using plaintext metadata.

## Mode B — Metadata Migration

Existing message captions are converted:

```text
9drive:path
    ↓
9drive:meta
```

without touching the physical file.

## Mode C — Physical Filename Migration

Optional, only if technically feasible.

May require re-upload.

Must NOT be mandatory for metadata migration.

Recommend which modes should be implemented first.

---

# 48. Feature Flags

Plan safe rollout.

Example:

```env
TELEGRAM_METADATA_ENCRYPTION_ENABLED=false
TELEGRAM_OBFUSCATE_FILENAME_ENABLED=false
TELEGRAM_OBFUSCATE_FILE_EXTENSION=true
```

Default migration behavior should avoid unexpectedly breaking existing storage.

Document the recommended production rollout order.

---

# 49. Failure Handling

Plan explicit errors such as:

```text
TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED
TELEGRAM_CRYPTO_KEY_INVALID
TELEGRAM_METADATA_DECRYPT_FAILED
TELEGRAM_METADATA_UNSUPPORTED_VERSION
TELEGRAM_METADATA_MALFORMED
TELEGRAM_METADATA_ENCRYPT_FAILED
```

A single malformed Telegram message must not abort the entire sync run.

---

# 50. Wrong Key

If encrypted metadata exists but the configured key is wrong:

```text
do not silently treat it as valid
```

Report a clear safe error.

Do not overwrite the encrypted metadata.

Do not automatically move the file based on guessed filenames.

---

# 51. Key Rotation

Audit whether key rotation should be included in v1 or deferred.

At minimum, design metadata versioning so future rotation is possible.

Possible future model:

```text
v1:k1:<payload>
v1:k2:<payload>
```

Do not over-engineer rotation if it is unnecessary for the first implementation.

Document the recommendation.

---

# 52. Testing Plan

The implementation plan must include tests for:

## Crypto

```text
encrypt → decrypt
```

returns identical logical metadata.

## Non-deterministic Ciphertext

Same plaintext encrypted twice should produce different ciphertext due to unique nonce/IV.

## Tamper Detection

Modified ciphertext must fail authentication.

## Wrong Key

Decryption must fail safely.

## HMAC Physical Filename

Same stable file identity should generate expected stable physical filename for the configured key.

## Rename

Logical rename must not change physical opaque filename if file-ID-based HMAC is selected.

## Move

Logical move must not change physical opaque filename.

## Legacy Parser

Legacy:

```text
9drive:id=...
9drive:path=...
```

must still parse.

## Legacy Conversion

Convert legacy metadata into encrypted metadata.

## Manual Encrypt Utility

Verify generated output is valid.

## Manual Decrypt Utility

Verify metadata displays correctly.

## Store

New normal upload produces correct physical filename + metadata.

## Remote Import

Remote Import produces the same metadata contract.

## Sync

Encrypted metadata restores correct path.

## WebDAV

WebDAV exposes logical filename, not physical Telegram filename.

## Jellyfin

Telegram-backed media remains playable.

---

# 53. Do Not Use Playwright

Do not use Playwright for this project.

Use existing backend/unit/integration testing infrastructure.

For frontend changes, use the project's existing frontend test/type/lint tooling.

Manual browser verification may be documented where necessary.

---

# 54. Required Audit Report

Create:

```text
docs/audits/telegram-encrypted-metadata-audit.md
```

Include:

## A. Executive Summary

State whether the current architecture is ready for metadata encryption.

## B. Current Telegram Store Flow

Document Normal Upload and Remote Import.

## C. Current Physical Filename Flow

Explain how Telegram filenames are currently generated.

## D. Current Metadata Flow

Explain:

```text
9drive:id
9drive:path
```

generation and parsing.

## E. Sync Integration

Explain where encrypted metadata should be parsed.

## F. WebDAV / Jellyfin Impact

Explain any coupling to physical Telegram filenames.

## G. Existing File Migration

Document legacy scenarios.

## H. Crypto Design

Recommend:

```text
algorithm
key derivation
physical filename strategy
metadata format
versioning
```

## I. In-App Crypto Utility

Design the:

```text
Encrypt
Decrypt
Legacy → Encrypted
```

features.

## J. Manual Repair Workflow

Document exactly how an existing Telegram message can be manually repaired and synced.

## K. Risks

Categorize:

```text
P0 Critical
P1 Important
P2 Improvement
```

## L. Implementation Phases

Provide a concrete phased plan.

---

# 55. Suggested Implementation Phases

After the audit, propose phases similar to:

## Phase 1 — Crypto Foundation

Implement:

```text
TelegramCryptoService
key derivation
AES-256-GCM metadata codec
HMAC physical filename generator
configuration validation
```

## Phase 2 — Legacy-Compatible Metadata Parser

Support:

```text
9drive:meta=v1
legacy 9drive:path
```

## Phase 3 — New Store / Remote Import

Route new Telegram uploads through the centralized crypto service.

## Phase 4 — Sync Support

Decrypt encrypted metadata during Telegram Sync.

Preserve legacy fallback.

## Phase 5 — Rename / Move

Update encrypted metadata without re-uploading the file.

## Phase 6 — In-App Crypto Utility

Implement:

```text
Encrypt
Decrypt
Legacy → Encrypted
```

with authenticated backend APIs.

## Phase 7 — Manual Repair UX

Provide clear copy/paste workflow for existing Telegram messages.

Optional direct Telegram caption update only if proven safe.

## Phase 8 — Migration Tooling

Add optional metadata migration for legacy Telegram messages.

## Phase 9 — WebDAV / Jellyfin Regression

Verify logical filenames remain unchanged externally.

## Phase 10 — Documentation / Rollout

Update:

```text
.env.example
docs/implementation/telegram-drive.md
WebDAV documentation
migration/security documentation
```

Do not blindly follow these phases if the audit reveals a better implementation order.

---

# 56. Acceptance Criteria for the Future Implementation

The future implementation should be considered complete only when:

1. New Telegram physical filenames no longer expose the original filename when obfuscation is enabled.
2. The original filename/path remains recoverable through authenticated encryption.
3. The system does not rely on plain hash reversal.
4. `9drive:id` remains stable.
5. New metadata uses a versioned encrypted format.
6. Legacy `9drive:path` remains supported during migration.
7. Normal Store uses the centralized crypto service.
8. Remote Import uses the same crypto service.
9. HLS/remux output uses the final logical file identity.
10. Rename does not require re-uploading file contents.
11. Move does not require re-uploading file contents.
12. WebDAV still exposes logical filenames.
13. Jellyfin still sees and plays logical media paths.
14. Telegram Sync can decrypt and restore encrypted metadata.
15. Existing plaintext Telegram messages can still sync.
16. The application includes an Encrypt utility.
17. The application includes a Decrypt utility.
18. The application includes Legacy → Encrypted conversion.
19. The master key is never sent to the frontend.
20. The master key is never displayed in the UI.
21. `.env.example` contains placeholders only.
22. Missing/invalid keys fail safely.
23. Wrong-key decrypt attempts fail safely.
24. Authenticated encryption detects tampering.
25. Manual metadata repair works for existing Telegram messages.
26. Manual metadata repair does not require physical filename migration.
27. Optional direct Telegram caption editing is restricted to the configured storage channel.
28. Existing Google/WebDAV behavior is not broken.
29. Existing Telegram remote identities remain valid.
30. Documentation explains key backup requirements.

---

# 57. Important Restrictions

This task is AUDIT + PLAN only.

Do NOT:

- implement encryption yet
- modify existing Telegram messages
- mass-migrate Telegram files
- rename physical Telegram files
- create migrations
- modify database schema
- rewrite Telegram Sync
- break legacy metadata support
- expose the master key
- put the master key in frontend code
- log decrypted secrets
- use custom cryptography
- use plaintext Base64 as "encryption"
- change WebDAV logical filenames
- break Jellyfin
- modify `references/teledrive`
- copy Teledrive code
- use Playwright

Safe read-only inspection and non-destructive tests are allowed.

---

# 58. Final Terminal Summary

Print:

```text
Telegram Encrypted Metadata Audit Complete

Current Physical Filename:
PLAINTEXT / OPAQUE / MIXED

Current Metadata:
PLAINTEXT / PARTIAL / ENCRYPTED

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

Sync:
READY / NEEDS CHANGES

WebDAV:
READY / NEEDS CHANGES

Jellyfin:
READY / NEEDS CHANGES

Legacy Compatibility:
READY / NEEDS CHANGES

In-App Encrypt Utility:
PLANNED / BLOCKED

In-App Decrypt Utility:
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

Recommended Rollout:
...

Implementation Phases:
...
```

The primary deliverable is:

```text
docs/audits/telegram-encrypted-metadata-audit.md
```

The report must end with a concrete implementation plan, but this task must NOT implement that plan yet.
