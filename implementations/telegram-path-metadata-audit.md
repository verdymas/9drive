# Audit Telegram 9Drive Path Metadata — End-to-End

## Objective

Perform a READ-ONLY end-to-end audit of how 9Drive Telegram storage handles these canonical metadata fields:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual path>
```

The purpose is to find exactly where the metadata is:

- generated incorrectly
- missing
- overwritten
- lost
- parsed incorrectly
- transformed incorrectly
- not persisted
- not updated after rename/move
- not consumed during synchronization

**DO NOT implement fixes in this phase.**

This is an **AUDIT ONLY** task.

Do not modify production code, migrations, database schema, tests, documentation, or `references/teledrive`.

Use:

```text
references/teledrive
```

only as a read-only reference.

Do not copy Teledrive code.

---

# 1. Canonical Metadata Contract

The canonical Telegram metadata format is:

```text
9drive:id=<9Drive file ID>
9drive:path=<complete 9Drive virtual path>
```

Example:

```text
9drive:id=abc123
9drive:path=Projects/APP-V/docs/architecture.md
```

Meaning:

```text
9drive:id
    ↓
9Drive logical file identity

9drive:path
    ↓
Complete 9Drive virtual file path
```

Do NOT assume another metadata format.

Do NOT invent a new path representation.

---

# 2. Audit Scope

Trace the metadata across the COMPLETE lifecycle:

```text
A. Normal Store
B. Remote Import
C. Telegram Upload
D. Telegram Message Creation
E. Database Persistence
F. Rename
G. Move
H. Copy/Duplicate if supported
I. Download
J. Telegram Sync
K. Reconciliation
L. Recovery
M. Re-indexing
```

Primary focus:

```text
Store
Remote Import
Telegram
Sync
```

Inspect related operations if they affect metadata.

---

# 3. Build a Data Flow Map

Create a complete data flow diagram.

Example:

```text
9Drive File
    |
    +-- file ID
    |
    +-- virtual path
    |
    v
Storage Service
    |
    v
Telegram Provider
    |
    v
Telegram Message Metadata
    |
    +-- 9drive:id
    |
    +-- 9drive:path
    |
    v
Telegram Storage Channel
    |
    v
Telegram Sync
    |
    v
Metadata Parser
    |
    v
9Drive File / Folder
```

For every transition identify:

```text
INPUT
TRANSFORMATION
OUTPUT
PERSISTENCE
```

---

# 4. Audit Normal Store

Trace what happens when a normal 9Drive file is stored to Telegram.

Example:

```text
Projects/APP-V/docs/architecture.md
```

Trace:

```text
Upload
    ↓
File creation
    ↓
Folder resolution
    ↓
Storage provider
    ↓
Telegram upload
    ↓
Telegram message
```

Determine:

1. Where is the 9Drive file ID generated?
2. Where is the virtual path determined?
3. Where is `9drive:id=` generated?
4. Where is `9drive:path=` generated?
5. What exact value is used for the path?
6. Is the path absolute or relative?
7. Is the filename included in `9drive:path`?
8. Is the path normalized?
9. Is the metadata stored in caption, message text, or another Telegram field?
10. Is the metadata persisted in the 9Drive database?
11. Is the exact same metadata available after upload?
12. Can the uploaded Telegram message be mapped back to the original 9Drive file?

Report the exact source file and function for every step.

---

# 5. Audit Remote Import

Trace:

```text
Remote URL
    ↓
Remote Import
    ↓
Download
    ↓
Optional Worker Relay
    ↓
Optional HLS processing/remux
    ↓
Storage Provider
    ↓
