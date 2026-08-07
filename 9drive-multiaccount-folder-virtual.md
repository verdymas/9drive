You are working inside the existing 9Drive project.

Implement a major storage architecture refactor called:

MULTI-STORAGE VIRTUAL FOLDERS WITH LAZY PHYSICAL FOLDER REPLICATION

The current behavior is:

- A virtual folder can be bound to a single connectedAccountId.
- When uploading into a folder, that folder-bound connected account takes
  precedence over "Automatic" storage selection.
- This exists because a Google Drive parent folder ID belongs only to one
  Google Drive account. Uploading into that remote folder using another account
  causes provider 404 errors.

This behavior must be replaced.

The new architecture must allow ONE virtual folder in 9Drive to contain files
stored across MULTIPLE connected storage accounts.

Example:

Virtual 9Drive filesystem:

Movies/
├── Avatar.mkv
├── Interstellar.mkv
├── Dune.mkv
└── The Batman.mkv

Physical storage:

Google Drive A:
9drive/
└── Movies/
    ├── Avatar.mkv
    └── Interstellar.mkv

Google Drive B:
9drive/
└── Movies/
    ├── Dune.mkv
    └── The Batman.mkv

The 9Drive UI must still show one single virtual folder:

Movies/
├── Avatar.mkv
├── Interstellar.mkv
├── Dune.mkv
└── The Batman.mkv

The selected storage account for each file is an implementation detail.

The virtual folder itself must no longer be owned by a single storage account.

Do not implement this as a small conditional patch.

This is an architectural refactor.

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
- Folder routes/controllers/services
- File routes/controllers/services
- Upload routes/controllers/services
- Remote Import implementation
- Google Drive provider
- S3 provider
- Connected account models
- Storage routing implementation
- Quota tracking
- File creation flow
- Folder creation flow
- Folder rename flow
- Folder move flow
- Folder delete flow
- Automatic storage routing
- Manual connected-account selection
- All Files listing
- Folder picker
- Remote Import destination picker
- Existing tests

Search for:

connectedAccountId
providerFolderId
folderId
parentId
Folder
File
ConnectedAccount
routing
automatic
quota
upload
remote-import
google
s3
move
rename
delete
folder ownership
parent folder

Identify exactly where the current rule:

"folder-bound uploads beat Automatic"

is implemented.

Also identify all places where the application assumes:

Folder -> exactly one connected account

or:

Folder -> exactly one provider folder ID

Produce a concise implementation plan before coding.

Then continue implementation without waiting for confirmation unless there is a
genuinely blocking architecture issue.

---

# 2. Target domain model

The application must distinguish between:

1. Virtual folders
2. Physical folder locations

A virtual Folder represents only the logical filesystem visible to users.

A physical folder location represents where that virtual folder exists on a
specific storage account.

Conceptually:

Virtual Folder: Movies
ID: virtual-folder-123

Physical locations:

Movies
├── Google Drive A
│   └── providerFolderId = remote-a-123
│
├── Google Drive B
│   └── providerFolderId = remote-b-456
│
└── S3 Account C
    └── providerFolderId / object prefix = appropriate provider location

One virtual folder may have:

0 physical locations
1 physical location
many physical locations

This is critical.

Do not create duplicate virtual folders per storage account.

---

# 3. Prisma schema refactor

Inspect the existing schema and adapt names to repository conventions.

Introduce a model conceptually equivalent to:

model FolderStorageLocation {
  id                 String
  folderId           String
  connectedAccountId String
  providerFolderId   String
  createdAt          DateTime
  updatedAt          DateTime

  folder             Folder
  connectedAccount   ConnectedAccount

  @@unique([folderId, connectedAccountId])
  @@index([connectedAccountId])
  @@index([folderId])
}

Use the actual ID types, database mappings, timestamps, naming conventions, and
relation conventions from the repository.

Preferred domain name:

FolderStorageLocation

Alternative names are acceptable only if they fit the existing codebase better.

The core rule is:

one virtual folder
+
many physical account-specific locations

The Folder model must no longer use connectedAccountId/providerFolderId as the
authoritative storage ownership for uploads.

