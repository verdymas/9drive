# Workflow: Direct Upload

```mermaid
flowchart LR
  UI[React UploadContext] --> API[/uploads]
  API --> Route[Storage routing]
  Route --> Folder[Ensure physical folder]
  Folder --> Provider{Provider}
  Provider -->|Google| GD[Google resumable/direct]
  Provider -->|S3| S3[S3 upload]
  Provider -->|Telegram| TG[Telegram document]
  GD --> DB[(File + quota/audit)]
  S3 --> DB
  TG --> DB
```

## Steps

1. The frontend collects the file plus destination folder/account preference.
2. Optional batch preflight plans placement using per-request reservations.
3. The backend selects an eligible account using the routing policy.
4. The destination logical folder is materialized on the target provider when necessary.
5. Bytes are uploaded using the provider-specific path.
6. A `File` row is registered with the physical provider identity.
7. Usage/quota and audit metadata are updated according to the provider flow.

## Failure Boundary
Do not create an active `File` database row before the provider upload succeeds. If an upload session fails, preserve observable/retryable status and error state without creating a phantom file.

## Multipart Compatibility Boundary

The compatibility multipart route resolves metadata and response aggregation
separately from provider execution. It supports either one metadata field set
or `filesMeta` batch metadata, preserves the single-file `{ file }` response,
and reports batches as `{ files, failed }`. Declared sizes are required before
the corresponding file part, constrained by `MAX_UPLOAD_BYTES`, and checked
against bytes received. Provider routing still uses the same placement service
as resumable uploads; this workflow does not change the dashboard's resumable
path.

Multipart bytes are staged through a bounded, session-scoped spool under
`UPLOAD_TEMP_DIR` before provider transfer. Google and S3 receive a read stream
from that spool, while Telegram uses its required file path. Client aborts
cancel the spool and supported Google/S3 transfers, then mark the upload
session failed and remove the staged file.
