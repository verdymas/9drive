# Phase 3 audit — Direct S3 multipart upload fast path

Inherited from the previous session (verified passing at start):
- env flags `S3_DIRECT_UPLOAD_ENABLED`, `_SESSION_TTL_SECONDS`, `_PART_SIZE_BYTES`, `_PART_URL_TTL_SECONDS`
- Prisma `UploadSession` s3 fields + migration `20260910000000_add_direct_s3_multipart_sessions`
- `direct-s3-upload.service.ts` init/sign/complete/abort/sweep with server-authoritative placement
- `direct-s3-upload.routes.ts` mounted at `/uploads/direct-s3` behind `requireAuth`
- Frontend lazily signs one part URL per iteration (no up-front batch signing)
- Initial tests: service (7), routes (2), frontend direct path (2)

Gaps closed this session:
- [x] Sweeper existed but was never scheduled — `startDirectS3UploadSweeper`
      (unref'd, only while the flag is enabled) now runs from `server.ts`, with
      an env-mock test proving the disabled-state guard.
- [x] `GET /uploads/resumable/status/:id` treated a `direct_s3_uploading`
      session via the local staged-temp path (always 0 bytes) and swept/aborted
      sessions ambiguously. New branch reports provider-truth progress through
      `directS3UploadedBytes` (backed by `listS3MultipartParts`, added to
      `s3.service.ts`), plus expiry, and terminal states. Route test:
      `upload.routes.direct-status.test.ts` (3 tests).
- [x] Completion now cross-checks each optional client-reported `sizeBytes`
      against the exact layout the server advertised for that slot (final-part
      aware), in addition to ordering/uniqueness/ETag validation and the
      provider `HEAD` total check. Route schema accepts `sizeBytes?`.
- [x] Direct completion refreshes destination-account quota
      (`syncS3Quota`), like every server-relayed path, so tracked usage stays
      truthful for bytes that never touched the backend.
- [x] Browser reports `sizeBytes` per part on complete; failed direct uploads
      register an empty resumable session so the Retry button replays them
      through the normal server path (old behavior only recorded sessions inside
      `uploadSingleFileResumable`, so a failed direct upload was unretryable).
- [x] Soft-pin reroute notice now exists on the direct path (was resumable-only).
- [x] Docs: uploads feature, direct-upload workflow, S3 integration,
      environment reference, `docs/runbooks/direct-s3-upload-recovery.md` (+
      index), docker template + compose env, AGENTS.md route note.

Notes:
- There is still no per-file "cancel" button in the upload panel for ANY
  provider (pre-existing product surface); "cancellation" here means:
  browser-side failure → server abort + provider `AbortMultipartUpload`,
  abandonment → sweeper, and both keep the session terminal-state observable.
  Progress and preflight/routing preservation are covered by tests.
- `getS3PresignedUploadPartUrl` intentionally keeps no `X-Amz-Content-Sha256`
  workaround: the installed SDK presigner already signs
  `UNSIGNED-PAYLOAD` for presigned PUTs.

Pre-existing repo issues (NOT caused by this phase), both fixed to get a green
frontend gate:
1. `NODE_ENV=production` inherited from the outer shell pins React to its
   production build, breaking every DOM test with `React.act is not a function`.
   Fixed by pinning `test.env.NODE_ENV = 'test'` in `frontend/vite.config.test.ts`.
2. `WorkersPage.test.tsx` "a failed provider delete…" used an insensitive
   `/^delete worker$/i` role query that matches both the row icon button
   (title `Delete worker`) and the modal confirm button (`Delete Worker`).
   Fixed with an exact-case query.
