You are working inside the existing 9Drive project.

The project already has a Storage Sync feature.

The storage architecture is being changed to support:

MULTI-STORAGE VIRTUAL FOLDERS

One virtual folder in 9Drive may have physical representations on multiple
connected storage accounts.

Example physical storage:

Google Drive A
└── Mov/
    ├── Avatar.mkv
    └── Dune.mkv

Google Drive B
└── Mov/
    ├── Batman.mkv
    └── Superman.mkv

After clicking Sync, the 9Drive virtual filesystem must show:

Mov/
├── Avatar.mkv
├── Dune.mkv
├── Batman.mkv
└── Superman.mkv

There must NOT be:

Mov [Google Drive A]
Mov [Google Drive B]

Instead there must be ONE virtual folder:

Mov

with multiple physical storage mappings:

Virtual Mov
    │
    ├── Google Drive A → providerFolderId A
    └── Google Drive B → providerFolderId B

The existing Sync implementation must be refactored to understand this
architecture.

This is not a simple UI change.

This is a storage reconciliation architecture refactor.

Do not create an unrelated second Sync system.

Inspect and reuse the existing Sync architecture where appropriate.

---

# 1. Mandatory repository analysis

Before modifying anything, inspect the actual repository.

Read at least:

- AGENTS.md
- README.md
- docker-compose.yml
- backend/package.json
- frontend/package.json
- backend/prisma/schema.prisma
- Existing migrations
- Existing Sync routes
- Existing Sync controller
- Existing Sync service
- Existing Sync worker / queue
- Existing ConnectedAccount model
- Existing Folder model
- Existing File model
- Existing FolderStorageLocation model if already implemented
- Existing provider abstractions
- Google Drive provider implementation
- S3 provider implementation
- Existing provider listing/pagination implementation
- Existing folder creation logic
- Existing file import/sync logic
- Existing missing-file reconciliation
- Existing upload routing
- Existing FolderMaterializationService or equivalent
- Existing ensureFolderStorageLocation() implementation if already implemented
- All Files API
- All Files frontend
- Connected Accounts / Sync frontend
- Existing Sync progress UI
- Existing tests

Search globally for:

sync
synchronize
reconcile
connectedAccountId
providerFolderId
providerFileId
folderId
parentId
FolderStorageLocation
Folder
File
ConnectedAccount
lastSeen
missing
deleted
trash
Google Drive
S3
listFiles
listFolders
pagination
pageToken
prefix

Identify all code that currently assumes:

Folder -> one connectedAccount

or:

Folder -> one providerFolderId

or:

Sync account -> create separate virtual folder tree

Before coding, produce a concise implementation plan containing:

1. Current Sync architecture.
2. Existing assumptions that conflict with multi-storage folders.
3. Database changes needed.
4. Sync reconciliation algorithm.
5. Folder matching strategy.
6. File matching strategy.
7. Missing-resource reconciliation.
8. Concurrency strategy.
9. UI changes.
10. Tests required.

Then continue implementation without waiting for confirmation unless there is a
genuinely blocking repository inconsistency.

---

# 2. Core architectural invariant

The application must distinguish:

VIRTUAL FILESYSTEM

from:

PHYSICAL PROVIDER STORAGE

A virtual Folder is a logical directory visible in 9Drive.

A FolderStorageLocation represents that virtual folder on one connected account.

Conceptually:

Folder

Mov
id = virtual-mov-id

FolderStorageLocation

virtual-mov-id
+ Google Drive A
+ providerFolderId = AAA

virtual-mov-id
+ Google Drive B
+ providerFolderId = BBB

virtual-mov-id
+ Google Drive C
+ providerFolderId = CCC

One virtual folder may have:

0 physical locations
1 physical location
many physical locations

A File still belongs physically to one connected account.

Conceptually:

Avatar.mkv
folderId = virtual Mov
connectedAccountId = Drive A
providerFileId = provider-file-a

Batman.mkv
folderId = virtual Mov
connectedAccountId = Drive B
providerFileId = provider-file-b

All Files must aggregate them through:

folderId = virtual Mov

not through Folder.connectedAccountId.

---

# 3. Most important Sync rule

SYNC MUST BE:

PHYSICAL STORAGE
→
VIRTUAL FILESYSTEM

Sync is discovery and reconciliation.

Sync MUST NOT be:

VIRTUAL FILESYSTEM
→
ALL STORAGE ACCOUNTS

Therefore:

Sync Account A discovering:

Mov/
└── Action/

must NOT cause 9Drive to create:

Account B / Mov / Action
Account C / Mov / Action

Sync must never replicate folders to other storage accounts.

Physical folder replication belongs to:

FolderMaterializationService

and is used by operations such as:

- normal upload
- Remote Import
- explicit move
- explicit provider placement

The distinction must remain clear:

SYNC:
Provider → Virtual

UPLOAD:
Virtual → selected Provider when required

Do not mix these responsibilities.

---

# 4. Existing multi-storage model

If the previous Multi-Storage Virtual Folder refactor already created something
equivalent to:

FolderStorageLocation

reuse it.

Do NOT introduce another competing physical-folder mapping model.

The expected relationship is conceptually:

Folder
├── id
├── userId
├── parentId
├── name
└── ...

FolderStorageLocation
├── id
├── folderId
├── connectedAccountId
├── providerFolderId
├── ...
└── unique(folderId, connectedAccountId)

