# Fix Telegram Sync Using Existing 9Drive Path Metadata

## Problem

The Telegram storage implementation already uses this metadata format:

```text
9drive:id=xxx
9drive:path=path/to/file.mkv
```

Telegram synchronization is still placing files into `Recovered from Telegram` even when valid metadata exists.

Do **not** introduce another path metadata format.

The existing format is the canonical Telegram ↔ 9Drive synchronization metadata.

Use `references/teledrive` as read-only reference where useful. Do not modify it, copy its source code, or add it as a dependency.

## Goal

Fix synchronization so:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual path>
```

is correctly parsed and used to restore the original 9Drive location.

Example:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

must produce:

```text
9Drive
└── Movies
    └── Anime
        └── One Piece
            └── episode-01.mkv
```

and not:

```text
Recovered from Telegram/
└── episode-01.mkv
```

## 1. Audit Current Implementation

First inspect the current Telegram implementation.

Locate where `9drive:id=` and `9drive:path=` are:

- generated
- stored
- added to Telegram messages/captions
- parsed
- consumed during synchronization
- mapped to 9Drive files/folders

Also inspect:

- Telegram upload flow
- Telegram remote ID mapping
- file schema
- folder schema
- current sync service
- current `Recovered from Telegram` fallback
- existing path utilities

Determine exactly where the path information is currently lost or ignored.

Do not immediately rewrite the synchronization system.

## 2. Canonical Metadata Format

The canonical format is:

```text
9drive:id=xxx
9drive:path=path/to/file.mkv
```

For example:

```text
9drive:id=abc123
9drive:path=Projects/APP-V/docs/architecture.md
```

Interpret:

```text
9drive:id
    ↓
Exact 9Drive file identity

9drive:path
    ↓
Complete 9Drive virtual file path
```

Do not create a competing metadata format.

## 3. Identity Resolution

Use this order:

```text
1. 9drive:id
2. 9drive:path
3. Existing Telegram remote identity
4. Safe recovery fallback
```

If `9drive:id=abc123` matches an existing 9Drive file, use that exact file.

Do not primarily match using filename, filename + size, Telegram filename, or caption heuristics.

## 4. Path Resolution

`9drive:path=` represents the complete virtual path.

Example:

```text
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

means:

```text
parent path:
Movies/Anime/One Piece

filename:
episode-01.mkv
```

Resolve:

```text
parse path
    ↓
normalize path
    ↓
resolve root
    ↓
resolve each folder
    ↓
create missing folders if necessary
    ↓
return parent folder ID
```

## 5. Dedicated Path Parser

Implement or reuse a dedicated parser, conceptually:

```text
parse9DriveTelegramMetadata()
```

Input:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

Output:

```text
{
    id: "abc123",
    path: "Movies/Anime/One Piece/episode-01.mkv"
}
```

Handle reasonable whitespace/newline variations.

Do not corrupt spaces:

```text
9drive:path=Movies/My Anime/My Video 01.mkv
```

must remain exactly that logical path.

## 6. Folder Resolution

Given:

```text
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

resolve:

```text
Movies
    ↓
Anime
    ↓
One Piece
```

Then assign:

```text
parentFolderId = One Piece ID
filename = episode-01.mkv
```

If folders exist, reuse them.

If intermediate folders do not exist, create them.

Do not fall back to `Recovered from Telegram` merely because a folder is missing.

## 7. Folder Matching

Respect existing 9Drive ownership and hierarchy.

Match using:

```text
owner/account context
parent folder
normalized folder name
```

Do not match globally by folder name.

For example:

```text
Movies/Anime
Documents/Anime
```

must remain separate folders.

Conceptually:

```text
(parentFolderId, normalizedFolderName)
```

is the folder resolution identity.

Use the existing 9Drive folder model and constraints.

## 8. Path Normalization and Security

Normalize:

- `/`
- `\`
- duplicate separators
- leading/trailing separators
- `.`
- `..`

Example:

```text
/Movies//Anime/file.mkv
```

should resolve consistently with:

```text
Movies/Anime/file.mkv
```

Reject or safely handle:

```text
../../outside/file.mkv
```

Never allow the path to escape the user's authorized 9Drive root.

## 9. Synchronization Flow

Required:

```text
Telegram message
        ↓
Read metadata
        ↓
parse 9drive:id
        ↓
parse 9drive:path
        ↓
Find exact 9Drive file by ID
        ↓
Resolve virtual path
        ↓
