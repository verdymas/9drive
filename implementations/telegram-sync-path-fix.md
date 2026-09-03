# Fix Telegram Sync — Correct `9drive:id` / `9drive:path` Mapping

## Objective

Fix ONLY the Telegram synchronization/reconciliation flow.

The canonical Telegram metadata format is:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual file path>
```

The current problem is that Telegram Sync does not correctly restore Telegram files to their original 9Drive files/folders.

Do not redesign Telegram storage.
Do not introduce another metadata format.
Do not modify `references/teledrive`.

Use `references/teledrive` only as a read-only reference if useful.

---

## 1. Audit Before Fixing

Start by inspecting the current Telegram Sync implementation.

Trace:

```text
Telegram Storage Channel
        ↓
Telegram message scan
        ↓
Message metadata extraction
        ↓
Parse 9drive:id
        ↓
Parse 9drive:path
        ↓
Find 9Drive file
        ↓
Resolve 9Drive parent folder
        ↓
Create/update/move file
        ↓
Persist Telegram mapping
```

Identify exactly why files are currently not restored correctly.

Produce a short plan first, then implement.

---

## 2. Canonical Metadata

The only canonical metadata format is:

```text
9drive:id=xxx
9drive:path=path/to/file.mkv
```

Example:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

Interpret:

```text
9drive:id
    =
9Drive logical file identity

9drive:path
    =
complete 9Drive virtual path
```

Do not interpret `9drive:path` as a Telegram path, Telegram filename, filesystem path, Docker path, storage disk path, or remote URL.

---

## 3. Sync Must Start With `9drive:id`

When Telegram Sync sees:

```text
9drive:id=abc123
```

first attempt:

```text
Find 9Drive file where ID = abc123
```

If found:

```text
USE EXISTING FILE
```

Do not create a new file.
Do not use `Recovered from Telegram`.
Do not match by filename first.

---

## 4. Then Resolve `9drive:path`

For the existing file matched by `9drive:id`, read:

```text
9drive:path
```

Example:

```text
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

Split into:

```text
parent path:
Movies/Anime/One Piece

filename:
episode-01.mkv
```

Resolve the 9Drive folder hierarchy.

---

## 5. Existing File in Wrong Folder

Example:

```text
Database:
file ID = abc123
current location = Recovered from Telegram/episode-01.mkv

Telegram:
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

Expected:

```text
Move/update the EXISTING file record

Recovered from Telegram/episode-01.mkv
        ↓
Movies/Anime/One Piece/episode-01.mkv
```

Do NOT create a second file.

---

## 6. Missing Parent Folder

Example:

```text
9drive:path=Movies/Anime/One Piece/episode-01.mkv
```

If `Movies` and `Anime` exist but `One Piece` does not:

```text
Create One Piece
        ↓
Place existing/new file inside One Piece
```

Do not use `Recovered from Telegram` merely because the folder does not exist.

---

## 7. Missing Entire Folder Hierarchy

Example:

```text
9drive:path=Projects/2026/Reports/September/report.pdf
```

If none of the folders exist, create:

```text
Projects
└── 2026
    └── Reports
        └── September
            └── report.pdf
```

Respect the existing 9Drive root, owner, account, and folder model.

---

## 8. Hierarchical Folder Resolution

Never resolve a folder globally by name.

Incorrect:

```text
find folder where name = Anime
```

Correct:

```text
root
  ↓
Movies
  ↓
Anime
  ↓
One Piece
```

Folder identity must respect:

```text
owner/account
parent folder
folder name
```

`Movies/Anime` and `Documents/Anime` must remain separate.

---

## 9. Path Parsing

Implement or reuse a dedicated metadata parser.

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

The parser must support:

- LF
- CRLF
- reasonable whitespace
- additional caption text
- spaces in paths
- Unicode
- `=` inside filenames

Split metadata values only on the FIRST `=`.

Example:

```text
9drive:path=Movies/file=name.mkv
```

must produce:

```text
Movies/file=name.mkv
```

not `Movies/file`.

---

## 10. Path Normalization and Security

Normalize safely:

```text
/
\
duplicate separators
leading/trailing separators
.
..
```

Example:

```text
/Movies//Anime/file.mkv
```

should resolve consistently with:

```text
Movies/Anime/file.mkv
```

Preserve meaningful spaces and filename characters.

Reject:

```text
../../outside/file.mkv
../../../etc/passwd
```

Never allow Telegram metadata to escape the user's 9Drive root.

---

## 11. Resolution Order

Use:

```text
1. 9drive:id
2. Telegram remote identity
3. 9drive:path
4. safe recovery
```

Important: `9drive:id` is the strongest logical identity.

`9drive:path` is primarily the location.

If `9drive:id` matches an existing file, reuse that file and use `9drive:path` to verify/correct its location.

---

## 12. `Recovered from Telegram`

Keep:

```text
Recovered from Telegram
```

only as a genuine fallback.

Use it when:

- `9drive:id` is missing
- `9drive:path` is missing
- metadata is malformed
- path traversal is detected
- path cannot be safely resolved
- reconciliation explicitly chooses recovery

Do NOT use it merely because:

- a folder does not exist
- the file is currently in another folder
- the path requires folder creation
- the Telegram filename differs

---

## 13. Root-Level Files

Handle:

```text
9drive:path=movie.mkv
```

as:

```text
parent = user's 9Drive root
filename = movie.mkv
```

Do not put it into `Recovered from Telegram` when the path is valid.

---

## 14. Filename Source

When `9drive:path` exists, the logical filename should be the basename of that path.

Example:

```text
9drive:path=Movies/Anime/My Movie 1080p.mkv
```

Expected:

```text
parent = Movies/Anime
filename = My Movie 1080p.mkv
```

Do not silently replace it with the Telegram filename, original remote filename, or temporary filename.

---

## 15. Remote Import

Verify that files originally created through Remote Import eventually contain:

```text
9drive:id=<actual created 9Drive file ID>
9drive:path=<actual final virtual path>
```

Example:

```text
Remote Import
    ↓
