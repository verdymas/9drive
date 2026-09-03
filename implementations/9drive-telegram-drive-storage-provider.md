# Implement Telegram Drive Storage Provider

## Objective

Implement Telegram Drive support in 9Drive by adapting the proven concepts discovered from the read-only reference:

```text
references/teledrive
```

The Teledrive repository and its implementation analysis are reference material only.

Do NOT copy Teledrive code directly.

Do NOT modify:

```text
references/teledrive
```

Do NOT add Teledrive as a dependency.

Adapt the relevant concepts to the existing 9Drive architecture, conventions, authentication model, database patterns, storage abstraction, UI, queues, and security model.

---

# Critical Product Decision

Telegram must be implemented as an additional storage provider.

Do NOT redesign 9Drive around Telegram.

Existing storage providers and existing architecture must continue working.

Target architecture:

```text
9Drive
   |
   +-- Storage Provider
   |      |
   |      +-- Existing Providers
   |      |
   |      +-- Telegram
   |
   +-- File System
   |
   +-- Remote Import
   |
   +-- Worker Relay
```

Telegram is a storage backend, not a replacement for the existing storage system.

---

# Important Telegram Size / Quota Rule

We do NOT know or want to assume a Telegram storage quota.

Therefore DO NOT implement:

```text
availableSize
freeSize
remainingQuota
quotaPercentage
used / total
```

for Telegram.

Do NOT show:

```text
Telegram:
500 GB / 2 TB
```

Do NOT calculate an artificial Telegram quota.

Instead, Telegram storage should expose only:

```text
Total Stored Size
```

Example:

```text
Telegram Drive

Files: 1,245
Total Size: 384.6 GB
```

The total is the sum of files known/indexed by 9Drive.

For the generic storage abstraction, make quota fields optional/capability-based so Telegram does not need to pretend that it has quota information.

Conceptual model:

```ts
StorageUsage {
    totalSize: number
    fileCount: number
    availableSize?: number | null
    totalCapacity?: number | null
}
```

For Telegram:

```text
totalSize       = calculated/indexed stored file size
fileCount       = indexed file count
availableSize   = null
totalCapacity   = null
```

UI must gracefully handle providers without quota information.

---

# Phase 0 — Mandatory Audit Before Coding

First inspect the current 9Drive implementation.

Do NOT immediately start modifying code.

Audit:

## Backend

Inspect:

- storage module
- provider abstraction
- file model
- folder model
- file upload flow
- file download/stream flow
- delete flow
- background workers
- queues
- database schema
- account/provider settings
- authentication/security
- API routes

## Frontend

Inspect:

- storage provider settings
- connected account UI
- file browser
- upload UI
- file details
- quota/usage UI
- settings
- notifications/error handling

## Existing patterns

Identify reusable patterns for:

```text
Provider CRUD
Provider connection test
Provider status
Provider credentials
Encrypted credentials
Storage upload
Storage download
Storage delete
Storage usage
Background jobs
Retry handling
```

Do not duplicate an existing abstraction if one already exists.

---

# Phase 1 — Telegram Provider Architecture

Create Telegram as a first-class storage provider.

Prefer a structure similar to:

```text
Storage
├── Contracts
├── Providers
│   ├── ExistingProviders
│   └── Telegram
│       ├── TelegramStorageProvider
│       ├── TelegramClient
│       ├── TelegramAuthService
│       ├── TelegramFileService
│       ├── TelegramMessageService
│       └── TelegramUsageService
└── StorageManager
```

Adapt naming to the existing 9Drive architecture.

Do not blindly copy this structure if 9Drive already has an equivalent pattern.

The important requirement is separation of responsibilities.

---

# Phase 2 — Telegram Authentication

The Teledrive analysis shows that its implementation uses:

```text
Telethon
MTProto
user account
phone
OTP
optional 2FA
StringSession
```

Use this as the reference concept.

Do NOT assume Bot API is sufficient.

Before implementation, verify the existing 9Drive runtime/container supports the required Telegram client technology.

Potential flow:

```text
Add Telegram Storage
        |
        v
API ID + API Hash
        |
        v
Phone Number
        |
        v
Request OTP
        |
        v
Verify OTP
        |
        +----> 2FA required
        |          |
        |          v
        |       Password
        |
        v
Authenticated
```