Telegram
```

Determine how the following are generated:

```text
filename
9Drive file ID
9Drive virtual path
9drive:id
9drive:path
```

Remote Import may have a different code path from normal upload.

Verify that both flows ultimately use the same metadata generation mechanism.

Test conceptually:

```text
Remote Import
filename = movie.mkv
destination = Movies/Anime
```

Expected:

```text
9drive:id=<created 9Drive file ID>
9drive:path=Movies/Anime/movie.mkv
```

Determine whether the current implementation instead produces:

```text
9drive:path=movie.mkv
```

or:

```text
9drive:path=/movie.mkv
```

or:

```text
9drive:path=
```

or another incorrect representation.

---

# 6. Audit Telegram Upload Layer

Find the exact function responsible for creating/sending the Telegram storage message.

Determine:

```text
Telegram upload input
        ↓
message/caption construction
        ↓
Telegram API request
```

Inspect the exact generated message.

Determine whether it contains:

```text
9drive:id=...
9drive:path=...
```

or whether either field is missing.

Also determine whether:

```text
9drive:id
9drive:path
```

are generated before or after the Telegram upload.

This is important because the final 9Drive file ID may not exist until after a database record is created.

---

# 7. Audit Path Source

Identify the SINGLE authoritative source used to generate:

```text
9drive:path
```

Determine whether it currently comes from:

```text
file.path
folder.path
storage path
frontend path
request path
remote import path
filename
Telegram metadata
```

Report:

```text
Current source of truth:
<exact model/service/property/function>
```

If multiple parts independently construct the path, flag this as an architecture problem.

---

# 8. Audit Path Construction

Inspect how the complete path is constructed.

Example:

```text
Projects
    /
APP-V
    /
docs
    /
architecture.md
```

Expected:

```text
Projects/APP-V/docs/architecture.md
```

Check for:

```text
leading /
trailing /
duplicate //
Windows \
spaces
Unicode
special characters
dots
nested folders
root files
empty folders
```

Also inspect:

```text
basename
dirname
relative path
absolute path
storage path
virtual path
```

Do not change anything. Only report current behavior.

---

# 9. Audit `9drive:id`

Determine exactly what `9drive:id` represents.

Verify whether it is:

```text
9Drive file primary key
UUID
storage object ID
Telegram message ID
provider remote ID
```

It MUST represent the logical 9Drive file identity.

Trace:

```text
9Drive file ID
    ↓
Telegram metadata
    ↓
Telegram sync
    ↓
9Drive lookup
```

Determine whether the ID remains stable through:

```text
rename
move
re-sync
re-import
database updates
```

---

# 10. Audit Rename

Trace:

```text
Movies/old.mkv
```

to:

```text
Movies/new.mkv
```

Determine:

1. Does the Telegram message remain the same?
2. Does `9drive:id` remain the same?
3. Is `9drive:path` updated?
4. How is Telegram message metadata updated?
5. Does synchronization understand the new path?
6. Can the old Telegram message still map correctly?

Expected conceptual behavior:

```text
9drive:id=abc123
9drive:path=Movies/old.mkv
```

becomes:

```text
9drive:id=abc123
9drive:path=Movies/new.mkv
```

without creating another physical Telegram file.

---

# 11. Audit Move

Trace:

```text
Movies/Anime/file.mkv
```

to:

```text
Movies/Anime/One Piece/file.mkv
```

Determine:

1. Does the 9Drive file ID remain unchanged?
2. Is the Telegram message reused?
3. Is `9drive:path` updated?
4. Are missing folders handled?
5. Does Telegram metadata reflect the new path?
6. Does synchronization restore the correct folder?

Expected:

```text
9drive:id=abc123
9drive:path=Movies/Anime/One Piece/file.mkv
```

---

# 12. Audit Telegram Sync

Trace the exact synchronization flow:

```text
Telegram Storage Channel
    ↓
Telegram message scan
    ↓
Message metadata extraction
    ↓
9drive:id parsing
    ↓
9drive:path parsing
    ↓
9Drive file lookup
    ↓
Folder resolution
    ↓
