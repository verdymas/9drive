# B6 — WebDAV Metadata Progress

Status rule: check an item only after the implementation, focused tests,
relevant suite, and documentation update have passed. Complete the phases in
order.

## Phase 1 — Exact path lookup and indexes

- [x] Add exact child-folder lookup scoped to active folders and display name.
- [x] Add exact child-file lookup scoped to active files and display name.
- [x] Make deep path resolution use exact lookups instead of sibling scans.
- [x] Keep directory listing methods separate for PROPFIND enumeration.
- [x] Preserve folder-before-file name precedence and current MySQL name matching.
- [x] Add composite indexes matching the exact folder/file predicates.
- [x] Add root, nested, file-vs-folder, deleted, Unicode, and large-sibling tests.
- [x] Add query instrumentation proving deep resolution does not load sibling collections.
- [x] Update WebDAV/filesystem/database documentation.
- [x] Run focused WebDAV tests, Prisma validation, and backend build.

## Phase 2 — Slim directory projections and lazy provider accounts

- [x] Define strict WebDAV folder/file metadata projection types.
- [x] Select only WebDAV metadata for directory and path-resolution queries.
- [x] Ensure PROPFIND/listing rows do not hydrate connected-account credentials.
- [x] Load the full provider account only for an actual provider stream.
- [x] Keep HEAD metadata-only and preserve ETag/content-length/range behavior.
- [x] Add listing-without-secrets and streaming-with-account regression tests.
- [x] Update WebDAV, integration, and database documentation.
- [x] Run WebDAV/provider stream tests and backend build.

## Phase 3 — Short-lived metadata cache and measurements

- [x] Add structured WebDAV metadata lookup hit/miss/timing counters.
- [x] Add a bounded process-local LRU/TTL metadata cache.
- [x] Key cache entries by shared WebDAV namespace plus normalized path/row identity.
- [x] Cache metadata only; never cache provider streams or decrypted credentials.
- [x] Add conservative configurable TTL and entry-count defaults.
- [x] Document the maximum stale window and shared-root namespace semantics.
- [x] Add user-namespace isolation, TTL expiry, mutation visibility, and hit/miss tests.
- [x] Run WebDAV/file/folder mutation tests and backend build.

## Acceptance audit

- [x] Exact path resolution cost scales with path depth rather than sibling count.
- [x] Directory listing names and metadata remain equivalent.
- [x] Deleted entries remain invisible and provider streaming remains functional.
- [x] Cache is bounded, namespace-keyed, and stale-data behavior is documented.
- [x] Verify every phase's acceptance criteria against current code and tests.
- [x] Record commands, results, migration/config changes, and remaining risks.

## Verification record

### Phase 1 — Exact lookup and indexes

Changed files:
- `backend/src/modules/webdav/webdav-virtual-fs.ts` — exact folder/file child
  lookups with active/deleted predicates; directory listing methods remain
  separate.
- `backend/prisma/schema.prisma` — added `files_folder_status_name_idx` and
  `folders_parent_deleted_name_idx`.
- `backend/prisma/migrations/20260911030000_webdav_metadata_indexes/migration.sql`
  — matching MySQL migration.
- `backend/src/modules/webdav/webdav-virtual-fs.test.ts` — root, nested,
  collision, deleted, Unicode, and sibling-scan regression coverage.

Evidence:
- Targeted exact-lookup tests passed.
- Prisma-generated DDL contains both new composite indexes with the expected
  column order.

### Phase 2 — Slim projections and lazy streaming account

Changed files:
- `backend/src/modules/webdav/webdav-virtual-fs.ts` — strict
  `WebDavFolder`/`WebDavFile` projection types and metadata-only `select`
  clauses; full `connectedAccount` is retained only in the stream lookup.
- `backend/src/modules/webdav/webdav.routes.ts` — HEAD uses resolved metadata
  directly and no longer loads provider-account credentials.
- `backend/src/modules/webdav/webdav-virtual-fs.test.ts` and
  `backend/src/modules/webdav/webdav-no-decrypt.test.ts` — projection and
  provider-account regression coverage.

Evidence:
- WebDAV/provider-focused suite passed: 5 files, 24 tests.
- Full WebDAV suite passed: 4 files, 22 tests.

### Phase 3 — Bounded cache and measurements

Changed files:
- `backend/src/modules/webdav/webdav-metadata-cache.ts` — namespace-keyed,
  promise-single-flight, bounded LRU/TTL metadata cache with structured
  hit/miss/bypass/error timing logs.
- `backend/src/modules/webdav/webdav-metadata-cache.test.ts` — namespace
  isolation, TTL, LRU bound, invalidation, and log tests.
- `backend/src/config/env.ts` — `WEBDAV_METADATA_CACHE_TTL_MS` default `1000`
  ms/range `0..60000`; `WEBDAV_METADATA_CACHE_MAX_ENTRIES` default `1024`/
  range `0..10000`.
- `.env.docker.example`, `docker-compose.yml`, and the WebDAV/reference/
  runbook/README docs — configuration and stale-window documentation.

Evidence:
- Full backend test suite: `99` files, `1,152/1,152` tests passed.
- `npx prisma generate` passed.
- `$env:DATABASE_URL='mysql://root:local-only@localhost:3306/9drive'; npx prisma validate` passed.
- `npm run build` passed.
- `git diff --check` passed; only normal LF/CRLF warnings were reported.

Deployment note: the migration SQL is present and schema-validated, but no
live MySQL instance was available here to apply it. Deploy it through the
normal Prisma migration flow before relying on the new lookup indexes.

No performance claim is made without a runtime benchmark. The exact-query,
projection, cache bound, namespace, and stale-window guarantees are covered by
the tests and documented configuration.