If those fields currently exist, carefully migrate their meaning into
FolderStorageLocation.

Do not blindly remove existing fields before migration safety has been handled.

Create a proper Prisma migration.

---

# 4. Existing-data migration

If existing folders currently contain:

connectedAccountId
providerFolderId

create FolderStorageLocation records from them.

Example:

Before:

Folder:
id = folder-1
name = Movies
connectedAccountId = drive-a
providerFolderId = google-folder-123

After:

Folder:
id = folder-1
name = Movies

FolderStorageLocation:
folderId = folder-1
connectedAccountId = drive-a
providerFolderId = google-folder-123

Do not duplicate provider folders during migration.

Make migration idempotent where repository migration conventions permit.

After migration, update the runtime code so the old folder-bound fields are no
longer used for routing.

If the application is still development-only and repository analysis confirms
there is no compatibility requirement, you may simplify cleanup after the
migration.

But do not assume this without inspecting the project.

---

# 5. Folder creation becomes virtual-first

When a user creates:

Movies/
└── Action/
    └── Marvel/

the system should create virtual Folder records first.

It should NOT automatically create the same folder tree in every connected
storage account.

Example:

Virtual database:

Movies
└── Action
    └── Marvel

Physical storage locations:

none yet

This is valid.

Physical folder creation should happen lazily when an upload actually needs the
folder on a selected storage account.

This behavior is called:

lazy physical folder materialization

---

# 6. Create reusable ensureFolderStorageLocation service

Implement a central reusable domain service conceptually equivalent to:

ensureFolderStorageLocation(
  virtualFolderId,
  connectedAccountId
)

This service is one of the most important parts of the refactor.

Its job:

Given:

Virtual destination:
Movies / Action / Marvel

Selected storage:
Google Drive B

ensure that the entire required physical parent chain exists on Google Drive B.

Example:

Google Drive B initially has:

9drive/

But does not have:

Movies/
Action/
Marvel/

The service must:

1. Resolve the virtual folder.
2. Check FolderStorageLocation for Marvel + Drive B.
3. If it exists, return providerFolderId immediately.
4. If not, resolve parent Action.
5. Ensure Action exists physically on Drive B.
6. If Action does not exist, resolve Movies.
7. Ensure Movies exists physically on Drive B.
8. Ensure provider root exists.
9. Create Movies on Drive B.
10. Persist Movies storage location.
11. Create Action under physical Movies.
12. Persist Action storage location.
13. Create Marvel under physical Action.
14. Persist Marvel storage location.
15. Return the physical provider folder identifier for Marvel.

Conceptual recursion:

ensure(Marvel, Drive B)
    ↓
ensure(Action, Drive B)
    ↓
ensure(Movies, Drive B)
    ↓
ensure(provider root)
    ↓
create Movies
    ↓
create Action
    ↓
create Marvel

Use iterative logic instead if safer.

The behavior must be deterministic and idempotent.

---

# 7. Concurrency and duplicate-folder protection

Two simultaneous uploads may target:

Movies / Action / Marvel

on the same new storage account.

They must not create:

Marvel
Marvel

or duplicate storage-location mappings.

Protect this at multiple layers.

Database:

@@unique([folderId, connectedAccountId])

Application:

- Use transaction/locking/retry consistent with MySQL and Prisma capabilities.
- Handle unique constraint races.
- Re-read the mapping after a concurrent creation.
- Do not assume checking before creation is enough.

Provider:

If a provider API can return existing folders by parent + name, use a safe
provider-specific reconciliation strategy when necessary.

The final result must be exactly one logical mapping per:

virtualFolder + connectedAccount

---

# 8. Introduce storage-folder abstraction

Do not put Google Drive-specific folder creation logic directly inside generic
upload code.

Extend the storage provider abstraction with capabilities equivalent to:

ensureRootLocation(...)
createFolder(...)
renameFolder(...)
moveFolder(...)
deleteFolder(...)
folderExists(...)

or another clean design consistent with the current provider architecture.

For Google Drive:

providerFolderId = Google Drive folder ID

For S3-compatible object storage:

a physical folder may represent:

- object prefix
- logical key prefix
- or no real directory object