Find/create parent folders
        ↓
Attach/update file
        ↓
Persist Telegram mapping
```

If `9drive:id` does not exist:

```text
use 9drive:path
    ↓
resolve/create folders
    ↓
create/import file mapping
```

Only use `Recovered from Telegram` when explicit identity/path recovery genuinely fails.

## 10. Recovered from Telegram

Keep `Recovered from Telegram` only as a genuine fallback.

Use it when:

- `9drive:id` is missing
- `9drive:path` is missing
- metadata is malformed
- path traversal is detected
- path cannot be safely resolved
- reconciliation explicitly chooses recovery mode

Do **not** use it simply because the target folder does not exist.

Valid paths must cause missing folders to be created.

## 11. Upload Must Preserve Metadata

When 9Drive uploads a file to Telegram, ensure the storage message contains:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual path>
```

Example:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

Preserve the existing Telegram message/caption format if already implemented.

Do not create another competing metadata format.

## 12. Rename Handling

If:

```text
9drive:path=Movies/Anime/old-name.mkv
```

becomes:

```text
9drive:path=Movies/Anime/new-name.mkv
```

update metadata for the existing Telegram message/file mapping.

Do not upload a second Telegram file.

The stable identity remains:

```text
9drive:id=<same ID>
```

## 13. Move Handling

If:

```text
9drive:path=Movies/Anime/file.mkv
```

moves to:

```text
9drive:path=Movies/Anime/One Piece/file.mkv
```

update metadata for the existing Telegram message.

Do not create a duplicate physical Telegram file.

The same `9drive:id` must continue to identify the same 9Drive file.

## 14. Idempotent Synchronization

Running:

```text
Sync
Sync
Sync
```

must result in:

```text
one 9Drive file
one Telegram mapping
one folder hierarchy
```

No duplicate files or folders.

Use:

```text
9drive:id
```

and Telegram:

```text
channelId + messageId
```

as strong identities.

## 15. Existing Files

If:

```text
9drive:id=abc123
```

points to an existing 9Drive file, reuse that exact record.

Then use:

```text
9drive:path
```

to verify/correct its virtual location.

If the existing file is currently under:

```text
Recovered from Telegram
```

but valid metadata says:

```text
9drive:path=Movies/Anime/file.mkv
```

move/update the existing file record to the correct parent folder instead of creating a new file.

## 16. Missing 9Drive ID

If `9drive:id` does not match an existing 9Drive record but `9drive:path` is valid:

```text
resolve path
    ↓
create missing folders
    ↓
create/import file
    ↓
attach Telegram remote identity
```

Do not immediately send it to `Recovered from Telegram`.

## 17. Missing Path

If:

```text
9drive:id=abc123
```

exists but `9drive:path` is missing, preserve the existing 9Drive location if known.

Do not unnecessarily move the file to `Recovered from Telegram`.

If both identity and path recovery fail, then use the recovery folder.

## 18. Telegram Remote Identity

Continue using the existing Telegram remote identity:

```text
channelId + messageId
```

or the existing provider-specific equivalent.

The two identity layers have different purposes:

```text
9drive:id
    = 9Drive logical file identity

channelId + messageId
    = Telegram physical storage identity
```

Do not confuse them.

## 19. Sync Statistics

Expose path-resolution statistics.

Example:

```text
Telegram Sync Complete

Scanned:
1,250

Matched by 9Drive ID:
1,200

Resolved by Path:
42

Folders Created:
12

Recovered:
3

Missing Remote:
1

Conflicts:
1
```

This makes path-resolution failures visible.

## 20. Logging

Add structured logs such as:

```text
[telegram-sync]

messageId=12345
filename=episode-01.mkv
driveId=abc123
virtualPath=Movies/Anime/One Piece/episode-01.mkv
pathResolution=success
resolvedParentFolderId=...
```

For fallback:

```text
[telegram-sync]

messageId=12345
filename=unknown.bin
pathResolution=failed
reason=no_virtual_path
destination=Recovered from Telegram
```

Never log sensitive Telegram credentials/session data.

## 21. Testing

Create automated tests for:

### Exact ID

```text
9drive:id=abc123
9drive:path=Movies/file.mkv
```

Expected:

```text
existing 9Drive file matched by ID
```

### Nested Path

```text
9drive:path=Movies/Anime/One Piece/file.mkv
```

Expected:

```text
Movies
└── Anime
    └── One Piece
        └── file.mkv
```

