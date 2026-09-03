# Fix Telegram Drive Storage — Use Dedicated Private Storage Channel

## Problem

The current Telegram Drive implementation stores uploaded files in the user's own Telegram/Saved Messages/personal chat.

Required architecture:

```text
9Drive
    ↓
Telegram Storage Provider
    ↓
Dedicated Private Storage Channel
    ↓
File Message
```

Never silently use Saved Messages as a fallback.

Use `references/teledrive` and the previous Teledrive analysis as read-only reference. Do not modify it, copy its source code, or add it as a dependency.

---

## Goal

Fix Telegram storage so files are stored in a dedicated private Telegram storage channel instead of the user's personal Telegram chat.

## 1. Audit Current Implementation

Before changing code, trace:

```text
9Drive upload
→ StorageManager
→ TelegramStorageProvider
→ TelegramClient
→ Telegram API / MTProto
→ target chat/channel
```

Find exactly where the destination is selected and why the current implementation targets Saved Messages/personal chat.

Do not assume the cause.

## 2. Storage Channel Model

Telegram storage must have a dedicated destination.

Conceptually:

```text
Telegram Account
        |
        +-- Storage Channel
              |
              +-- file message
              +-- file message
              +-- file message
```

Persist the configured storage channel identifier using the existing 9Drive provider architecture. Do not hardcode it.

## 3. Storage Channel Setup

The Telegram provider UX should support:

```text
Telegram Drive

Telegram Account
Connected

Storage Channel
[ Select / Create ]

[ Create Private Storage Channel ]
```

If technically supported by the Telegram client/API, allow 9Drive to create a private channel automatically, verify access, and persist its ID.

Otherwise allow the user to select an existing private channel where the authenticated account has sufficient permissions.

## 4. Existing Channel Support

Support an existing private channel.

Conceptual UI:

```text
Storage Channel

○ Create new private channel
○ Use existing private channel

Existing Channel:
[ 9Drive Storage ▼ ]

[ Test Connection ]
```

Validate:

- access
- read capability
- write capability
- file retrieval
- delete capability where required

If the channel cannot be used, return a clear error.

## 5. Never Default to Saved Messages

This is critical.

Remove any implicit fallback such as:

```text
chat_id = self
```

or equivalent.

Never use:

```text
Saved Messages
```

as a storage destination.

If no storage channel is configured, return an error such as:

```text
TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED
```

Never silently upload somewhere else.

## 6. Upload Flow

Required:

```text
9Drive Upload
        ↓
StorageManager
        ↓
TelegramStorageProvider
        ↓
Configured Storage Channel ID
        ↓
Telegram send/upload document
        ↓
Storage Channel Message
        ↓
Persist message ID + file ID
```

Persist remote identity after successful upload.

Conceptual metadata:

```text
provider = telegram
channelId = -100xxxxxxxxxx
messageId = 12345
telegramFileId = ...
filename = movie.mkv
size = ...
mimeType = video/x-matroska
```

Adapt names to the existing database architecture.

## 7. Remote File Identity

The remote identity must include storage-channel context.

Do not identify a Telegram file only by `file_id`.

Prefer:

```text
channelId + messageId
```

or the existing provider-specific remote ID convention.

Conceptual:

```text
telegram://<channel-id>/<message-id>
```

## 8. Download Flow

Required:

```text
9Drive File
    ↓
TelegramStorageProvider
    ↓
channelId + messageId
    ↓
Telegram message
    ↓
Telegram document
    ↓
stream/download
    ↓
User
```

Do not search Telegram globally by filename.

Support:

- streaming
- correct MIME type
- Content-Disposition
- filename
- large files without loading everything into memory

## 9. Delete Flow

Required:

```text
9Drive File
    ↓
TelegramStorageProvider
    ↓
channelId + messageId
    ↓
Delete storage message
```

Use the existing retry/deferred deletion architecture. Never delete unrelated messages.

## 10. Indexing

Index only the configured storage channel.

Never scan:

```text
personal chats
Saved Messages
unrelated groups
unrelated channels
```

Required:

```text
Configured Storage Channel
        ↓
Telegram Messages
        ↓
Documents
        ↓
9Drive Index
```

This prevents unrelated Telegram files from appearing in 9Drive.

## 11. Recovery / Reconciliation

If a document exists in the configured storage channel but is missing from the 9Drive database, it may be handled as:

```text
Recovered from Telegram
```

if recovery is implemented.

Do not import arbitrary Telegram account files. Only reconcile against the configured storage channel.

## 12. Usage Calculation

Keep the existing product decision.

We do NOT know or want to assume a Telegram storage quota.

Show only:

```text
Total Stored Size
File Count
```

Example:

```text
Telegram Drive

Files
1,245

Total Stored Size
384.6 GB
```

Do NOT display:

```text
Available Size
Free Space
Remaining Quota
Capacity
Percentage Used
```

For Telegram:

```text
availableSize = null
totalCapacity = null
```

The generic UI must gracefully handle providers without quota information.

## 13. Connection Test

"Test Connection" must validate the actual storage channel, not only Telegram account authentication.

Verify:

```text
authenticated account
        ↓
configured storage channel
        ↓
read access
        ↓
write capability
        ↓
file/message access
        ↓
delete capability where applicable
```

Example:

```text
Telegram Account: OK
Storage Channel: OK
Read: OK
Write: OK
Delete capability: OK
```

Do not create unnecessary permanent test files. If a temporary test message is necessary, remove it afterward.

## 14. Provider Status

Support statuses such as:

```text
Connected
Storage Channel Required
Storage Channel Invalid
Storage Channel Read Only
Ready
Authentication Required
Error
```

Example:

```text
Telegram Drive
Connected

Storage Channel:
9Drive Storage

Status:
Ready

Files:
1,245

Total Stored Size:
384.6 GB
```

## 15. Frontend UX

Use the existing 9Drive design system.

Example:

```text
Telegram Drive

Account
Connected

Storage Channel
9Drive Storage

Channel ID
Configured

Status
Ready

Files
1,245

Total Stored Size
384.6 GB

[ Test Connection ]
[ Change Channel ]
[ Reconnect ]
[ Disconnect ]
```

Do not display the user's personal Telegram chat as the storage location.

## 16. Security

Never expose or log:

- API hash
- session string
- OTP
- Telegram password
- authentication secrets

Safe operational logs may contain:

```text
provider
operation
provider account ID
channel ID when safe
message ID
status
duration
error code
correlation ID
```

## 17. Regression Tests

### Test 1 — Upload

Configure:

```text
Telegram Account
+
Private Storage Channel
```

Upload:

```text
test.txt
```

Expected:

```text
File appears in the dedicated private storage channel.
```

Must NOT appear in:

```text
Saved Messages
personal chat
```

### Test 2 — Download

Upload a file and download through 9Drive.

Expected:

```text
download succeeds
```

### Test 3 — Delete

Delete through 9Drive.

Expected:

```text
9Drive record removed
Telegram storage message removed
```

### Test 4 — Indexing

Put documents into the configured storage channel.

Run indexing.

Expected:

```text
Only documents from the configured storage channel are indexed.
```

Files from personal chats must NOT appear.

### Test 5 — Missing Channel

Remove/unconfigure the storage channel.

Attempt upload.

Expected:

```text
TELEGRAM_STORAGE_TARGET_NOT_CONFIGURED
```

Must NOT fall back to Saved Messages.

### Test 6 — Invalid Channel

Configure a channel the Telegram account cannot access or write to.

Expected:

```text
Storage channel validation failed.
```

No file should be uploaded elsewhere.

## 18. Remote Import

Ensure:

```text
Remote URL
    ↓
Direct / Worker
    ↓
HLS / File Download
    ↓
Remux if required
    ↓
Telegram Storage Provider
    ↓
Dedicated Storage Channel
```

Worker selection remains independent from Telegram storage.

## 19. Architecture Rule

Do not introduce Telegram-specific logic throughout Remote Import.

Remote Import should continue using the existing:

```text
StorageManager
```

or equivalent storage abstraction.

Conceptually:

```text
RemoteImport
    ↓
StorageManager
    ↓
StorageProvider
    ├── Local
    ├── S3
    ├── Google
    └── Telegram
```

Telegram-specific channel logic belongs inside `TelegramStorageProvider` and supporting services.

## Required Execution Workflow

### Step 1 — Plan

First inspect the current implementation.

Produce a plan covering:

- current destination logic
- why Saved Messages is being used
- database changes
- provider changes
- channel setup
- upload
- download
- delete
- indexing
- connection test
- frontend changes
- testing

Do not execute immediately.

### Step 2 — Implement

After the plan is validated, implement the fix.

Reuse existing 9Drive abstractions. Do not rewrite unrelated systems.

### Step 3 — Test

Run:

- backend tests
- integration tests
- type checks
- lint
- database checks

Do not use Playwright unless an existing compatible setup specifically requires it.

### Step 4 — Report

Update:

```text
docs/implementation/telegram-drive.md
```

Document:

- storage channel architecture
- authentication
- channel setup
- upload
- download
- delete
- indexing
- usage
- error handling
- tests
- known limitations

## Final Acceptance Criteria

The feature is correct only when:

1. Telegram files are stored in a dedicated private storage channel.
2. Saved Messages is never used as a silent fallback.
3. Existing private channels can be selected where supported.
4. 9Drive can create/configure a private storage channel where supported.
5. The selected storage channel is persisted.
6. Upload uses the configured storage channel.
7. Download uses channel/message identity.
8. Delete removes the correct storage message.
9. Indexing only scans the configured storage channel.
10. Personal Telegram chats are never indexed as 9Drive storage.
11. Connection testing validates the actual storage channel.
12. Remote Import can upload to Telegram through the normal StorageProvider abstraction.
13. Worker Relay remains independent from Telegram storage.
14. Telegram usage shows only Total Stored Size and File Count.
15. No fake Telegram quota or available storage is displayed.
16. Existing storage providers remain unaffected.
17. `references/teledrive` remains untouched.
18. No Teledrive source code is copied into production.
19. Sensitive Telegram credentials/session data remain encrypted.
20. Documentation and regression tests are included.
