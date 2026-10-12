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

## 4a. Worker-relay 404 correlation (`traceId` / `urlFp`)

Each transport operation carries an op-scoped `traceId` (`<jobId>:<op>`, e.g.
`3565f20e…:download`, `…:probe-range`, `…:stream-<off>-<len>`) in the relay
payload. Backend (`[remote-import:transport]`, `[remote-import:fetcher]`,
`[remote-import:route]`) and Worker (`[relay]`) logs join on `traceId`.
`urlFp` (12-hex sha256 of the canonical href, computed identically both
sides) proves backend ↔ Worker URL identity without exposing signed URLs;
only hosts, `queryKeys`, header NAMES, and safe `reason`/`kind` codes are
logged — never query values, cookies, or bodies.

- `validation_rejected … relayHttpStatus=400 upstreamStatus=none
  fetchExecuted=false` → Worker validation (endpoint/payload/URL policy
  stage). Backend maps to `WORKER_RELAY_PROTOCOL_ERROR`.
- `upstream_response … upstreamStatus=404 relayHttpStatus=200
  fetchExecuted=true` → the SOURCE answered 404 through a healthy relay.
  Backend surfaces `DOWNLOAD_HTTP_ERROR` with that upstream status.
- `upstream_fetch_failed … relayHttpStatus=502 upstreamStatus=none
  kind=DNS_FAILURE|TLS_ERROR|CONNECT_FAILURE|TIMEOUT|…` → no upstream
  response exists; backend maps to `WORKER_UPSTREAM_FETCH_FAILED`, never 404.
- Relay endpoint `handler=not-found … relayHttpStatus=404
  fetchExecuted=false` → wrong path/method; backend maps to
  `WORKER_UNHEALTHY`, never to an upstream 404.
- A Worker-selected job logs `[remote-import:route] route=worker …` once and
  stays on Worker for probe/download/range/retries. A `route=direct` line
  after a Worker error is a separate job/operation (check its own `traceId`),
  not a fallback — there is no automatic Worker→Direct fallback. Direct-only
  HLS/materializer fallbacks log `route=direct-fallback` explicitly for the
  same attribution.

## 4b. Worker safety budgets (free-tier guard)

- `GET /workers/:id/usage` shows monthly `requests/egressBytes/failures`
  against the configured safety budget (bigints as strings) plus
  `exhausted/approaching` flags. The Workers page shows the same summary.
- Exhausted workers reject new imports with `WORKER_BUDGET_EXHAUSTED`
  before any relay request (stays on its route — never Direct, never another
  provider). Egress is also enforced mid-stream: large bodies abort with the
  same code instead of silently exceeding the free tier.
- Retries and failed attempts count toward the request budget.
- 9Drive budgets cannot see unrelated traffic in the same provider account;
  keep a conservative margin. Providers hard-stop at their own limits
  (Cloudflare Error 1027; Deno deployment pause; Vercel deployment pause).

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