If the implementation differs, adapt to the actual repository.

If the old fields:

Folder.connectedAccountId
Folder.providerFolderId

still exist as legacy authoritative fields, identify whether the previous
multi-storage refactor is complete before changing Sync.

Do not reintroduce folder ownership through those fields.

---

# 5. Required Sync behavior

Example:

Account A:

9drive/
└── Mov/
    ├── A.mkv
    └── B.mkv

Account B:

9drive/
└── Mov/
    ├── C.mkv
    └── D.mkv

Sync All must produce:

Virtual:

Mov/
├── A.mkv
├── B.mkv
├── C.mkv
└── D.mkv

Database conceptually:

Folder:

Mov
id = mov-virtual

FolderStorageLocation:

mov-virtual + Account A + remote-folder-a
mov-virtual + Account B + remote-folder-b

Files:

A.mkv
folderId = mov-virtual
account = A

B.mkv
folderId = mov-virtual
account = A

C.mkv
folderId = mov-virtual
account = B

D.mkv
folderId = mov-virtual
account = B

There must be exactly one virtual Mov folder.

---

# 6. Folder matching algorithm

Do NOT match physical folders globally only by name.

Incorrect:

find Folder where name = "Action"

Because these may all exist:

Mov/Action
Series/Action
Archive/Action

Folder matching must be scoped by:

user
+
virtual parent
+
normalized name

Conceptually:

find virtual folder where:

userId = current user
parentId = resolved virtual parent
normalizedName = normalized physical name

Use the repository's existing normalized-name behavior when present.

Do not invent a second incompatible normalization system.

---

# 7. Physical identity takes priority

When Sync discovers a physical provider folder, first check whether that exact
physical folder is already known.

Conceptual lookup:

FolderStorageLocation where:

connectedAccountId = current account
providerFolderId = remote folder ID

If found:

this identifies the existing physical mapping.

Do not create another mapping merely because the folder name or path changed.

Then reconcile the mapping against its current physical parent and name.

If not found:

resolve it through virtual parent + normalized name.

This gives two levels of identity:

1. Existing providerFolderId mapping.
2. Logical virtual path matching for newly discovered physical folders.

This is important for provider-side rename and move detection.

---

# 8. New physical folder discovery

Suppose Account A Sync finds:

Mov/

and no virtual Mov exists.

Create:

Virtual Folder Mov

then create:

FolderStorageLocation:
Mov + Account A

Later Account B Sync finds:

Mov/

Do NOT create another virtual Mov.

Find existing:

Virtual root / Mov

Then add:

FolderStorageLocation:
Mov + Account B

Result:

Virtual Mov
    ├── location A
    └── location B

---

# 9. Nested folder merge

Example:

Account A:

Mov/
└── Action/
    ├── A.mkv
    └── B.mkv

Account B:

Mov/
└── Action/
    └── C.mkv

Expected virtual filesystem:

Mov/
└── Action/
    ├── A.mkv
    ├── B.mkv
    └── C.mkv

Mappings:

Mov
├── A
└── B

Mov/Action
├── A
└── B

Sync must recursively reuse the same virtual parent hierarchy.

---

# 10. Different children across storage accounts

This must also work.

Account A:

Mov/
└── Action/

Account B:

Mov/
└── Drama/

Expected virtual:

Mov/
├── Action/
└── Drama/

Mappings:

Mov
├── A
└── B

Action
└── A

Drama
└── B

This is valid.

Do NOT assume a child Folder has the same storage locations as its parent.

Do NOT automatically create:

A/Mov/Drama

or:

B/Mov/Action

during Sync.

---

# 11. FolderStorageLocation upsert

When discovering a physical folder, safely upsert the location.

Conceptually:

upsertFolderStorageLocation({
    virtualFolderId,
    connectedAccountId,
    providerFolderId
})

Database must prevent duplicate mappings.

At minimum enforce the equivalent of:

unique(folderId, connectedAccountId)

Also consider provider identity uniqueness:

one connected account + one providerFolderId

should not accidentally map to multiple unrelated virtual folders unless the
provider architecture explicitly permits that.

Add an appropriate unique index if safe for the existing schema.

---

# 12. Sync race condition

Sync All may process Account A and Account B concurrently.

Both may discover:

Mov

at approximately the same time.

Do not allow:

Virtual Mov
Virtual Mov

Protect virtual folder creation.

Use:

- database uniqueness
- transactions where appropriate
- unique constraint handling
- re-read after race

Conceptually:

A:
find Mov → absent

B:
find Mov → absent

A:
create Mov → success

B:
create Mov → unique conflict

B:
re-read Mov
→ use existing
→ create location B

Do not rely only on:

if (!existing) create()

without database-level protection.

---

# 13. Virtual folder uniqueness

Determine the appropriate repository-specific uniqueness strategy.

Conceptually:

unique(
    userId,
    parentId,
    normalizedName
)

Be careful with nullable parentId/root behavior under MySQL.

Implement a safe strategy consistent with the existing project.

Do not break valid folder names.

Do not globally make names unique across the user's entire filesystem.

Uniqueness is only within one virtual parent.

---

# 14. File identity during Sync

Do NOT identify files only by filename.

A physical file must be identified primarily by:

connectedAccountId
+
providerFileId

Conceptually:

find File where:

connectedAccountId = current account
providerFileId = remote file ID

