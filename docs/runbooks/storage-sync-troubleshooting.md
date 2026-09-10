# Runbook: Storage Sync Troubleshooting

## Manual Trigger

- all accounts: `POST /sync/all`
- one account: `POST /sync/account/:id`
- history: `GET /sync/runs`

## Diagnose

1. Check connected-account status and provider credentials.
2. Check the latest `SyncRun.errorCode/errorMessage` and counters.
3. For Google Drive, inspect API quota/reauthentication and retry behavior.
4. For S3, inspect bucket, endpoint, prefix, and credentials.
5. Confirm `SYNC_MAX_DEPTH` is not truncating a valid tree.
6. Check normalization/collision counters if the structure appears to be merged incorrectly.

## Safety
If a scan fails or is partial, do not run manual scripts that mark every object as missing. The synchronization implementation intentionally performs missing-object reconciliation only after a successful account scan.