Implement S3 behavior appropriate to the existing provider abstraction.

Do not fake Google Drive semantics inside S3.

---

# 9. Automatic storage routing must become truly automatic

Remove the current rule:

if destinationFolder.connectedAccountId exists:
    always use that account

The new routing behavior must be:

if user manually selected a connected account:
    selectedAccount = manually selected account
else:
    selectedAccount = automaticStorageRouting(...)

Then:

physicalDestination =
    ensureFolderStorageLocation(
        destinationVirtualFolder,
        selectedAccount
    )

Then:

upload(
    selectedAccount,
    physicalDestination,
    file
)

The virtual folder itself must NOT override Automatic selection.

---

# 10. Automatic routing account eligibility

Automatic routing should consider all eligible connected storage accounts owned
by the user.

Exclude accounts that:

- are disabled
- are disconnected
- are unhealthy where current project tracks health
- do not support upload
- do not have enough known available quota
- violate provider-specific constraints

Use the existing routing strategies.

Do not create a second unrelated routing engine.

Reuse existing logic for:

- most available
- round robin
- priority
- or any current strategy

But remove folder ownership as a hard constraint.

---

# 11. Existing-folder preference optimization

Automatic routing may prefer an eligible account where the destination folder
already has a physical location.

Example:

Drive A:
free = 40 GB
Movies exists = yes

Drive B:
free = 45 GB
Movies exists = no

File:
5 GB

It is acceptable to prefer Drive A because the destination physical folder
already exists.

However this must only be a soft preference.

Example:

Drive A:
free = 2 GB

Drive B:
free = 45 GB

File:
10 GB

Drive A must NOT be selected.

Drive B should be selected.

Then the Movies folder tree should be lazily created on Drive B.

Implement this without breaking the existing configured routing policy.

Possible approach:

1. Determine eligible accounts.
2. Exclude insufficient-quota accounts.
3. Apply existing routing strategy.
4. Optionally use existing-folder presence as a tie-breaker or configurable
   preference.

Do not sacrifice storage availability merely to avoid creating folders.

---

# 12. Manual storage selection

Manual account selection must still work.

Example:

Destination:
Movies / Action / Marvel

Storage:
Google Drive B

If Marvel is not physically present on Drive B:

ensureFolderStorageLocation(
  Marvel,
  Drive B
)

must create:

Drive B
└── 9drive
    └── Movies
        └── Action
            └── Marvel

Then upload there.

Do not reject the upload just because the virtual folder originated on another
storage account.

---

# 13. Regular upload integration

Update normal file upload so it uses the new architecture.

Required flow:

User selects virtual folder
        ↓
Determine storage account
        ↓
ensureFolderStorageLocation()
        ↓
Upload provider file
        ↓
Create File database record

The final File record should continue to contain enough information to resolve
its actual physical storage.

Conceptually:

File:
folderId = virtual folder
connectedAccountId = actual selected storage account
providerFileId = actual provider file ID

This allows one folder to contain:

File A -> Drive A
File B -> Drive A
File C -> Drive B
File D -> S3 C

Do not move provider ownership from File into FolderStorageLocation.

A file still belongs physically to one specific provider/account.

---

# 14. Remote Import integration

Update Remote Import.

Automatic storage in Remote Import must follow the same routing logic as normal
uploads.

Required flow:

Remote URL
    ↓
download / HLS processing
    ↓
destination virtual folder
    ↓
Automatic routing
    ↓
selected account
    ↓
ensureFolderStorageLocation()
    ↓
upload
    ↓
File record

Do not keep the old behavior:

folder-bound account wins over Automatic

Remote Import and normal upload must share the same account-selection and folder
materialization services.

Avoid duplicated implementations.

---

# 15. Unknown-size uploads

For direct uploads or Remote Imports where file size is not known initially:

- Apply the safest current automatic routing strategy.
- Re-check available quota before provider upload when final size becomes known.
- If selected account no longer has enough capacity, automatically re-route if
  the user selected Automatic.
- Create the destination folder tree only on the final selected account where
  possible.

If the user explicitly selected an account and it has insufficient quota:

fail clearly instead of silently choosing another account.