If found:

update metadata as needed.

If its physical provider parent changed:

update its virtual folderId to the resolved virtual parent.

If not found:

create a new File record.

This prevents duplicate File records after every Sync.

---

# 15. File metadata reconciliation

For existing files update safe provider metadata as needed:

- name
- size
- MIME type
- checksum when available
- provider modified time
- provider metadata needed by the application
- virtual folderId if moved
- availability status
- last seen marker

Do not overwrite application-owned metadata unnecessarily.

Inspect current File semantics before updating.

Do not replace user metadata with provider metadata unless that is the existing
behavior.

---

# 16. Same filename across different accounts

This case must preserve all files.

Example:

Account A:

Mov/Avatar.mkv

Account B:

Mov/Avatar.mkv

They may be:

- identical files
- different versions
- different encodes
- different sizes

Do NOT discard one simply because the filename matches.

File identity remains:

connectedAccountId
+
providerFileId

If the current virtual filesystem supports duplicate names, preserve both and
mark collisions according to existing UI conventions.

If the current virtual filesystem requires unique names, implement a
virtual-only collision strategy.

Preferred conceptual result:

Avatar.mkv
Avatar (2).mkv

Do NOT rename the actual physical Google Drive file merely because there is a
virtual collision.

Do NOT include account credentials or sensitive account information in the
virtual collision name.

A deterministic suffix is preferred.

Before implementing new collision semantics, inspect existing duplicate-file
handling and reuse it where possible.

The key requirement is:

No physical file may disappear from Sync merely because another account has the
same filename.

---

# 17. Optional duplicate detection

If checksums are available:

same virtual folder
+
same filename
+
same size
+
same reliable checksum

may be reported as a duplicate.

Do NOT automatically merge physical File records into one File record as part
of this task.

A future architecture may introduce:

VirtualFile
+
FileStorageLocation

but that is outside the current scope.

For now each provider file remains its own File record.

---

# 18. Sync Account scope

When user clicks:

Sync Account A

the Sync job must only reconcile:

Account A

It may:

- discover physical folders on A
- add A mappings
- update A mappings
- discover A files
- update A files
- reconcile missing A resources

It must NOT:

- delete FolderStorageLocation for B
- delete B files
- mark B files missing
- modify B provider metadata
- create physical folders on B

All reconciliation cleanup must be scoped by:

userId
+
connectedAccountId

---

# 19. Sync All behavior

Sync All should conceptually execute:

Sync A
Sync B
Sync C

using bounded account concurrency.

Do not launch unlimited storage account scans simultaneously.

Use existing job infrastructure.

Recommended conceptual default:

2 accounts concurrently

Make it configurable only if consistent with project conventions.

All account jobs must safely merge into the same virtual filesystem.

---

# 20. Sync run state

Inspect the existing Sync job model.

Reuse it if possible.

Each account Sync should have a unique run identity.

Conceptually:

SyncRun
├── id
├── userId
├── connectedAccountId
├── status
├── startedAt
├── completedAt
├── foldersDiscovered
├── filesDiscovered
├── mappingsCreated
├── mappingsUpdated
├── filesCreated
├── filesUpdated
├── filesMissing
└── error

Use existing models when available.

Do not duplicate Sync history infrastructure unnecessarily.

---

# 21. Seen marker / reconciliation marker

Use a robust mechanism to determine which existing provider resources were seen
during a successful Sync.

Preferred conceptual approach:

lastSeenSyncRunId

or equivalent generation-based marker.

For each discovered FolderStorageLocation:

lastSeenSyncRunId = currentSyncRun.id

For each discovered File belonging to that account:

lastSeenSyncRunId = currentSyncRun.id

After a SUCCESSFUL complete scan:

resources belonging to this account
whose lastSeenSyncRunId != current run

may be reconciled as missing.

If the existing project already uses:

lastSeenAt

or another safe strategy, reuse it.

Do not introduce unnecessary duplicate markers.

---

# 22. Never cleanup after failed scans

This is mandatory.

Suppose Google Drive returns:

429
500
timeout
token refresh failure
connection reset

and Sync only scans part of the account.

Do NOT conclude that unscanned files were deleted.

Cleanup of missing resources may happen ONLY when the provider scan completes
successfully.

Conceptually:

scan success
→ reconcile missing

scan failed
→ mark Sync failed
→ leave previous mappings and files untouched

This applies to:

- folder mappings
- files
- provider metadata

Transient provider failures must never wipe the virtual filesystem.

---

# 23. Folder missing on one account

Example:

Virtual Mov mappings:

A
B

Physical A/Mov is deleted externally.

Physical B/Mov still exists.

Sync A:

A/Mov no longer seen.

Expected:

remove / mark missing:

Mov + A FolderStorageLocation

Do NOT delete Virtual Mov.

After Sync:

Virtual Mov
└── mapping B

All Files still shows:

Mov/

because its virtual identity and/or B mapping remain valid.

---

# 24. Zero-location virtual folders

The new architecture allows a virtual folder to have zero physical locations.

Example:

User creates:

Movies/
└── Future Uploads/

but has not uploaded anything yet.

There may be no FolderStorageLocation.

Sync must NOT delete this virtual folder simply because no provider contains it.

Therefore:

absence of FolderStorageLocation
!=
virtual folder should be deleted

