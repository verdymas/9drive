# Status Vocabularies

Many status values are plain strings rather than Prisma enums. Before changing any vocabulary, search across backend, frontend, and tests.

## Remote Import

Main status: `queued`, `processing`, `completed`, `failed`, `cancelled`.

Important pipeline/retry stages: `waiting`, `downloading`, `segments`, `remuxing`, `uploading`, `registering`, `finished`.

## SyncRun
`running | completed | failed | cancelled`.

## Browser CapturedResource
`pending | consumed | expired | deleted`.

## Remote Fetch Worker
`unknown | healthy | unhealthy | disabled | provisioning | provision_failed`.

## TelegramSyncState
`never_synced | syncing | up_to_date | changes_detected | needs_attention | sync_failed`.

## TelegramSyncRun
`running | completed | failed | cancelled`.

## TelegramSyncIssue.kind

- `ORPHAN_REMOTE_FILE`
- `REMOTE_FILE_MISSING`
- `TELEGRAM_METADATA_MISMATCH`

## Connected Account
The code uses values such as `connected` and `reauth_required`. Search all comparisons before adding or changing account statuses.