File placement
```

Determine exactly where:

```text
9drive:id
```

is parsed.

Determine exactly where:

```text
9drive:path
```

is parsed.

Determine whether the parser supports the current format:

```text
9drive:id=xxx
9drive:path=path/to/file.mkv
```

Check:

- newline handling
- whitespace
- CRLF
- LF
- caption formatting
- extra metadata
- Unicode
- spaces in filenames
- `=` inside values
- empty values

---

# 13. Audit Sync Resolution Order

Determine the CURRENT actual resolution order.

Ideally:

```text
1. 9drive:id
2. 9drive:path
3. Telegram remote identity
4. safe recovery
```

Report the actual implementation even if different.

Specifically determine whether the implementation incorrectly does:

```text
filename
    ↓
Recovered from Telegram
```

before attempting:

```text
9drive:path
```

---

# 14. Audit `Recovered from Telegram`

Find every code path that sends a file to:

```text
Recovered from Telegram
```

For each occurrence report:

```text
file
function
condition
reason
```

Determine whether valid:

```text
9drive:path=
```

can still end up there.

This is a critical part of the audit.

---

# 15. Audit Folder Resolution

Given:

```text
9drive:path=Movies/Anime/One Piece/file.mkv
```

determine how sync resolves:

```text
Movies
Anime
One Piece
```

Check:

```text
owner
parent folder
folder name
root folder
duplicate folders
missing folders
```

Determine whether missing folders are created or whether the system immediately falls back to:

```text
Recovered from Telegram
```

---

# 16. Audit Database Mapping

Trace the database fields connecting:

```text
9Drive File
```

to:

```text
Telegram Message
```

Identify:

```text
file ID
provider ID
storage account ID
remote ID
Telegram channel ID
Telegram message ID
metadata
path
```

Create a mapping table:

| Concept | Current DB Field | Source | Used By |
|---|---|---|---|
| 9Drive file ID | ? | ? | ? |
| Telegram channel ID | ? | ? | ? |
| Telegram message ID | ? | ? | ? |
| Telegram remote ID | ? | ? | ? |
| Virtual path | ? | ? | ? |

Do not change the schema.

---

# 17. Audit Remote Import + Telegram Together

Trace this exact flow:

```text
Remote Import
    ↓
URL
    ↓
download
    ↓
filename
    ↓
create 9Drive file
    ↓
determine destination folder
    ↓
Telegram Storage Provider
    ↓
Telegram message
```

Verify:

```text
9drive:id
```

is the ID of the actual created 9Drive file.

Verify:

```text
9drive:path
```

contains the actual final virtual path.

It must NOT contain:

```text
temporary path
worker path
remote URL
filesystem path
container path
filename only
```

unless filename-only is genuinely the root path.

---

# 18. Audit Remote Import Filename Override

Remote Import may allow the user to specify a filename.

Example:

```text
Original:
video_12345.ts

User filename:
My Movie 1080p.mkv
```

Determine which filename is used to construct:

```text
9drive:path
```

Expected:

```text
9drive:path=Movies/My Movie 1080p.mkv
```

not:

```text
9drive:path=Movies/video_12345.ts
```

unless that is the actual final filename.

---

# 19. Audit Worker / Remote Import Separation

The Worker Relay must not alter the logical 9Drive path.

Verify that:

```text
Direct
```

and:

```text
Worker
```

produce the same:

```text
9Drive file ID
9Drive virtual path
Telegram metadata
```

The worker only affects network transport.

It must not become the source of:

```text
9drive:path
```

---

# 20. Audit Download

Verify whether download uses:

```text
9drive:id
```

or Telegram remote identity correctly.

Download must NOT depend on:

```text
9drive:path
```

as the physical Telegram lookup identity.

Keep identities separate:

```text
9drive:id
    =
9Drive logical file identity

channelId + messageId
    =
Telegram physical storage identity
```

---

# 21. Audit Reconciliation

Inspect reconciliation logic for cases where:

```text
9drive:id exists
9drive:path exists
```

but the database record already exists.

Determine whether the system:

```text
updates existing record
moves existing record
creates duplicate
sends to recovery
```

Expected:

```text
existing file
    ↓
match by 9drive:id
    ↓