Manual selection must remain authoritative.

Automatic selection may re-route.

---

# 16. All Files must aggregate by virtual folder

The All Files UI must NOT group or separate files by physical connected account.

Listing a virtual folder should conceptually query:

folders:
parentId = currentVirtualFolderId

files:
folderId = currentVirtualFolderId

Do not derive folder content from provider folder listings.

Example:

Movies/

File A:
Drive A

File B:
Drive B

File C:
S3 C

All Files must show:

Movies/
├── File A
├── File B
└── File C

as one unified virtual folder.

---

# 17. Storage indicator in UI

The default file manager should remain simple.

Do not visually split a folder into provider sections.

Optionally show a subtle provider/account indicator on each file if the current
UI already has storage metadata.

For example:

Movie A.mkv
Google Drive A

Movie B.mkv
Google Drive B

But storage account detail should not dominate the normal folder experience.

The folder itself should no longer display:

Owned by Google Drive A

or equivalent wording.

Replace this concept.

---

# 18. Folder UI semantics

Folder is now a virtual object.

Update frontend wording where needed.

Remove or refactor messages equivalent to:

This folder belongs to Drive A.

For storage selection use wording conceptually equivalent to:

Storage Account

Automatic (recommended)

Helper:

Automatically selects an account with enough available storage.
The folder structure will be created on that account when needed.

Manual choices:

Google Drive A
Google Drive B
S3 C

Use existing UI components and styles.

Do not perform a broad visual redesign.

---

# 19. FolderStorageLocation visibility

FolderStorageLocation is primarily an internal implementation detail.

Do not expose complex mapping data in All Files.

If useful, add an admin/details view showing:

Physical Locations

Google Drive A
Google Drive B

But this is optional.

Do not delay the core implementation for this optional UI.

---

# 20. Folder rename

When a virtual folder is renamed:

Movies
→
Films

the virtual Folder name changes.

For every existing FolderStorageLocation:

Drive A / Movies
Drive B / Movies

attempt to rename the physical provider folder:

Drive A / Films
Drive B / Films

Use provider abstraction.

Important consistency rules:

- The database virtual folder remains authoritative.
- Do not corrupt the virtual tree because one provider rename temporarily
  failed.
- Record or log provider synchronization failures safely.
- Add retry/reconciliation support if the project already has job
  infrastructure suitable for this.

Do not create an excessively complex distributed transaction.

For the first implementation, implement the safest practical consistency model
and document it.

---

# 21. Folder move

Example:

Before:

Movies/
└── Marvel/

After:

Archive/
└── Marvel/

Virtual database:

Marvel.parentId = Archive.id

For every existing storage location for Marvel:

Drive A
Drive B

ensure the new physical parent exists on the same account:

ensureFolderStorageLocation(
  Archive,
  Drive A
)

then move physical Marvel under Archive on Drive A.

Repeat for Drive B.

Do not assume Archive already exists on every storage account.

Provider operations must use provider-specific APIs.

---

# 22. Folder delete

Deleting a virtual folder may involve multiple physical folder locations.

Example:

Movies
├── location Drive A
├── location Drive B
└── location S3 C

Implement delete according to current 9Drive file/folder deletion semantics.

Important:

- Virtual database structure remains authoritative.
- Handle every physical location.
- Do not assume one provider folder.
- Do not leave mappings pointing to deleted virtual folders.
- Preserve existing soft-delete/trash behavior if applicable.
- Do not accidentally delete unrelated provider folders.

Review current recursive deletion carefully.

---

# 23. File move

Moving a file between virtual folders may now require a cross-account move.

Example:

File currently:
Drive A / Movies

Destination virtual folder:
Archive

Automatic/manual rules may determine whether the file remains on Drive A or
moves storage account.

First inspect current application semantics.

For the initial implementation, prefer this behavior unless project conventions
strongly suggest otherwise:

Moving an existing file between virtual folders should keep the file on its
current connected account when possible.

Then:

ensureFolderStorageLocation(
  destinationFolder,
  file.connectedAccountId
)

and move the provider file there.

This avoids unnecessary cross-account data copying.