Do not use provider Sync as the authoritative deletion mechanism for all virtual
Folder records.

---

# 25. Pruning sync-created empty folders

If the existing application expects provider-deleted folders to disappear from
the virtual UI, handle this conservatively.

A virtual folder may only be automatically pruned when the system can safely
prove:

- it has zero FolderStorageLocations
- it has zero valid files
- it has zero valid virtual children
- it is known to have originated from Sync OR existing semantics explicitly
  permit automatic pruning

If the current schema cannot distinguish user-created virtual folders from
Sync-created folders, do NOT introduce unsafe deletion.

Prefer leaving an empty virtual folder over accidentally deleting a user-created
folder.

Document the behavior.

---

# 26. Provider-side folder rename

This case requires special handling.

Initial state:

Virtual Mov

Mappings:

A / Mov
B / Mov

The user directly renames on Google Drive B:

Mov
→
Movies

Account A still has:

Mov

Sync B discovers the same providerFolderId but now named Movies.

Do NOT blindly rename the shared Virtual Mov to Movies.

That would incorrectly change Account A's logical path.

Instead, detect divergence.

When a physical location belonging to a multi-location virtual folder changes
name independently:

1. Determine whether the virtual folder has other physical locations.
2. If it has other mappings that still represent the old virtual path:
   detach the changed physical mapping from the shared virtual folder.
3. Resolve/create the appropriate virtual folder under the current virtual
   parent using the new physical name.
4. Attach the physical mapping to that virtual folder.
5. Sync its contents there.

Expected:

Virtual:

Mov/
  → Account A

Movies/
  → Account B

Do not rename Account A.

---

# 27. Provider-side folder move

Similar divergence logic applies to provider-side moves.

Initial:

Virtual:

Mov/
└── Action/

Mappings for Action:

A
B

User directly moves Account B physical Action to:

Archive/Action

while Account A remains:

Mov/Action

Sync B must NOT move shared virtual Action and therefore move A logically.

Instead:

- detect that B's physical parent changed
- determine that Action has other physical mappings
- detach B's mapping from shared Mov/Action
- resolve/create Virtual Archive/Action
- attach B mapping there

Expected:

Virtual:

Mov/
└── Action/
    → A

Archive/
└── Action/
    → B

This avoids one provider's external changes unexpectedly restructuring another
provider's virtual tree.

---

# 28. Single-location rename/move optimization

If a virtual folder has exactly ONE physical storage location and it was
provider-originated, a provider-side rename or move may safely update the
virtual folder directly if that matches existing product semantics.

Example:

Virtual:

Mov
→ only Account A

Physical A renamed:

Mov → Movies

Sync may update:

Virtual Mov → Movies

instead of creating another virtual folder.

But implement this only if safe.

Do not use this optimization when:

- multiple physical mappings exist
- there are conflicting virtual children
- it would violate virtual folder uniqueness
- the folder is clearly application-owned and provider changes should not
  override it

Keep the logic explicit and tested.

---

# 29. Do not mutate providers during Sync

Storage Sync should not call provider operations such as:

createFolder
renameFolder
moveFolder
deleteFolder

for the purpose of making providers match the virtual tree.

Provider writes should be performed only by explicit 9Drive operations such as:

- user rename
- user move
- upload materialization
- delete
- explicit future reconciliation action

Add tests/mocks confirming Sync performs read/discovery operations only.

This boundary is mandatory.

---

# 30. File externally moved

If a file already exists:

connectedAccountId = A
providerFileId = XYZ
folderId = virtual Mov

and Sync A discovers providerFileId XYZ under:

Archive

then:

resolve virtual Archive folder

and update:

file.folderId = virtual Archive

Do NOT create a duplicate File.

Provider identity is stable.

---

# 31. File externally renamed

If providerFileId remains the same but name changes:

Movie.mkv
→
Movie Remastered.mkv

update the File's provider/virtual filename according to existing project
semantics.

Do not create another File.

If the new virtual name collides with a file from another account, apply the
existing collision policy.

---

# 32. File externally deleted

Suppose:

Mov/
├── Avatar.mkv → A
└── Batman.mkv → B

Avatar is deleted directly from Account A.

Sync A detects it missing.

Apply the existing missing/deleted/trash semantics only to:

Avatar → A

Do not touch:

Batman → B

Do not mark the entire Mov folder missing.

---

# 33. Folder created directly on provider

Example:

Account B suddenly contains:

9drive/
└── Mov/
    └── Anime/
        └── One Piece/

Sync B must:

1. Resolve/create Virtual Mov.
2. Add/reuse mapping Mov + B.
3. Resolve/create Virtual Anime under Mov.
4. Add mapping Anime + B.
5. Resolve/create Virtual One Piece under Anime.
6. Add mapping One Piece + B.
7. Sync physical files into those virtual folders.

If Virtual Mov already exists because Account A previously created it:

reuse Virtual Mov.

Do not create Mov B separately.

---

# 34. Physical root handling

Inspect how each connected account identifies its 9Drive root.

Do not treat provider root as an ordinary virtual Folder unless the existing
architecture already does so.

Sync must start with:

provider root
+
virtual root

Then recursively map children.

Conceptually:

syncPhysicalFolderChildren({
    connectedAccount,
    providerParentId: providerRootId,
    virtualParentId: null
})

Adapt to Google Drive and S3 semantics.

---

# 35. Google Drive behavior