destination = Movies/Anime
    ↓
filename = My Movie.mkv
    ↓
create 9Drive file
    ↓
Telegram upload
```

Expected:

```text
9drive:id=<created file ID>
9drive:path=Movies/Anime/My Movie.mkv
```

Worker/Direct transport must not change the logical path.

---

## 16. Normal Store

Verify normal uploads use the same metadata contract:

```text
9drive:id=<actual 9Drive file ID>
9drive:path=<actual final virtual path>
```

Normal Store and Remote Import should converge on the same Telegram metadata format.

---

## 17. Rename

If:

```text
9drive:id=abc123
9drive:path=Movies/old.mkv
```

becomes:

```text
9drive:id=abc123
9drive:path=Movies/new.mkv
```

the same logical file and Telegram physical message should be retained.

Do not create a duplicate file.

---

## 18. Move

If:

```text
9drive:id=abc123
9drive:path=Movies/Anime/file.mkv
```

becomes:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/file.mkv
```

update the existing mapping/path.

Do not create another Telegram file.

---

## 19. Idempotency

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

No duplicate files.
No duplicate folders.

---

## 20. Telegram Physical Identity

Keep identities separate:

```text
9drive:id
    =
9Drive logical file identity

channelId + messageId
    =
Telegram physical storage identity
```

Do not use `9drive:path` as the physical Telegram lookup identity.

---

## 21. Missing ID / Missing Path

### Missing ID

If:

```text
9drive:id
```

is missing but:

```text
9drive:path
```

exists, resolve the path and use any safe existing Telegram mapping where available.

### Missing Path

If:

```text
9drive:id=abc123
```

matches an existing file but `9drive:path` is missing, preserve the existing 9Drive location.

Do not unnecessarily move it to recovery.

---

## 22. Sync Statistics

Expose or log:

```text
Scanned
Matched by 9drive:id
Matched by Telegram remote ID
Resolved by 9drive:path
Folders created
Files moved
Files imported
Recovered
Missing
Conflicts
Errors
```

Example:

```text
Telegram Sync Complete

Scanned: 1250
Matched by 9drive:id: 1198
Resolved by path: 42
Folders created: 12
Files moved: 8
Recovered: 2
Missing: 0
Conflicts: 0
Errors: 0
```

---

## 23. Logging

Add structured logs such as:

```text
[telegram-sync]
messageId=12345
driveId=abc123
virtualPath=Movies/Anime/One Piece/episode-01.mkv
matchStrategy=9drive_id
pathResolution=success
parentFolderId=...
action=updated_location
```

For fallback:

```text
[telegram-sync]
messageId=12345
driveId=
virtualPath=
matchStrategy=none
pathResolution=failed
reason=missing_metadata
action=recovered
```

Never log Telegram session strings, API hashes, OTPs, passwords, or authentication secrets.

---

## 24. Database Consistency

Inspect partial database update scenarios.

Avoid states where:

```text
Telegram mapping → file A
9Drive mapping → file B
```

Use existing transaction boundaries where appropriate.

Do not introduce a new persistence architecture.

---

## 25. Do Not Download Files During Metadata Sync

Telegram synchronization should normally operate on metadata only.

Do not download entire Telegram files merely to resolve:

```text
id
path
folder
filename
```

unless the existing architecture explicitly requires content verification.

---

## 26. Testing

Add/update tests for:

### Exact ID + Path

```text
9drive:id=abc123
9drive:path=Movies/Anime/file.mkv
```

Expected:

```text
existing file matched
correct parent folder
correct filename
```

### Existing File in Recovery Folder

Expected:

```text
existing file moved to correct location
no duplicate
```

### Missing Folder

Expected:

```text
folder created
file placed correctly
```

### Root-Level Path

```text
9drive:path=file.mkv
```

Expected:

```text
user root/file.mkv
```

### Spaces

```text
9drive:path=My Movies/My Video 1080p.mkv
```

Expected exact path preservation.

### `=` in Filename

```text
9drive:path=Movies/file=name.mkv
```

Expected exact filename.

### CRLF / LF

Both must parse identically.

### Additional Caption Text

Metadata must still be extracted.

### Missing ID

Verify safe path-based resolution.

### Missing Path

Existing file matched by ID keeps its current location.

### Invalid Path

Traversal is rejected.

### Rename

Same 9Drive ID and Telegram message, updated path.

### Move

Same 9Drive ID and Telegram message, updated parent folder.

### Repeated Sync

No duplicates.

### Remote Import

Correct metadata is restored.

### Normal Store

Correct metadata is restored.

---

## 27. Realistic Fixtures

Test a hierarchy such as:

```text
/
├── Movies
│   ├── Anime
│   │   └── One Piece
│   └── Documentaries
├── Documents
│   ├── Reports
│   └── Anime
└── Projects
    └── APP-V
```

Test:

```text
Movies/Anime/One Piece/episode-01.mkv
Movies/Documentaries/My Movie 1080p.mkv
Documents/Reports/report=final.pdf
Projects/APP-V/docs/architecture.md
```

Verify exact folder placement.

---

# Execution Workflow

## Phase 1 — Plan

Inspect the existing Telegram Sync implementation and produce:

- current sync flow
- current metadata parser
- current file lookup strategy
- current folder resolution strategy
- current `Recovered from Telegram` logic
- exact root cause
- minimal fix plan

Do not modify code during the analysis stage.

## Phase 2 — Implement

Implement the smallest correct fix.

Prioritize:

1. Correct `9drive:id` parsing
2. Correct `9drive:path` parsing
3. Exact file matching
4. Hierarchical folder resolution
5. Correct parent folder assignment
6. Recovery fallback correction
7. Idempotency

Do not rewrite unrelated Telegram functionality.

## Phase 3 — Test

Run:

- backend tests
- Telegram sync tests
- database tests
- integration tests
- type checks
- lint

Do not use Playwright.

## Phase 4 — Report

Update:

```text
docs/implementation/telegram-drive.md
```

Document the final Telegram sync behavior.

---

# Final Acceptance Criteria

The implementation is complete only when:

1. Telegram Sync correctly parses `9drive:id`.
2. Telegram Sync correctly parses `9drive:path`.
3. `9drive:id` matches the correct existing 9Drive file.
4. `9drive:path` resolves the correct virtual location.
5. Existing files in `Recovered from Telegram` can be moved to their correct location.
6. Missing folders are created when the path is valid.
7. Root-level paths work.
8. Paths containing spaces work.
9. Paths containing `=` work.
10. CRLF and LF metadata work.
11. Additional caption text does not break parsing.
12. Path traversal is rejected.
13. Filename is correctly derived from `9drive:path`.
14. Normal Store and Remote Import use the same metadata contract.
15. Rename does not create duplicates.
16. Move does not create duplicates.
17. Repeated synchronization is idempotent.
18. `Recovered from Telegram` is only a genuine last-resort fallback.
19. Telegram physical identity remains separate from `9drive:id`.
20. Sync does not download large files just to resolve metadata.
21. Sync remains paginated/batched for large channels.
22. Existing Telegram storage behavior remains compatible.
23. Existing non-Telegram storage providers remain unaffected.
24. `references/teledrive` remains untouched.
25. No Teledrive source code is copied into production.
26. Tests cover the critical metadata/path cases.
27. Documentation is updated.

## Final Terminal Summary

Print:

```text
Telegram Sync Path Fix Complete

Metadata Parser:
PASS / ISSUE

9drive:id Matching:
PASS / ISSUE

9drive:path Resolution:
PASS / ISSUE

Folder Creation:
PASS / ISSUE

Existing File Relocation:
PASS / ISSUE

Recovered Fallback:
PASS / ISSUE

Normal Store:
PASS / ISSUE

Remote Import:
PASS / ISSUE

Rename:
PASS / ISSUE

Move:
PASS / ISSUE

Idempotency:
PASS / ISSUE

Overall:
HEALTHY / NEEDS FIX

Root Cause:
...

Changes:
...

Tests:
...
```

This task is specifically for Telegram synchronization. Do not modify unrelated Remote Import, Worker Relay, browser extension, or other storage-provider behavior unless a direct dependency is required to make Telegram synchronization correct.