Credentials/session must never be exposed to the frontend after authentication.

Store sensitive values encrypted using the existing 9Drive encryption mechanism.

Do not introduce a second unrelated encryption system unless technically required.

---

# Phase 3 — Telegram Connection Model

A Telegram storage connection should contain enough information to reconnect without asking the user to authenticate repeatedly.

Conceptually:

```text
Telegram Storage Connection

id
name
provider = telegram
status
encrypted API ID
encrypted API Hash
encrypted session
channel/chat identifier
metadata
createdAt
updatedAt
```

Adapt to the existing provider/account schema.

Do not store:

- raw OTP
- plaintext passwords
- plaintext session
- unnecessary Telegram secrets

---

# Phase 4 — Private Storage Channel

Follow the Teledrive concept:

```text
Telegram Account
        |
        v
Private Storage Channel
        |
        v
Documents
```

The channel is the physical blob storage.

9Drive's database remains the source of truth for the virtual folder hierarchy.

Important:

Telegram itself does NOT need to represent the 9Drive folder structure.

Example:

```text
9Drive:

Movies/
    movie-a.mkv
    movie-b.mkv

Documents/
    report.pdf
```

Telegram can remain physically flat:

```text
Telegram Channel:

movie-a.mkv
movie-b.mkv
report.pdf
```

The 9Drive database maps:

```text
file
  |
  +-- parent folder
  |
  +-- Telegram message ID
```

---

# Phase 5 — Telegram File Identity

Use a provider-specific remote identity.

Recommended conceptual format:

```text
telegram://<channel-id>/<message-id>
```

Adapt this to existing 9Drive remote ID conventions.

The remote ID must allow 9Drive to retrieve the Telegram document later.

Persist where appropriate:

```text
provider
remoteId
messageId
channelId
filename
mimeType
size
```

---

# Phase 6 — Upload Pipeline

Implement:

```text
9Drive Upload
      |
      v
Telegram Storage Provider
      |
      v
Telegram MTProto
      |
      v
Private Channel
      |
      v
Message / Document
      |
      v
Persist Telegram Remote ID
```

Follow the consistency rule from Teledrive:

Do not remove temporary/local state until the provider mapping has been successfully committed.

If 9Drive already streams directly to storage, preserve that architecture where possible.

Do NOT blindly introduce Teledrive's local staging architecture.

The existing 9Drive direct-streaming architecture remains the preferred approach.

---

# Phase 7 — Download / Streaming

Implement Telegram file retrieval through the backend.

Conceptually:

```text
GET /files/:id/download
        |
        v
StorageManager
        |
        v
Telegram Provider
        |
        v
MTProto download/stream
        |
        v
HTTP response
```

Support:

- streaming
- correct MIME type
- Content-Disposition
- filename
- large files without loading everything into memory

Do not create a permanent public Telegram URL as the primary file URL.

Telegram should remain behind the 9Drive storage abstraction.

---

# Phase 8 — Delete

Implement:

```text
9Drive Delete
      |
      v
Database state
      |
      v
Telegram message deletion
```

Use the existing 9Drive deletion/retry architecture where available.

If the existing system does not have durable provider deletion jobs, adapt the Teledrive concept:

```text
pending
processing
failed
completed
```

with:

```text
attempts
nextAttemptAt
lastError
processing lease
```

Use capped exponential backoff.

Do not create duplicate deletion systems if 9Drive already has an equivalent mechanism.

---

# Phase 9 — Telegram Indexing / Recovery

Implement provider indexing.

Telegram is physically flat.

The database remains the primary source of truth.

Indexing should be used for:

- recovery
- reconciliation
- detecting missing remote files
- importing existing Telegram documents if supported

For each Telegram document, extract:

```text
message ID
filename
size
mime type
channel ID
Telegram file identity
```

Fallback filename:

```text
telegram-document-<message-id>
```

Do not assume Telegram can reconstruct the original 9Drive folder tree.

If a recovery/import feature is implemented, place recovered files into:

```text
Recovered from Telegram
```

---

# Phase 10 — Storage Usage

Implement Telegram usage differently from quota-based providers.

Telegram usage should show:

```text
Total Stored Size
```

calculated from indexed 9Drive files.

Example:

```text
Telegram Drive

Files
1,245

Total Stored Size
384.6 GB
```

Do NOT show:

```text
Available
Remaining
Capacity
Quota
Percentage Used
```

unless Telegram actually provides reliable quota information in the future.

Generic UI components must handle:

```text
availableSize = null
totalCapacity = null
```

without rendering misleading values.

---

# Phase 11 — Provider Status

Expose Telegram readiness:

```text
Connected
Ready
Authentication Required
Disconnected
Error
```

Example:

```text
Telegram Drive
Connected
Ready
1,245 files
384.6 GB stored
```

If authentication expires:

```text
Telegram Drive
Authentication Required
Reconnect Telegram
```

Do not silently mark all files as failed.

---

# Phase 12 — File Browser Integration

Telegram files must appear in the existing 9Drive file browser.

Do NOT create a completely separate file browser implementation.

Existing:

```text
Files
Folders
Search
Preview
Download
Delete
Move
Rename
```

should continue to work.

The user should not need to know whether a file is physically stored on:

```text
Google Drive
S3
Telegram
```

unless provider information is explicitly shown.

---

# Phase 13 — Storage Provider UI

Add Telegram to the existing storage provider management screen.

Example:

```text
Storage Providers

+ Add Storage

Google Drive
Connected

S3
Connected

Telegram Drive
Connected
384.6 GB stored
```

Add where supported by the existing provider UX:

```text
Connect
Test Connection
Reconnect
Disconnect
Delete
```

---

# Phase 14 — Remote Import Integration

Integrate Telegram as a storage target for Remote Import.

Existing flow:

```text
Remote URL
    |
    v
Probe
    |
    v
Download
    |
    v
Remux if necessary
    |
    v
Storage
```

Add:

```text
Telegram Drive
```

as a possible destination.

Example:

```text
Remote Import

URL:
https://example.com/video.m3u8

Worker:
Cloudflare Worker

Storage Target:
Telegram Drive

Filename:
Movie Name 1080p.mkv
```

Do not bypass the existing Worker Relay architecture.

Worker selection remains independent from storage selection.

---

# Phase 15 — HLS / Remux Compatibility

Telegram storage must receive the final output generated by the existing Remote Import pipeline.

Do NOT make Telegram responsible for:

- HLS parsing
- segment downloading
- remuxing
- FFmpeg
- Worker Relay

Architecture remains:

```text
Remote Import
    |
    +-- Direct / Worker
    |
    +-- HLS Downloader
    |
    +-- FFmpeg Remux
    |
    v
Storage Provider
    |
    +-- Google
    +-- S3
    +-- Telegram
```

---

# Phase 16 — Provider Abstraction

Ensure the existing storage abstraction can represent Telegram without Telegram-specific conditionals scattered throughout the application.

Avoid:

```ts
if (provider === "telegram") ...
```

everywhere.

Prefer:

```text
StorageManager
    |
    v
StorageProvider
    |
    +-- GoogleProvider
    +-- S3Provider
    +-- TelegramProvider
```

Provider-specific behavior belongs inside the provider implementation.

---

# Phase 17 — Error Handling

Handle Telegram-specific failures cleanly.

Examples:

```text
AUTH_REQUIRED
SESSION_INVALID
TELEGRAM_FLOOD_WAIT
TELEGRAM_UPLOAD_FAILED
TELEGRAM_DOWNLOAD_FAILED
TELEGRAM_DELETE_FAILED
TELEGRAM_CHANNEL_UNAVAILABLE
TELEGRAM_FILE_NOT_FOUND
```

Return user-friendly errors.

Do not expose raw stack traces.

For FloodWait:

```text
Telegram requested a temporary wait.
Retry after X seconds.
```

Integrate with existing retry infrastructure where appropriate.

---

# Phase 18 — Security

Review:

- credential encryption
- session encryption
- API authentication
- authorization
- ownership checks
- provider isolation
- logging

Never log:

- Telegram session strings
- API hashes
- passwords
- OTP
- authorization tokens

Logs may contain:

```text
provider
operation
provider account ID
file ID
message ID
status
duration
error code
correlation ID
```

Avoid sensitive values.

---

# Phase 19 — Database Migration

Create the minimum schema changes required by the existing 9Drive architecture.

Do not copy Teledrive's database schema.

Preserve existing:

```text
Folder
FolderStorageLocation
File
Connected Account
```

relationships.