Google Drive uses stable provider file/folder IDs.

Use them as physical identity.

Respect pagination.

Do not assume folder names are unique on Google Drive.

Google Drive can contain duplicate names under one parent.

The Sync implementation must handle this safely.

Do not overwrite one physical providerFolderId mapping with another simply
because names match.

If duplicate provider folders with identical names exist under the same physical
parent on the SAME account, use the project's collision strategy.

Do not silently drop either branch.

This is different from:

Account A / Mov
Account B / Mov

which should normally merge.

Same-account duplicate physical siblings are ambiguous and should be handled
explicitly.

---

# 36. Same-account duplicate folder names

Example:

Account A:

root/
├── Mov/   providerFolderId AAA
└── Mov/   providerFolderId BBB

These are two different physical folders.

They cannot both map cleanly to the same provider location slot:

virtual Mov + Account A

because:

unique(folderId, connectedAccountId)

permits only one physical location per account for that virtual folder.

Therefore implement an explicit collision strategy.

Preferred virtual result:

Mov/
Mov (2)/

Both belong to Account A.

Do NOT discard one.

Do NOT merge two distinct physical folders from the same account merely because
their names match.

Cross-account same-path folders:
merge

Same-account duplicate-path folders:
collision

This distinction is important.

Use deterministic naming.

Do not rename the physical provider folders automatically.

---

# 37. S3 behavior

Inspect the existing S3 storage model.

S3 may represent folders as:

prefixes

rather than true provider folder IDs.

Adapt physical identity appropriately.

Possible physical identity:

account
+
normalized object prefix

Do not pretend S3 has Google Drive folder IDs.

Reuse the provider abstraction.

Sync must still produce the same virtual result.

Example:

Google Drive A:

Mov/

S3 B:

9drive/Mov/

Expected:

one Virtual Mov

with physical representations on both providers.

---

# 38. Sync pagination

Large accounts may contain many files.

Reuse provider pagination.

Do not load the entire account into memory before reconciling.

Process pages incrementally.

For Google Drive, safely follow page tokens.

For S3, safely follow continuation tokens.

Bound memory usage.

Do not create:

const everything = await listEntireDrive()

for large accounts unless existing provider implementation already streams
safely.

---

# 39. Recursive traversal

Avoid unsafe unlimited recursion.

Large nested storage trees may be deep.

Use an iterative queue when appropriate.

Enforce a configurable or defensive maximum folder depth if the project
requires it.

Detect provider cycles or invalid parent relationships defensively.

Google Drive shortcuts or provider-specific references must not create recursive
Sync loops.

Reuse existing shortcut behavior.

---

# 40. Account-level concurrency

Sync All may process multiple accounts concurrently.

Use bounded concurrency.

Example:

SYNC_ACCOUNT_CONCURRENCY=2

Within one account, folder/file listing may also use bounded concurrency if
necessary.

Do not create uncontrolled:

Promise.all(allFolders.map(...))

for thousands of directories.

Use a worker pool / p-limit / existing queue abstraction.

---

# 41. Rate limits and provider retries

Reuse existing provider retry logic.

Handle transient errors:

429
500
502
503
504
network timeout
connection reset

with bounded retry and exponential backoff.

Do not retry permanent:

401 requiring reconnect
403 permission denied when permanent
404 resource gone

indefinitely.

Do not perform missing reconciliation if the scan ultimately fails.

---

# 42. Sync progress

Preserve or improve the existing Sync progress UI.

Per account expose safe progress such as:

Google Drive A

Syncing
Folders: 42
Files: 624

Google Drive B

Waiting

After completion:

Google Drive A
Completed
1,284 files
48 folders

Google Drive B
Completed
1,011 files
42 folders

For Sync All optionally show aggregate:

Accounts: 2 / 3
Folders discovered: 126
Files discovered: 2,847

Do not make exact total file count mandatory before Sync starts because some
providers cannot provide it cheaply.

---

# 43. Multi-storage Sync statistics

Track useful counts:

foldersDiscovered
filesDiscovered
virtualFoldersCreated
folderMappingsCreated
folderMappingsReused
folderMappingsDetached
filesCreated
filesUpdated
filesMoved
filesMissing
collisionsDetected

Do not expose provider secrets.

---

# 44. All Files behavior after Sync

All Files must use the virtual filesystem.

Listing:

Mov

must conceptually retrieve:

Folders:
parentId = Mov.id

Files:
folderId = Mov.id

It must NOT filter files by:

Mov.connectedAccountId

because that concept no longer exists.

It must NOT require all files to belong to the same account as their parent
FolderStorageLocation.

Example:

Mov/

A.mkv → Drive A
B.mkv → Drive A
C.mkv → Drive B
D.mkv → S3

must appear together.

---

# 45. Do not duplicate folder UI

The UI must not display:

Mov - Drive A
Mov - Drive B

because of physical mapping.

The virtual folder is:

Mov

Optionally show in folder details:

Storage Locations: 2

or:

Google Drive A
Google Drive B

But this is implementation metadata.

Do not make All Files provider-centric.

---

# 46. File storage indicator

Individual files may optionally show their physical account:

Avatar.mkv
Google Drive A

Batman.mkv
Google Drive B

Reuse existing account badges if available.

Do not imply that the whole folder belongs to the account shown on one file.

---

# 47. Sync button behavior

Preserve:

Sync Account

