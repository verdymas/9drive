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

## 4. Fetch Failure

- Direct mode: check SSRF/DNS/redirect/connect/idle timeout behavior.
- Protected source: check request-context/cookie scope and whether the feature is enabled.
- Remote-worker mode: test the worker through `/workers/:id/test` and inspect status/capabilities.

## 5. HLS Failure
Check manifest/segment limits and FFmpeg/ffprobe availability. Conversion errors can have a `retry-convert` path that differs from a full retry.

## 6. Destination Upload Failure
Check target-account status, Telegram channel configuration, quota, S3 credentials, Google reauthentication state, and folder materialization.

## Do Not
Do not manually change `RemoteImport.status` to “force completion” without understanding both the queue job and temporary artifacts. Doing so can create duplicate uploads or orphaned files.