Do not automatically copy a large existing file to another account just because
the current automatic routing policy would choose differently for a new upload.

Document this distinction:

new upload:
Automatic may choose any eligible account

existing file move:
prefer preserving current physical account

---

# 24. Folder move versus new upload distinction

This is important.

Automatic routing applies primarily to NEW FILE PLACEMENT.

It should not silently redistribute existing files during ordinary folder
operations.

Do not introduce storage balancing/migration as part of this refactor.

Storage rebalance should be a future separate feature.

---

# 25. Connected account removal

Inspect current behavior when a connected storage account is removed.

Update it for multi-location folders.

If account Drive A is disconnected:

FolderStorageLocation records belonging to Drive A must be handled correctly.

Files physically stored on Drive A must follow current orphan/unavailable-file
semantics.

Do not delete the virtual folder simply because one physical location is gone.

Example:

Movies locations:

Drive A
Drive B

Disconnect Drive A.

Movies must still exist virtually.

Drive B mapping remains valid.

Files on Drive A may become unavailable according to existing application
behavior.

---

# 26. Provider root handling

Each connected account may have a provider-specific 9Drive root folder.

Ensure the physical-location service understands the provider root.

Conceptual:

ConnectedAccount
└── 9drive root

Then:

ensureFolderStorageLocation(
  Movies / Action,
  Drive B
)

must construct:

Drive B
└── 9drive
    └── Movies
        └── Action

Do not assume the virtual root has a normal Folder database record if the
current architecture treats root specially.

Adapt to the actual implementation.

---

# 27. S3-specific behavior

Do not force Google Drive folder concepts onto S3.

If the current S3 provider uses object-key prefixes:

Virtual:

Movies / Action / movie.mkv

Physical S3 key:

9drive/Movies/Action/movie.mkv

FolderStorageLocation may store an appropriate provider prefix, or the provider
may derive it from the virtual path.

Inspect existing S3 implementation.

Use a provider-specific strategy.

The high-level application must still treat:

FolderStorageLocation

as the abstraction.

---

# 28. Quota behavior

Automatic routing must check available quota.

Example:

Drive A:
free = 500 MB
Movies location exists

Drive B:
free = 80 GB
Movies location absent

File:
12 GB

Expected:

Drive B selected.

Then:

ensureFolderStorageLocation(
  Movies,
  Drive B
)

Then upload.

Do not allow existing folder location preference to override insufficient quota.

Add tests for this exact scenario.

---

# 29. Routing race conditions

Quota may change between:

routing
and
upload

Handle provider quota failures.

For Automatic mode:

if selected account fails before upload due to insufficient storage and another
eligible account exists:

- safely choose another account
- ensure destination physical folder there
- retry according to existing retry policy

Do not reroute indefinitely.

Set a bounded number of account-selection attempts.

For manual storage selection:

do not automatically switch providers.

Return a clear quota error.

---

# 30. Folder materialization race conditions

Test:

10 simultaneous uploads
→ same virtual folder
→ Automatic routes all to Drive B
→ physical folder does not exist yet

Expected:

only one physical folder tree is created.

All uploads receive the same providerFolderId mapping.

No duplicate mappings.

No duplicate sibling folders.

---

# 31. API response cleanup

Inspect folder API responses.

If they currently expose:

connectedAccountId
providerFolderId

as folder ownership fields, refactor them.

Do not make frontend depend on a single folder account.

Folder API should represent:

virtual folder metadata

not a physical storage owner.

If physical location count is useful:

storageLocationCount

may be exposed.

But do not return provider IDs unnecessarily.

---

# 32. Folder picker

The destination folder picker must operate only on the virtual folder tree.

It must not filter destination folders based on selected storage account.

Example:

Movies/Marvel

must remain selectable even when the selected account has never physically
contained Marvel before.

The backend will lazily materialize it.

Update Remote Import and normal upload folder pickers if necessary.

---

# 33. File detail

File detail may continue to show the actual physical connected account.

Example:

File:
Dune.mkv

Virtual location:
Movies

Storage:
Google Drive B

This is correct.

Folder details should not imply that all files use Google Drive B.

---