and:

Sync All

if they already exist.

Sync Account:

only one account.

Sync All:

all eligible connected accounts.

Do not silently Sync disconnected/disabled accounts.

Display clear account-level failures while allowing other accounts to complete.

Example:

Drive A   Completed
Drive B   Failed
Drive C   Completed

A failure in B must not roll back valid A/C reconciliation.

---

# 48. Sync All race safety

Test:

Account A Sync
and
Account B Sync

both discover:

Mov
→ Action
→ Marvel

simultaneously.

Expected database:

ONE Mov
ONE Action under Mov
ONE Marvel under Action

Mappings:

Mov → A
Mov → B

Action → A
Action → B

Marvel → A
Marvel → B

No duplicate virtual folders.

No duplicate mappings.

---

# 49. Interaction with FolderMaterializationService

Existing:

ensureFolderStorageLocation(
    virtualFolderId,
    connectedAccountId
)

must benefit from Sync mappings.

Example:

Sync discovers:

Mov + Account B

Later Automatic upload chooses B.

ensureFolderStorageLocation(Mov, B)

must immediately reuse the mapping discovered by Sync.

Do not create another physical Mov folder.

Conversely:

Sync discovers only Mov + A.

Automatic upload later chooses B.

ensureFolderStorageLocation(Mov, B)

creates physical Mov on B.

That is correct.

Sync itself must not do so.

---

# 50. Interaction with Remote Import

Remote Import may upload files after direct download or HLS conversion.

It uses:

virtual destination
+
selected account
+
ensureFolderStorageLocation()

The Sync refactor must not break this.

After Remote Import creates:

Drive B / Mov / NewMovie.mkv

a later Sync B must:

- recognize the existing provider file
- reuse the existing virtual Mov
- reuse Mov + B mapping
- update the existing File
- NOT create duplicate file records

Add a regression test.

---

# 51. Interaction with normal uploads

Same rule.

A file created by 9Drive normally and then discovered by Sync must be matched
using:

connectedAccountId
+
providerFileId

Do not duplicate it.

---

# 52. Interaction with physical folder creation

A FolderStorageLocation created earlier by:

ensureFolderStorageLocation()

must be reused during Sync.

Sync must identify it by:

connectedAccountId
+
providerFolderId

and update last-seen state.

Do not create another mapping.

---

# 53. Account disconnect

When Account A is disconnected:

Virtual Mov may have:

A
B

Do not delete Virtual Mov.

Remove/disable/reconcile:

Mov + A

according to existing connected-account semantics.

Mapping B remains.

Files on B remain.

Files on A follow existing unavailable/orphan behavior.

Do not make another storage account responsible for A's files automatically.

Storage migration/rebalancing is outside this task.

---

# 54. Sync account deletion safety

Do not perform cascading deletion that removes:

Virtual Folder
+
all other FolderStorageLocations

when one ConnectedAccount is removed.

Review Prisma cascade rules carefully.

FolderStorageLocation should be safely scoped so deleting account A removes A
locations only.

Virtual Folder must survive while still logically valid.

---

# 55. Cache invalidation

Inspect existing caches.

Invalidate relevant caches when Sync:

- creates a virtual folder
- creates a FolderStorageLocation
- detaches a mapping
- creates a file
- updates a file
- moves a file
- marks a file missing

Do not keep stale All Files results.

Do not globally clear all caches per discovered file if a targeted strategy
already exists.

---

# 56. Database performance

Avoid N+1 queries for every folder when possible.

Within one parent listing:

fetch existing child virtual folders in batches.

Fetch relevant FolderStorageLocations efficiently.

Fetch known File provider IDs efficiently.

Use maps in memory for the current provider page/parent scope.

Do not load millions of records into memory.

Add indexes appropriate for:

Folder:
userId
parentId
normalizedName

FolderStorageLocation:
folderId
connectedAccountId
providerFolderId

File:
connectedAccountId
providerFileId
folderId

Use existing schema naming conventions.

---

# 57. Transactions

Use transactions for database consistency where appropriate.

For example:

create virtual folder
+
create storage location

may require transactional handling.

Do not hold a database transaction open while making slow Google Drive network
requests.

Pattern should generally be:

provider request
→ short DB transaction

not:

open DB transaction
→ remote API request for several seconds
→ commit

Avoid long-running locks.

---

# 58. Logging

Add safe structured logs.

Useful fields:

syncRunId
userId
connectedAccountId
provider
virtualFolderId
folderStorageLocationId
providerFolderId if existing logging policy allows it
providerFileId if existing logging policy allows it
action
collisionType

Useful events:

sync.account.started
sync.folder.discovered
sync.folder.virtual_created
sync.folder.mapping_created
sync.folder.mapping_reused
sync.folder.mapping_detached
sync.file.created
sync.file.updated
sync.file.moved
sync.resource.missing
sync.account.completed
sync.account.failed

Do not log:

OAuth access tokens
refresh tokens
S3 credentials
signed URLs
file contents

---

# 59. Stable error handling

Add or reuse stable errors such as:

SYNC_ACCOUNT_UNAVAILABLE
SYNC_PROVIDER_LIST_FAILED
SYNC_PROVIDER_RATE_LIMITED
SYNC_RECONCILIATION_FAILED
SYNC_FOLDER_COLLISION
SYNC_FILE_COLLISION
SYNC_VIRTUAL_FOLDER_CONFLICT
SYNC_MAPPING_CONFLICT
SYNC_PARTIAL_SCAN
SYNC_CANCELLED