use 9drive:path to validate/correct location
```

---

# 22. Audit Old Telegram Files

Determine how the system handles Telegram messages containing:

```text
9drive:id=
```

but no:

```text
9drive:path=
```

and vice versa.

Report each behavior separately.

Do not implement migration yet.

---

# 23. Audit Edge Cases

Inspect behavior for:

```text
root/file.mkv

folder/file.mkv

folder/subfolder/file.mkv

folder/My File.mkv

folder/file.with.many.dots.mkv

folder/file=abc.mkv

folder/éxample/file.mkv

folder/文件.pdf

folder/video 1080p.mkv

folder/file.mkv/
```

Determine whether metadata parsing and path resolution handle these safely.

---

# 24. Compare Against `references/teledrive`

Only after understanding the current 9Drive implementation, inspect the relevant Teledrive reference implementation.

Use it only to answer:

```text
How does Teledrive represent file identity?
How does Teledrive associate Telegram messages with files?
How does it encode metadata?
How does it recover/index Telegram files?
```

Do not copy implementation.

Do not assume Teledrive's architecture must be used by 9Drive.

Report only useful differences.

---

# 25. Produce an Audit Report

Do NOT modify code.

Create:

```text
docs/audits/telegram-path-metadata-audit.md
```

The report must contain:

## A. Executive Summary

Explain:

```text
Is Telegram path metadata currently correct?
Yes / No / Partially
```

## B. Current Data Flow

Show:

```text
Store
Remote Import
Telegram Upload
Sync
```

## C. Metadata Lifecycle

Show the lifecycle of:

```text
9drive:id
9drive:path
```

from generation through synchronization.

## D. Exact Source Locations

For every important step provide:

```text
file
class/function
responsibility
```

## E. Problems Found

For every problem:

```text
Problem
Location
Current behavior
Expected behavior
Impact
Suggested fix
```

Do NOT implement the suggested fix.

## F. `Recovered from Telegram` Analysis

List every fallback condition.

## G. Remote Import Analysis

Explain whether Remote Import generates correct:

```text
9drive:id
9drive:path
```

## H. Store Analysis

Explain whether normal uploads generate correct metadata.

## I. Sync Analysis

Explain whether sync correctly parses and resolves:

```text
9drive:id
9drive:path
```

## J. Rename / Move Analysis

Explain whether metadata remains consistent.

## K. Database Mapping

Document the relationship between:

```text
9Drive file
Telegram channel
Telegram message
provider remote ID
path metadata
```

## L. Teledrive Comparison

Only include relevant observations.

## M. Root Cause

Identify the most likely root cause(s).

Be specific.

Bad:

```text
Path handling has problems.
```

Good:

```text
RemoteImportService creates the Telegram metadata before the File record is assigned its final parent folder, causing `9drive:path` to contain only the filename.
```

## N. Recommended Fix Plan

Provide a prioritized plan:

```text
P0 — critical
P1 — important
P2 — improvement
```

Do not implement it.

---

# 26. Important Restrictions

This phase is READ-ONLY.

Do NOT:

- modify production code
- modify migrations
- modify database schema
- modify frontend
- modify Telegram messages
- modify Telegram storage
- modify sync behavior
- modify `references/teledrive`
- run destructive commands
- delete test files
- create migration files
- use Playwright

You may run safe inspection commands and existing tests if they do not modify application state.

---

# 27. Final Output

At the end, provide a concise terminal summary:

```text
Telegram Path Metadata Audit Complete

Store:
PASS / ISSUE

Remote Import:
PASS / ISSUE

Telegram Upload:
PASS / ISSUE

Metadata Generation:
PASS / ISSUE

Sync Parser:
PASS / ISSUE

Folder Resolution:
PASS / ISSUE

Rename:
PASS / ISSUE

Move:
PASS / ISSUE

Recovered Fallback:
PASS / ISSUE

Overall:
HEALTHY / NEEDS FIX

Root Cause:
...

Recommended Next Step:
...
```

The main deliverable is:

```text
docs/audits/telegram-path-metadata-audit.md
```

Again: this task is **AUDIT ONLY**. Do not implement fixes.