Add only Telegram-specific fields/entities where necessary.

Migration must be reversible where practical.

---

# Phase 20 — Testing

Create automated tests for:

## Authentication

```text
API credentials
OTP
2FA
session persistence
reconnect
invalid session
```

## Provider

```text
connect
test connection
status
upload
download
stream
delete
list/index
usage
```

## Usage

Verify:

```text
totalSize
fileCount
availableSize = null
totalCapacity = null
```

The UI must not display fake quota values.

## Remote Import

Test:

```text
Remote URL
+
Worker
+
Telegram Storage
```

Verify the resulting file is stored in Telegram and appears in the 9Drive file browser.

---

# Phase 21 — Failure Recovery

Test:

```text
Telegram unavailable
Upload fails
Download fails
Delete fails
Session expires
FloodWait occurs
Worker restarts
Backend restarts
```

Ensure state does not become inconsistent.

Example:

```text
File exists in Telegram
but DB update failed
```

must be recoverable/reconcilable.

---

# Phase 22 — UI/UX Review

Follow existing 9Drive design system.

Do not introduce a separate visual language copied from Teledrive.

The user should understand:

```text
Telegram Drive
Connected
1,245 files
384.6 GB stored
```

without seeing misleading quota information.

---

# Implementation Constraints

Do not:

- modify `references/teledrive`
- copy Teledrive source code
- add Teledrive as dependency
- replace existing storage providers
- replace existing direct streaming
- introduce unnecessary local staging
- introduce fake Telegram quota
- duplicate existing abstractions
- scatter Telegram-specific logic throughout unrelated modules

Do:

- reuse existing 9Drive abstractions
- adapt Teledrive concepts
- keep Telegram implementation isolated
- preserve existing providers
- use encrypted credentials
- use durable retries where necessary
- support provider readiness/status
- expose only reliable Telegram usage metrics

---

# Required Execution Workflow

## Step 1 — Plan

First inspect the repository and produce a detailed implementation plan.

The plan must include:

```text
Architecture changes
Database changes
Backend changes
Frontend changes
API changes
Worker/queue changes
Security changes
Testing strategy
Migration strategy
```

Do not execute yet.

## Step 2 — Review Plan

Check the plan against:

```text
references/teledrive
```

and the existing 9Drive architecture.

Remove unnecessary duplication.

Make sure Telegram is implemented as a storage provider, not as a separate application.

## Step 3 — Execute

After the plan is internally validated, implement the changes.

Keep changes logically separated where practical.

## Step 4 — Test

Run relevant:

- backend tests
- frontend tests
- type checks
- lint
- database migration checks
- integration tests

Do not use Playwright for this phase unless there is already a compatible test setup specifically intended for this feature.

## Step 5 — Report

Create:

```text
docs/implementation/telegram-drive.md
```

Include:

- implemented architecture
- database changes
- API endpoints
- authentication flow
- storage flow
- upload/download flow
- Remote Import integration
- usage calculation
- retry/error handling
- security considerations
- tests performed
- known limitations
- future improvements

---

# Final Acceptance Criteria

The implementation is complete when:

1. Telegram can be connected as a 9Drive storage provider.

2. Telegram authentication/session is securely stored.

3. Telegram uses a private storage channel/account according to the chosen implementation.

4. Files can be uploaded to Telegram.

5. Files can be downloaded/streamed through 9Drive.

6. Files can be deleted.

7. Telegram files appear normally in the existing 9Drive file browser.

8. Existing folders remain database-driven and are not physically recreated in Telegram.

9. Remote Import can select Telegram as the storage destination.

10. Remote Import Worker selection remains independent from storage selection.

11. Telegram provider status is visible.

12. Telegram usage displays only:

```text
Total Stored Size
```

and never invents:

```text
Available Size
Total Capacity
Quota
Percentage Used
```

13. Existing Google/S3/local storage functionality remains unaffected.

14. Telegram-specific logic is isolated behind the storage abstraction.

15. Sensitive Telegram credentials/session data are encrypted.

16. Telegram API failures are handled gracefully.

17. Retryable operations are durable where appropriate.

18. No Teledrive code is copied into production.

19. `references/teledrive` remains untouched.

20. Documentation and tests are included.

The final architecture should make Telegram feel like a native 9Drive storage provider rather than a separately implemented Telegram application.
