# Runbook: Direct S3 Upload Recovery

Scope: the optional `S3_DIRECT_UPLOAD_ENABLED` fast path
(`/uploads/direct-s3/*`). If the flag is `false` (the default), none of this
applies — uploads use the server-relayed resumable path.

## Symptom: files show “Direct S3 upload session expired.” / stuck uploads after reload

1. Confirm the account placement was S3 and the feature flag state in the
   backend environment.
2. Open the file row state: direct sessions create the `File` row only after
   provider completion + size verification, so an expired/aborted session
   leaves no active file by design — the user re-uploads.
3. In-flight progress for a `direct_s3_uploading` or `aborted` `UploadSession`
   is visible via `GET /uploads/resumable/status/:id`; the offset is the sum of
   parts the provider actually holds.
4. The sweeper (active only while the flag is on, unref'd 5-minute interval)
   aborts expired provider multipart uploads and marks sessions `failed`.
   Restarts re-sweep immediately on the next tick.

## Symptom: object left behind in the bucket after a failed completion

Completion verifies `HEAD` size against the session; on mismatch the backend
deletes the object and marks the session failed (best-effort — a deletion
failure logs and continues). Grep backend logs for
`DIRECT_UPLOAD_SIZE_MISMATCH` / `Could not complete direct S3 upload` and
compare `upload_sessions.s3_object_key` against the bucket to confirm cleanup;
delete leftovers manually if the provider was unreachable at that moment.

## Rollback

Set `S3_DIRECT_UPLOAD_ENABLED=false` and restart the backend. No migration
rollback is needed: the nullable `UploadSession` S3 columns stay, in-flight
sessions simply expire and are swept (or finish via their already-issued part
URL flows), and every client-side path falls back to the resumable upload.