Adapt names to existing conventions.

Do not expose internal stack traces to normal users.

---

# 60. Cancellation

If Sync is cancellable, preserve cancellation.

Cancellation must:

- stop new provider page requests
- stop new folder traversal
- stop queued account work
- mark run cancelled
- NOT execute missing-resource cleanup
- preserve resources already safely reconciled
- not corrupt virtual mappings

A cancelled Sync is not a successful complete scan.

Therefore:

NO missing cleanup after cancellation.

---

# 61. Sync restart / retry

A failed account Sync should be retryable.

Retry may rescan the account.

Because reconciliation is idempotent:

- existing folders are reused
- existing mappings are reused
- existing files are updated
- duplicate virtual records are not created

Do not require deleting the previous partial Sync before retry.

---

# 62. Idempotency requirement

Running Sync repeatedly without provider changes must not create database
changes beyond:

last sync metadata
last seen metadata
sync history

Example:

Sync A
Sync A
Sync A

must still produce:

one virtual Mov
one Mov + A mapping
one File record per provider file

No duplicates.

This must have automated tests.

---

# 63. Provider path divergence

Add explicit tests for:

Initial:

A / Mov
B / Mov

one Virtual Mov.

Then external change:

B / Mov
→
B / Movies

Sync B.

Expected:

Virtual Mov → A
Virtual Movies → B

Do NOT rename shared Virtual Mov.

---

# 64. Provider parent divergence

Add test:

Initial:

A / Mov / Action
B / Mov / Action

shared virtual tree.

External B move:

B / Archive / Action

Sync B.

Expected:

Virtual:

Mov/
└── Action → A

Archive/
└── Action → B

Do not move A logically.

---

# 65. Re-convergence

Handle a later situation where divergent physical paths become the same again.

Example:

A:
Mov/

B:
Movies/

Later user physically renames B back to:

Mov/

Sync B.

The system should reuse existing compatible Virtual Mov where safe and attach B
mapping back to it.

Avoid leaving unnecessary duplicate empty virtual folders.

If old Virtual Movies becomes empty and is safely known to be Sync-created, it
may be pruned according to the safe pruning policy.

---

# 66. Automated tests — required folder cases

Add tests for:

1. A/Mov only.
2. A/Mov + B/Mov.
3. A/Mov/Action + B/Mov/Action.
4. A/Mov/Action + B/Mov/Drama.
5. Three accounts sharing the same virtual path.
6. Account Sync repeated multiple times.
7. Concurrent Sync discovers same virtual folder.
8. Same-account duplicate physical folder names.
9. Provider-side rename with one mapping.
10. Provider-side rename with multiple mappings.
11. Provider-side move with one mapping.
12. Provider-side move with multiple mappings.
13. Missing folder on A while B mapping remains.
14. Cancelled Sync does not cleanup missing.
15. Failed Sync does not cleanup missing.
16. Successful Sync reconciles missing A mappings only.

---

# 67. Automated tests — required file cases

Add tests for:

1. File created on A.
2. File created on B in same virtual folder.
3. Existing provider file updated.
4. Existing provider file renamed.
5. Existing provider file moved.
6. File deleted on A.
7. File B unaffected by Sync A.
8. Same filename A and B.
9. Same filename but different checksums.
10. Same filename and same checksum.
11. Repeated Sync does not duplicate File.
12. File created by Remote Import is not duplicated.
13. File created by normal upload is not duplicated.

---

# 68. Automated tests — Sync All

Create:

A:
Mov/
├── A.mkv
└── Action/
    └── AA.mkv

B:
Mov/
├── B.mkv
└── Action/
    └── BB.mkv

C:
Mov/
└── Drama/
    └── CC.mkv

Run Sync All concurrently.

Expected:

Mov/
├── A.mkv
├── B.mkv
├── Action/
│   ├── AA.mkv
│   └── BB.mkv
└── Drama/
    └── CC.mkv

Mappings:

Mov → A,B,C
Action → A,B
Drama → C

No duplicates.

---

# 69. Mandatory end-to-end scenario

Do not consider the feature complete until this scenario passes.

Initial providers:

Account A:

9drive/
└── Mov/
    ├── A.mkv
    └── Action/
        └── A2.mkv

Account B:

9drive/
└── Mov/
    ├── B.mkv
    └── Action/
        └── B2.mkv

Database initially contains no Mov virtual folder.

Run:

Sync All

Expected:

Folder:

Mov

FolderStorageLocation:

Mov + A
Mov + B

Folder:

Mov/Action

FolderStorageLocation:

Action + A
Action + B

Files:

A.mkv
folder = Mov
account = A

B.mkv
folder = Mov
account = B

A2.mkv
folder = Action
account = A

B2.mkv
folder = Action
account = B

All Files:

Mov/
├── A.mkv
├── B.mkv
└── Action/
    ├── A2.mkv
    └── B2.mkv

Then:

Run Sync All again.

Expected:

NO duplicate Folder
NO duplicate mapping
NO duplicate File

Then delete physical:

Account A / Mov / A.mkv

Run Sync A.

Expected:

A.mkv reconciled missing/deleted according to application policy.

B.mkv remains.

Then delete:

Account A / Mov folder

