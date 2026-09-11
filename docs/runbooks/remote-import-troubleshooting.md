# Runbook: Remote Import Troubleshooting

## 1. Check API + Queue

```bash
curl http://localhost:4000/health
```

Inspect backend and worker logs. Confirm Redis is reachable and the worker process is running.
The worker process runs two consumers: `remote-imports-direct` and
`remote-imports-hls`. Check both when imports wait unexpectedly; their limits
are configured independently, but the per-user limit is shared.

## 2. Stuck `queued`
Possible causes:

- enqueue operation failed;
- Redis is unavailable;
- the queue job disappeared;
- the worker is not running.

The code includes queue reconciliation; read `queue-reconcile.ts` before manually editing database state.

## 3. Stuck `processing`
Check `heartbeatAt` and worker logs. The reconciliation sweep marks stale heartbeats according to `REMOTE_IMPORT_WORKER_HEARTBEAT_TIMEOUT_SECONDS`.

## 3a. Waiting for temporary storage

An import with `status: queued`, `stage: waiting`, and
`errorCode: RESOURCE_WAITING` is recoverable. Inspect free space on the volume
that contains `REMOTE_IMPORT_TEMP_DIR`; do not delete an active import's
artifacts. Adjust the free-space reserve or conservative unknown/HLS
reservation only after confirming the worker volume can safely support the
expected workload. The next delayed queue attempt rechecks capacity.
The stored diagnostic also includes current HLS segment and FFmpeg permit
limits, active holders, and queued waiters so capacity pressure can be
correlated with worker activity without exposing the source URL or credentials.

## 4. Fetch Failure

- Direct mode: check SSRF/DNS/redirect/connect/idle timeout behavior.
- Protected source: check request-context/cookie scope and whether the feature is enabled.
- Remote-worker mode: test the worker through `/workers/:id/test` and inspect status/capabilities.

For an eligible stream-through import, a source that ignores a requested range
falls back to the temporary-spool path before transfer starts. Do not manually
edit `stream_upload_state_encrypted`; it is encrypted, server-only recovery
state. Cancelling an active S3 stream-through import aborts its multipart
upload and removes its provisional file row.

## 5. HLS Failure
Check manifest/segment limits and FFmpeg/ffprobe availability. Conversion errors can have a `retry-convert` path that differs from a full retry.

If HLS imports are waiting under sustained load, inspect
`REMOTE_IMPORT_HLS_GLOBAL_SEGMENT_CONCURRENCY` and
`REMOTE_IMPORT_HLS_FFMPEG_CONCURRENCY` alongside per-job segment limits. Do
not raise only the per-job limit: the global caps protect the worker from jobs
collectively exhausting network, disk, or CPU resources.

## 6. Destination Upload Failure
Check target-account status, Telegram channel configuration, quota, S3 credentials, Google reauthentication state, and folder materialization.

## Do Not
Do not manually change `RemoteImport.status` to “force completion” without understanding both the queue job and temporary artifacts. Doing so can create duplicate uploads or orphaned files.
