# Stage 3 — Browser Download Fallback for 9Drive Server Browser

## Prerequisites

Stage 1 — Server Browser MVP — and Stage 2 — Browser Capture and Import — must already exist.

Extend the current implementation. Do not recreate browser sessions, candidate capture, the import queue, or provider integrations.

## Objective

Add a fallback for downloadable resources that cannot be retrieved reliably through the existing Direct Remote Import request.

In fallback mode, the user initiates a normal download inside Server Browser. Chromium downloads the file into an isolated, quota-controlled temporary storage area. 9Drive then exposes the completed artifact as an import candidate and submits it through the existing provider upload workflow.

Expected flow:

```text
Remote browser download
  -> isolated temporary storage
  -> download completion validation
  -> artifact appears in 9Drive
  -> user selects Import to 9Drive
  -> existing upload queue/provider flow
  -> artifact cleanup
```

Do not automatically import every file merely because a download starts. Require an explicit user action before sending the artifact to a destination provider.

## Read First — Narrow Scope

Read `AGENTS.md`, the relevant documentation index, and only the files implementing:
- Server Browser lifecycle and browser-session isolation.
- Stage 2 candidate detection and import actions.
- Existing Remote Import queue and provider upload pipeline.
- Docker volumes, worker storage access, temporary-file handling, and cleanup jobs.
- Focused tests for these paths.

Do not scan the entire repository or rework unrelated storage/provider architecture.

## Requirements

### 1. Capture real browser downloads

Use supported Chromium download events or the browser service's supported download-management mechanism.

Track download lifecycle accurately:
- Started.
- In progress.
- Completed.
- Interrupted.
- Failed.
- Expired or removed.

Do not classify a partially written file as complete. A completed artifact must be validated before it becomes available to the import UI.

If filenames are supplied by the browser or remote server, treat them as untrusted metadata.

### 2. Isolated temporary artifact storage

Create or reuse a dedicated temporary storage area for browser downloads.

Requirements:
- Isolate artifacts by user and browser session.
- Use opaque artifact IDs; never accept arbitrary filesystem paths from the client.
- Prevent path traversal, symlink attacks, collisions, and unsafe file replacement.
- Use safe filesystem resolution and verify that the resolved file remains under the intended storage root.
- Do not expose host paths or raw internal storage URLs to the frontend.
- Keep browser profiles separate from downloaded-artifact storage.
- Do not expose the temporary volume publicly.
- Do not grant the browser container unnecessary host filesystem access.

Use atomic completion/finalization where appropriate. Store only the minimal metadata needed for ownership, filename, size, lifecycle state, and cleanup.

### 3. Enforce resource and quota limits

Implement configurable controls for:
- Maximum file size.
- Maximum total temporary storage usage.
- Per-user storage usage or artifact count.
- Concurrent downloads and imports.
- Download and upload timeouts.
- Artifact retention time.
- Browser session and artifact expiration.

Enforce limits during the download, not only after the complete file has occupied the disk.

Handle a nearly full disk safely. Interrupted or over-limit downloads must be stopped or rejected and cleaned up without corrupting unrelated files or disrupting the host.

Do not use unrestricted `docker exec`, shell commands based on user-supplied filenames, or direct access to the host Docker socket.

### 4. Validate artifacts before import

Check the actual file existence, size, and completion state. Validate any applicable content type and file metadata, but do not rely on file extensions alone.

Never treat arbitrary filesystem entries as importable artifacts. Do not permit artifact-ID substitution across users or sessions.

Make cancellation and cleanup safe if an import is already in progress. An artifact being uploaded must not be deleted prematurely.

### 5. Integrate with the existing upload flow

Add an **Import downloaded file** action to the completed-artifact UI.

On selection:
- Verify authentication, artifact ownership, completion status, and quota policy.
- Use the existing destination-selection behavior and upload queue.
- Reuse existing provider adapters, retries, progress reporting, and error handling.
- Do not add a second implementation for Google Drive or other providers.
- Prevent accidental duplicate queue submission where compatible with existing idempotency behavior.

Where the existing upload worker needs access to the artifact, use a controlled internal storage API or a narrowly scoped shared volume with strict path resolution and service isolation. Do not expose that storage interface publicly.

Remote browser downloading must remain distinct from the Direct/Cloudflare relay decision. A Worker 404 should not be silently treated as success, and Stage 3 must not weaken the existing SSRF or redirect protections.

### 6. Cleanup and recovery

Implement cleanup for:
- Successful imports.
- Failed or cancelled downloads.
- Failed or cancelled imports.
- Expired sessions.
- Expired artifacts.
- Orphaned incomplete files after container or worker restarts.

Cleanup must be idempotent and ownership-aware. Preserve artifacts while they are actively being uploaded.

Provide a bounded retention policy and safe recovery behavior after worker crashes. Do not delete unrelated data or existing user-managed files.

### 7. UI and operational visibility

Show:
- Download name and size when known.
- Download progress and lifecycle status.
- Failed/interrupted download state.
- Temporary storage quota or a useful limit error.
- Import progress and provider errors.
- Whether the temporary artifact has expired or been removed.

Use existing 9Drive UI and job-status conventions. Provide clear, non-sensitive diagnostics without logging full sensitive URLs, cookies, or raw credentials.

Document new environment variables, storage requirements, Docker volume configuration, quota defaults, and cleanup behavior.

## Tests

Add focused tests for:
1. In-progress downloads cannot be imported.
2. A completed artifact is listed only after validation.
3. Cross-user and cross-session artifact access is rejected.
4. Path traversal and symlink escapes are rejected.
5. File-size and storage quotas are enforced.
6. Interrupted downloads are cleaned up.
7. Active uploads are protected from premature cleanup.
8. Successful and failed imports trigger the correct retention behavior.
9. Cleanup is idempotent and handles orphaned incomplete files.
10. Provider uploads use the existing queue and adapters.
11. Browser download behavior does not expose internal filesystem paths.
12. Existing Direct Remote Import and normal provider uploads still work.

Use temporary test directories and mocked download/provider behavior. Do not require a real large download or live third-party website for ordinary automated tests.

## Non-Goals

- Do not implement a new provider uploader.
- Do not turn the browser container into a general-purpose file server.
- Do not expose local filesystem paths or unrestricted artifact download endpoints.
- Do not remove global storage limits or disable disk safeguards.
- Do not add automatic provider uploads without user confirmation.
- Do not refactor unrelated modules.

## Definition of Done

A user can trigger a download through their own remote browser, see the completed file as a 9Drive artifact, import it using the existing provider pipeline, and have temporary data cleaned up according to a bounded retention policy. Ownership, quotas, path safety, and failure recovery must be tested.

## Final Report

Summarize the storage design, lifecycle management, limits and defaults, provider integration, cleanup behavior, tests run, deployment changes, and remaining risks.