while Account B / Mov remains.

Run Sync A.

Expected:

Mov + A mapping removed/marked missing.

Virtual Mov remains.

Account B mapping remains.

Then create:

Account C / Mov / C.mkv

Run Sync C.

Expected:

Existing Virtual Mov reused.

Mov + C mapping created.

C.mkv appears in same Mov.

---

# 70. Mandatory boundary test

Mock provider write APIs.

Run Storage Sync.

Assert that Sync NEVER invokes:

createFolder()
renameFolder()
moveFolder()
deleteFolder()

on another account in order to mirror virtual structure.

Sync is Provider → Virtual reconciliation only.

This is a mandatory architectural test.

---

# 71. UI changes

Inspect the existing Sync UI.

Do not perform a major redesign.

Update wording if current UI suggests:

each account has an independent virtual filesystem.

The UI may show:

Sync All

Google Drive A
Completed
1,284 files
48 folders

Google Drive B
Completed
1,011 files
42 folders

The virtual All Files view remains merged.

Optionally display Sync summary:

2 accounts synchronized
2,295 files discovered
76 physical folder mappings
48 virtual folders

Do not expose provider folder IDs.

---

# 72. Folder details

If folder details currently show:

Storage Account: Google Drive A

remove the implication that a folder has one owner.

Optional replacement:

Storage Locations: 2

Google Drive A
Google Drive B

But this UI is secondary.

Do not delay core Sync correctness for it.

---

# 73. Documentation

Update architecture documentation.

Add a section:

Multi-Storage Sync Reconciliation

Explain:

Virtual Folder
vs
FolderStorageLocation

Explain:

Sync = Provider → Virtual

Explain:

Folder Materialization = Virtual → Provider when required

Include example:

A/Mov
+
B/Mov
→
one virtual Mov

Document account-scoped missing reconciliation.

Document provider-side divergence behavior.

Document same-account duplicate-folder collision behavior.

Document that Sync does not replicate folders between accounts.

---

# 74. Required commands

Determine exact commands from the repository.

Run all relevant:

Prisma format
Prisma validate
Prisma generate
Prisma migrations
Backend lint
Backend typecheck
Backend unit tests
Backend integration tests
Sync worker tests
Frontend lint
Frontend typecheck
Frontend tests
Frontend build
Docker Compose config
Docker build

If Playwright exists, test:

- Sync All UI
- All Files merged result
- account-specific Sync status

Do not claim a command passed unless it was actually executed.

Fix every failure introduced by this implementation.

Clearly separate unrelated pre-existing failures.

---

# 75. Final acceptance criteria

The feature is complete only when:

- Account A / Mov and Account B / Mov become ONE Virtual Mov.
- Nested matching folders also merge.
- Files from A and B appear in the same virtual folder.
- FolderStorageLocation stores the account-specific physical mappings.
- Sync Account A affects only A reconciliation.
- Sync All safely processes multiple accounts.
- Concurrent Sync does not create duplicate virtual folders.
- Repeated Sync is idempotent.
- Files are matched by connectedAccountId + providerFileId.
- Folders are matched first by physical provider mapping and then logical path.
- A missing A mapping does not remove B mapping.
- A failed/partial Sync performs no missing cleanup.
- A cancelled Sync performs no missing cleanup.
- Provider-side rename/move does not incorrectly restructure other storage
  accounts.
- Same-account duplicate folder names are preserved through collision handling.
- Sync does not physically replicate folders to another account.
- Existing FolderMaterializationService mappings are reused.
- Normal uploads remain functional.
- Remote Imports remain functional.
- All Files remains one unified virtual filesystem.
- Database constraints prevent duplicate mappings.
- Relevant tests pass.
- Backend and frontend builds pass.

---

# 76. Final report

At completion provide:

## Existing Sync architecture

Explain how Sync previously worked.

## Root problem

Explain why the old model produced provider-specific folder trees.

## New Sync architecture

Show:

Provider A ─┐
            ├── Sync Reconciliation → Virtual Filesystem
Provider B ─┤
Provider C ─┘

## Folder merge strategy

Explain:

provider identity lookup
→ virtual parent/name matching
→ FolderStorageLocation upsert

## File strategy

Explain providerFileId-based identity.

## Account scoping

Explain why Sync A cannot modify B.

## Missing-resource reconciliation

Explain successful-scan-only cleanup.

## Provider divergence

Explain rename and move behavior for multi-location folders.

## Collision handling

Explain:

cross-account same folder path
vs
same-account duplicate folder names
vs
same-filename files

## Relationship with uploads

Explain FolderMaterializationService.

## Database changes

Show new/changed models and indexes.

## Files changed

List important files.

## Tests added

List tests.

## Commands executed

For every command:

Command:
Result:

## Mandatory scenario result

Report the A/Mov + B/Mov Sync All test.

## Regression result

Report repeated Sync without duplicates.

## Remaining limitations

List honestly.

## Follow-up recommendations

Possible future features only:

- File replicas / VirtualFile + FileStorageLocation
- Deduplication
- Manual provider reconciliation
- Storage rebalance
- Account evacuation
- WebDAV

Do NOT implement these unrelated future features in this task.

Do not claim completion until:

A/Mov
+
B/Mov

successfully produces:

ONE Virtual Mov

with:

TWO FolderStorageLocation records

and files from BOTH accounts visible together in All Files.