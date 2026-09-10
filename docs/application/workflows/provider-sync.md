# Workflow: Provider → Virtual Sync

```mermaid
flowchart TD
  Trigger[Sync all / account] --> Scan[Read provider tree/prefix]
  Scan --> Map[Normalize names + identities]
  Map --> Folders[Reconcile logical folders + locations]
  Folders --> Files[Create/update/move file rows]
  Files --> Missing{Scan completed successfully?}
  Missing -->|Yes| Reconcile[Mark missing mappings/files account-scoped]
  Missing -->|No| Skip[Do not mass-mark missing]
  Reconcile --> Run[Finalize SyncRun counters]
  Skip --> Run
```

## Provider Rules

- Google Drive scanning uses bounded BFS/listing.
- S3 scanning is derived from object prefixes.
- Synchronization is a discovery/reconciliation process, not an upload/delete engine.

## Race Safety
Account synchronization has cancellation/single-run protection at the service layer. Sync-All concurrency is bounded by `SYNC_ACCOUNT_CONCURRENCY`; folder listing concurrency is bounded by `SYNC_FOLDER_LIST_CONCURRENCY`.
