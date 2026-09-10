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
