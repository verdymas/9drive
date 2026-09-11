# Workflow: Remote Import

```mermaid
flowchart TD
  UI[Remote Import UI / Browser Capture] --> Probe[Probe / validate]
  Probe --> Create[Create RemoteImport row]
Create --> Queue{BullMQ workload queue}
Queue -->|direct| DirectWorker[Direct-import worker]
Queue -->|HLS| HlsWorker[HLS-import worker]
DirectWorker --> Worker[Shared Remote Import state machine]
HlsWorker --> Worker
Worker --> Capacity{Temp capacity available?}
Capacity -->|wait| Queue
Capacity -->|admitted| Fetch
Worker --> Fetch{Direct or Remote Fetch Worker}
  Fetch --> Type{Direct file or HLS}
  Type -->|Direct| Temp[Temp file/download]
  Type -->|Eligible direct range source| Stream[Bounded ranges → Google / S3]
  Type -->|HLS| HLS[Manifest + segments + FFmpeg]
  Temp --> Placement[Storage routing]
  Stream --> Register
  HLS --> Placement
  Placement --> Upload[Google / S3 / Telegram]
  Upload --> Register[Register File]
  Register --> Done[completed]
```

## Important Transitions

- Creation validates the selected worker first, then applies URL policy validation.
- Enqueue failure immediately marks the database row as failed.
- The worker sets `processing` and heartbeat only when execution starts.
- Cancel/retry operations coordinate persisted state with the queue job.
- Retry may resume from reusable stages/artifacts; a normal retry can fall back to downloading again.
- A reconciliation sweep detects queued-job mismatches and stale processing heartbeats.

## Secrets
Source URLs, request context, and resumable-upload secrets remain encrypted and must never appear in progress responses or logs.