# 34. WebDAV compatibility preparation

Do not implement WebDAV in this task unless it already exists.

But the architecture must support it cleanly.

Future lookup:

GET /dav/Movies/Dune.mkv

resolves:

virtual folder Movies
+
File Dune.mkv
+
file.connectedAccountId = Drive B
+
file.providerFileId

Then streams from Drive B.

Do not build any provider-account assumption into virtual folder lookup.

---

# 35. Caching

Inspect any folder or file caches.

Cache keys must not assume:

folder -> account

Update invalidation when:

- storage location created
- storage location renamed
- storage location moved
- storage location deleted
- account disconnected

Do not introduce stale providerFolderId selection.

---

# 36. Logging

Add structured safe logging for physical materialization.

Include:

virtualFolderId
connectedAccountId
provider
createdLocationCount
reusedExistingLocation
routingStrategy
automaticOrManual

Do not log:

provider tokens
Google OAuth tokens
S3 secrets
sensitive file URLs

Example safe log event:

folder_storage_location.created

{
  virtualFolderId,
  connectedAccountId,
  provider,
  providerFolderId: optional only if current logging policy permits
}

---

# 37. Service architecture

Prefer reusable domain services conceptually equivalent to:

StorageRoutingService

FolderStorageLocationService

FolderMaterializationService

UploadPlacementService

ProviderFolderService

Do not put everything inside a route controller.

Controllers should remain thin.

Normal upload and Remote Import must share:

storage account selection
+
folder materialization
+
file registration

Do not duplicate these flows.

---

# 38. Suggested placement flow

Implement a central flow conceptually equivalent to:

resolveUploadPlacement({
  userId,
  virtualFolderId,
  requestedConnectedAccountId,
  fileSize,
  mode
})

Return:

{
  connectedAccount,
  folderStorageLocation
}

Logic:

if requestedConnectedAccountId:
    verify account
    verify ownership
    verify upload eligibility
    verify quota
    selected = requested account

else:
    selected = automatic routing

location =
    ensureFolderStorageLocation(
        virtualFolderId,
        selected.id
    )

return {
    connectedAccount: selected,
    folderStorageLocation: location
}

Both normal upload and Remote Import should use this shared service.

---

# 39. Avoid premature physical creation

Do NOT do:

create virtual folder
→ create physical folder in every account

This would produce unnecessary provider folders.

Only create a physical storage location when something actually needs to be
placed there.

This must remain lazy.

---

# 40. Tests — database/domain

Add tests for:

- Virtual folder with zero physical locations.
- Virtual folder with one physical location.
- Virtual folder with multiple physical locations.
- Unique folder/account mapping.
- Existing-folder migration.
- Parent-chain materialization.
- Nested-folder materialization.
- Existing mapping reuse.
- Concurrent materialization.
- Different provider accounts produce different providerFolderIds.
- Deleting one storage account does not delete the virtual folder.
- Listing virtual folder aggregates files from different accounts.

---

# 41. Tests — Automatic routing

Test:

Scenario A:

Drive A:
100 GB free
folder exists

Drive B:
50 GB free
folder absent

File:
5 GB

Expected according to existing strategy plus folder preference.

Scenario B:

Drive A:
2 GB free
folder exists

Drive B:
50 GB free
folder absent

File:
10 GB

Expected:

Drive B

and lazy folder materialization.

Scenario C:

Drive A:
full

Drive B:
full

Expected:

clear insufficient storage error.

Scenario D:

Manual Drive A
Drive A insufficient quota
Drive B has space

Expected:

fail on Drive A

Do NOT silently switch to B.

Scenario E:

Automatic initially picks A
provider quota changed before upload
A now full
B has space

Expected:

bounded reroute to B.

---

# 42. Tests — normal upload

Test:

Virtual folder Movies exists only physically on Drive A.

Automatic upload 1:
Drive A has sufficient quota
→ Drive A

Later:

Drive A full
Drive B available

Automatic upload 2:
→ Drive B
→ create Movies physical location on B
→ upload succeeds

All Files:

Movies
├── upload-1
└── upload-2

Both visible together.

---

# 43. Tests — nested folder

Virtual:

Movies
└── Action
    └── Marvel

Only Drive A has physical tree.

Automatic selects Drive B.

Expected Drive B physical tree:

9drive/
└── Movies/
    └── Action/
        └── Marvel/

Mappings must exist for all required virtual folders on Drive B.

Upload must succeed inside physical Marvel.

---

# 44. Tests — Remote Import

Repeat the same multi-storage scenarios through Remote Import.

Direct URL import and HLS import should both use the new placement service.

Test:

destination:
Movies / Action

Automatic

Drive A full
Drive B available

Expected:

Remote Import downloads/converts successfully
→ placement chooses Drive B
→ folder tree materialized
→ output uploaded to B
→ file record folderId remains virtual Action
→ All Files displays it normally

---

# 45. Tests — rename

Virtual folder exists physically on:

Drive A
Drive B

Rename virtual folder.

Verify provider rename attempts happen for both mappings.

Verify database virtual folder has one new name.

Verify mappings still point to the same virtual folder ID.

Verify one provider failure does not create duplicate virtual folders.

---

# 46. Tests — move

Virtual folder exists physically on:

Drive A
Drive B

Move it under a new virtual parent.

Verify:

new parent is lazily materialized on A
new parent is lazily materialized on B

then existing physical folders are moved accordingly.

---

# 47. Tests — All Files

Create:

Movies

File A:
connectedAccountId = Drive A
folderId = Movies

File B:
connectedAccountId = Drive B
folderId = Movies

File C:
connectedAccountId = S3 C
folderId = Movies

GET/list Movies.

Expected:

A
B
C

No provider grouping required.

No missing file due to folder account filtering.

---

# 48. Frontend tests

Test:

- Folder picker works regardless of account.
- Automatic is available inside every virtual folder.
- Manual account selection works inside existing folders.
- Folder no longer displays a single owner account.
- Mixed-account files display normally.
- Provider badge/details, if shown, refer to the file, not the folder.
- Remote Import supports Automatic inside nested folders.
- Normal upload supports Automatic inside nested folders.
- Existing All Files responsive layout remains correct.

---

# 49. Migration verification

After implementing the schema migration, verify existing bound folder data.

Before migration:

Movies
bound to Drive A

After migration:

Movies virtual folder

FolderStorageLocation:
Movies + Drive A

Existing files must still resolve.

Existing uploads must still display.

No existing providerFolderId mapping should be lost.

---

# 50. Performance

Avoid N+1 queries when listing folders.

All Files should not load every FolderStorageLocation unless required.

Use:

include/select

carefully.

Folder materialization may traverse ancestors, but cache/reuse existing mappings
within the operation.

Do not create excessive provider API calls.

If:

Movies
Action

already exist physically and only Marvel is missing:

do not recreate or unnecessarily query every remote provider folder repeatedly
when trusted mappings already exist.

---

# 51. Security

Every FolderStorageLocation operation must verify:

- folder belongs to user
- connected account belongs to user

Never allow:

User A virtual folder
+
User B connected account

Do not trust IDs from the frontend without ownership validation.

Provider folder IDs must not be freely accepted from client input.

They are server-managed internal values.

---

# 52. Error codes

Add/reuse stable errors such as:

FOLDER_STORAGE_LOCATION_NOT_FOUND
FOLDER_MATERIALIZATION_FAILED
FOLDER_PROVIDER_CREATE_FAILED
FOLDER_PROVIDER_MOVE_FAILED
FOLDER_PROVIDER_RENAME_FAILED
STORAGE_ACCOUNT_NOT_ELIGIBLE
STORAGE_ACCOUNT_INSUFFICIENT_QUOTA
AUTOMATIC_STORAGE_NO_ELIGIBLE_ACCOUNT
AUTOMATIC_STORAGE_REROUTE_EXHAUSTED
PROVIDER_FOLDER_CONFLICT

Adapt naming to project conventions.

Do not expose provider tokens or internal stack traces.

---

# 53. Documentation

Add/update documentation explaining:

Virtual Folder

vs.

Physical Folder Storage Location

Document:

- One virtual folder can span multiple accounts.
- Automatic can select another account when one becomes full.
- Missing physical folder trees are created lazily.
- Manual storage selection remains strict.
- Existing files stay on their actual connected account.
- All Files aggregates files logically.
- Moving an existing file does not automatically rebalance storage.
- Rebalancing is outside this feature.

Add an architecture diagram similar to:

Virtual Movies
      │
      ├── Drive A / Movies
      ├── Drive B / Movies
      └── S3 / Movies

Update README if appropriate.

---

# 54. Required verification commands

Determine exact commands from the repository.

Run all applicable:

Prisma format
Prisma validate
Prisma generate
Prisma migration
Backend lint
Backend typecheck
Backend tests
Backend build
Frontend lint
Frontend typecheck
Frontend tests
Frontend build
Docker Compose config
Docker build
Integration tests

Do not claim commands passed unless actually executed.

Fix every failure introduced by the refactor.

Clearly identify unrelated pre-existing failures.

---

# 55. Mandatory end-to-end scenario

Do not consider this feature complete until this exact scenario passes.

Setup:

Virtual folder:

Movies/
└── Action/
    └── Marvel/

Physical state:

Drive A:
9drive/
└── Movies/
    └── Action/
        └── Marvel/

Drive B:
9drive/

Drive A:
not enough free quota

Drive B:
enough quota

User action:

Upload a file into:

Movies / Action / Marvel

Storage:

Automatic

Expected:

1. Automatic rejects Drive A because quota is insufficient.
2. Automatic selects Drive B.
3. 9Drive creates physical Movies on Drive B.
4. 9Drive creates physical Action under Movies on Drive B.
5. 9Drive creates physical Marvel under Action on Drive B.
6. FolderStorageLocation mappings are saved for each virtual folder.
7. File uploads into physical Marvel on Drive B.
8. File database record contains:
   folderId = virtual Marvel
   connectedAccountId = Drive B
   providerFileId = real provider file ID
9. All Files shows the new file under the SAME virtual Marvel folder.
10. Existing Drive A files remain visible in that same folder.
11. A second upload to Drive B reuses existing mappings.
12. No duplicate provider folders are created.

Repeat the same test through Remote Import.

---

# 56. Final architecture requirement

The final architecture must behave like:

Virtual filesystem:

Movies/
├── A.mkv
├── B.mkv
├── C.mkv
└── D.mkv

Physical:

Drive A:
Movies/
├── A.mkv
└── B.mkv

Drive B:
Movies/
└── C.mkv

S3 C:
Movies/
└── D.mkv

The user navigates ONE:

Movies/

not three provider-specific folders.

---

# 57. Final report

At completion provide:

## Root cause

Explain why folder-bound accounts previously overrode Automatic.

## Schema changes

Show the final Folder and FolderStorageLocation relationships.

## Migration

Explain how existing folder/account mappings were migrated.

## Routing changes

Explain old versus new Automatic behavior.

## Lazy folder materialization

Explain ensureFolderStorageLocation().

## Upload integration

Explain normal uploads.

## Remote Import integration

Explain direct and HLS imports.

## All Files behavior

Explain mixed-account folder aggregation.

## Folder operations

Explain create, rename, move, and delete behavior.

## Concurrency

Explain duplicate-creation prevention.

## Provider differences

Explain Google Drive versus S3 handling.

## Files changed

List important files.

## Tests added

List tests.

## Commands executed

For every command report:

Command:
Result:

## End-to-end result

Report the mandatory Drive A full → Drive B fallback scenario.

## Remaining limitations

List them honestly.

## Follow-up recommendations

Potential future features may include:

- Manual storage rebalance.
- Move file between storage accounts.
- Folder storage distribution visualization.
- Provider reconciliation jobs.
- WebDAV integration.
- Storage evacuation before account removal.

Do not implement these unrelated follow-up features in this task.

Do not claim completion until:

- Automatic works inside a previously folder-bound nested folder.
- An account becoming full causes Automatic to select another eligible account.
- The destination folder tree is lazily created on the selected account.
- Files from multiple connected accounts appear in one virtual folder.
- Existing direct uploads and Remote Imports continue working.
- Relevant tests and builds pass.