### Missing Folder

If `One Piece` is missing, create it and place the file inside it.

### Spaces

```text
9drive:path=My Movies/Anime Episode 01/file name.mkv
```

Path must remain intact.

### Repeated Sync

No duplicate files or folders.

### Rename

Update Telegram metadata while preserving the same 9Drive and Telegram identity.

### Move

Update Telegram metadata without creating a duplicate Telegram file.

### Same Folder Names

Test:

```text
Movies/Anime/file.mkv
Documents/Anime/file.mkv
```

Expected: two separate `Anime` folders.

### Missing Metadata

If neither `9drive:id` nor `9drive:path` exists:

```text
Recovered from Telegram
```

### Invalid Path

```text
9drive:path=../../outside/file.mkv
```

must be rejected.

## 22. Migration / Existing Telegram Files

Do not break Telegram files already stored without path metadata.

For old files without:

```text
9drive:path
```

keep them recoverable through:

```text
Recovered from Telegram
```

or their existing location.

Do not guess their original folder from filename alone.

## 23. Physical Telegram Structure

Keep Telegram physically flat:

```text
Telegram Storage Channel
    ├── file
    ├── file
    ├── file
```

The 9Drive virtual hierarchy remains in the database:

```text
9Drive
    ├── Movies
    │   └── Anime
    └── Documents
```

The metadata:

```text
9drive:id=xxx
9drive:path=path/to/file.mkv
```

is the synchronization bridge.

Do not create Telegram channels/groups for every 9Drive folder.

# Required Execution Workflow

## Step 1 — Plan

Inspect the current implementation first.

Identify:

- current Telegram upload metadata
- current `9drive:id` generation
- current `9drive:path` generation
- current metadata parser
- current Telegram remote ID
- current file/folder schema
- current sync service
- current `Recovered from Telegram` fallback
- existing path utilities

Produce a concise implementation plan explaining exactly why valid `9drive:path` currently ends up in `Recovered from Telegram`.

Do not immediately rewrite unrelated systems.

## Step 2 — Implement

Implement the smallest correct fix using the existing 9Drive architecture.

Prioritize:

1. Correct metadata parsing
2. Exact `9drive:id` matching
3. `9drive:path` resolution
4. Folder lookup/creation
5. Correct parent folder assignment
6. Proper fallback behavior
7. Idempotency
8. Rename/move metadata updates

Do not introduce another path metadata format.

## Step 3 — Test

Run:

- backend tests
- integration tests
- database tests
- synchronization tests
- type checks
- lint

Do not use Playwright unless an existing compatible test setup specifically requires it.

## Step 4 — Report

Update:

```text
docs/implementation/telegram-drive.md
```

Document:

- canonical Telegram metadata format
- `9drive:id` behavior
- `9drive:path` behavior
- folder resolution
- synchronization rules
- fallback behavior
- rename/move handling
- migration behavior
- tests performed

# Final Acceptance Criteria

The implementation is complete only when:

1. `9drive:id=xxx` is parsed correctly.
2. `9drive:path=path/to/file.mkv` is parsed correctly.
3. No alternative competing path metadata format is introduced.
4. `9drive:id` is used as the strongest 9Drive identity.
5. `9drive:path` is used to resolve the virtual folder and filename.
6. Existing folders are correctly resolved.
7. Missing folders are automatically created when the path is valid.
8. Files are assigned to the correct 9Drive parent folder.
9. Valid paths do not end up in `Recovered from Telegram`.
10. `Recovered from Telegram` remains a genuine fallback only.
11. Path normalization is safe.
12. Path traversal is rejected.
13. Repeated synchronization is idempotent.
14. Duplicate files are not created.
15. Duplicate folders are not created.
16. Rename updates Telegram path metadata without creating a duplicate file.
17. Move updates Telegram path metadata without creating a duplicate file.
18. Existing files matched by `9drive:id` are reused.
19. Existing files currently in `Recovered from Telegram` can be moved to their correct path when valid metadata is available.
20. Old Telegram files without path metadata remain recoverable.
21. Telegram physical storage remains a flat storage channel.
22. `9drive:id` represents logical 9Drive identity.
23. Telegram `channelId + messageId` represents physical Telegram identity.
24. Sync statistics expose path-resolution results.
25. Existing storage providers remain unaffected.
26. `references/teledrive` remains untouched.
27. No Teledrive source code is copied into production.
28. Documentation and regression tests are included.
