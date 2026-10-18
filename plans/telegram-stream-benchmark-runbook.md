# 9Drive — Telegram Stream Benchmark Runbook

Date: 2026-10-18
Purpose: reproduce the measurements in `reports/telegram-stream-performance-audit.md` and run the P2 prefetch A/B
(`plans/telegram-stream-optimization-roadmap.md`) on any deployment (local Docker or VPS).
Audience: operators/agents with shell access to the deployment host.

---

## 0. Safety, privacy, and budget rules

- **Never** paste real file names, Telegram message IDs, channel IDs, account IDs, session strings, or tokens into
  reports, tickets, or commit messages. Use size labels (`small`, `mid`, `large`) in write-ups.
- Budget per session: ≤1 GiB total transferred, ≤4 concurrent upstream readers, ≤3 repeats per heavy range.
  Stop the session immediately on the first `TELEGRAM_FLOOD_WAIT` (check `/ready` counters and logs).
- The Telegram account must be in status `connected`. A revoked session yields 503 `TELEGRAM_REAUTH_REQUIRED`
  and streams nothing — re-auth in the UI first.
- Downloads are read-only; never modify or delete files as part of benchmarking.

---

## 1. Prerequisites check

```bash
docker compose ps
docker compose exec -T telegram-stream python -c \
  "import urllib.request,json;print(json.dumps(json.load(urllib.request.urlopen('http://localhost:8081/health'))))"
docker compose exec -T telegram-stream python -c \
  "import urllib.request,json;print(json.dumps(json.load(urllib.request.urlopen('http://localhost:8081/ready'))))"
```

Expected: `status ok`; `/ready` counters listed (`active_streams`, `total_streams`, `total_cancellations`,
`total_file_reference_refreshes`, `total_flood_waits`). Record the starting values.

Verify the connected account is healthy (needs a user access token, §2):

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/connected-accounts \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);for(const i of (Array.isArray(d)?d:d.accounts||[]))if(i.provider==='telegram')console.log(i.status, i.telegram&&i.telegram.status)})"
```

Expected: `connected connected`.

### Long-idle sanity (keep-alive, P1)

Telethon keeps the MTProto connection warm with its own ping loop; 9Drive adds nothing. To attribute a recurring
cold start (audit: 671 ms ≈ credentials fetch + connect): leave the service idle ≥10 min with no reads, then run
one §4 read and read `resolve_ms` in `stream_end`:

- `resolve_ms` ≈ 0 → warm client + warm resolver cache (healthy).
- `resolve_ms` ≈ 130 ms (≈2× RPC RTT) → resolver TTL expired; raise `TELEGRAM_STREAM_RESOLVER_TTL_SECONDS` if
  seeks are frequent.
- `resolve_ms` ≈ 600 ms → a real reconnect; if it recurs while idle, treat it as a keep-alive regression, not
  TTFB noise.

(Resolver TTL clamps to 15–600 s; stale `file_reference` still invalidates immediately regardless of TTL.)

---

## 2. Auth for benchmark requests

### Option A — mint a short-lived token from an existing valid session (used in the audit)

Run inside the backend container (never prints the secret; prints only the token):

```bash
TOKEN=$(docker compose exec -T backend node -e '
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const p = new PrismaClient();
(async () => {
  const s = await p.userSession.findFirst({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!s) { console.error("NO_ACTIVE_SESSION"); process.exit(2); }
  process.stdout.write(jwt.sign({ sub: s.userId, sid: s.id }, process.env.JWT_ACCESS_SECRET, { expiresIn: 3600 }));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
' | tr -d '\r\n')
curl -s -o /dev/null -w "auth/me => %{http_code}\n" -H "Authorization: Bearer $TOKEN" http://localhost:4000/auth/me
```

### Option B — copy the access token from the browser session (localStorage) of a logged-in UI user.

### Option C — WebDAV basic-auth credentials, hitting `/webdav/<path>` instead of `/files/:id/download`.

---

## 3. Select test files by size (privacy-safe output)

Pick by size bucket; print IDs only into shell variables, never into reports.

```bash
FID() { docker compose exec -T backend node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const f = await p.file.findFirst({ where: { provider: "telegram", deletedAt: null, sizeBytes: BigInt(process.argv[1]) }, select: { id: true } });
  if (!f) { console.error("NO_FILE"); process.exit(2); }
  process.stdout.write(f.id); process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
' "$1" | tr -d '\r\n'; }

docker compose exec -T backend node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.file.findMany({ where: { provider: "telegram", deletedAt: null }, select: { sizeBytes: true }, orderBy: { sizeBytes: "desc" } })
  .then(f => { console.log("count", f.length, "max", String(f[0] && f[0].sizeBytes)); process.exit(0); });'

SMALL=$(FID 10771865)      # adjust to sizes present; audit used 10.77 MB
MID=$(FID 270906418)       # audit used 270.9 MB
LARGE=$(FID 1242834324)    # audit used 1.24 GB
LARGE_SIZE=1242834324
```

Expected output field: `count <n> max <bytes>`.

---

## 4. Cold and warm sequential reads

```bash
API=http://localhost:4000
W='code=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer} total=%{time_total} speed_Bps=%{speed_download} clen=%header{content-length}\n'

# Cold: first stream after a service restart or account re-auth (includes credentials fetch + MTProto connect)
curl -s -o /dev/null -w "$W" -H "Authorization: Bearer $TOKEN" "$API/files/$SMALL/download"

sleep 1.5
# Warm repeats
curl -s -o /dev/null -w "$W" -H "Authorization: Bearer $TOKEN" "$API/files/$SMALL/download"
curl -s -o /dev/null -w "$W" -H "Authorization: Bearer $TOKEN" "$API/files/$MID/download"
```

Expected baseline shape (audit): cold ttfb ≈ 0.67 s; warm ttfb ≈ 0.11–0.19 s; mid-file `speed_Bps` ≈ 1.9e6 (1.80 MiB/s).

---

## 5. Seek matrix (run against `$LARGE` with `$LARGE_SIZE`)

```bash
A="Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "first1MiB $W"   -H "$A" -r 0-1048575 "$API/files/$LARGE/download"
curl -s -o /dev/null -w "aligned32K $W"  -H "$A" -r 1048576-1081343 "$API/files/$LARGE/download"
curl -s -o /dev/null -w "unaligned32K $W" -H "$A" -r 1000000-1032703 "$API/files/$LARGE/download"
curl -s -o /dev/null -w "jellyfin33M $W" -H "$A" -r 41639936-75194367 "$API/files/$LARGE/download"   # repeat 3x
curl -s -o /dev/null -w "suffix256K $W"  -H "$A" -r -262144 "$API/files/$LARGE/download"
curl -s -o /dev/null -w "lastByte $W"    -H "$A" -r $((LARGE_SIZE-1))-$((LARGE_SIZE-1)) "$API/files/$LARGE/download"
curl -s -o /dev/null -w "reject416 $W"   -H "$A" -r ${LARGE_SIZE}- "$API/files/$LARGE/download"
curl -s -o /dev/null -w "malformed416 $W" -H "$A" -H "Range: bytes=foo" "$API/files/$LARGE/download"
```

Expected: exact `bytes=` values (1,048,576 / 32,768 / 32,704 / 33,554,432 / 262,144 / 1 / 416 JSON), `cr=` correct
`Content-Range` for 206. For 416, `Content-Range: bytes */<size>` should appear after P0/MF-1; before that fix it is
absent at the backend boundary (known defect).

### Wire constraints discovered by the P3 matrix (2026-10-18)

The Telegram server accepts an `upload.getFile` request only if (verified with a direct RPC probe, two rules, both
enforced by `telegram/engine.py`'s power-of-two plan):

1. `offset % 4096 == 0`;
2. `limit` is a **power-of-two multiple of 4 KiB** — 12/36/40/96/260/296 KiB got `LimitInvalidError` at a phase-0
   offset, while 4/8/16/64/128/256/512 KiB succeeded;
3. `(offset % 1 MiB) + limit <= 1 MiB` — no request may cross a 1 MiB window (512 KiB from offset 41,639,936 or
   999,424 failed; a request ending exactly at the window edge succeeded).

Health check for these rules on the matrix: every row 206 with exact `bytes=`, all `stream_end` rows
`iterator=_DirectDownloadIter` and `error=null`, `prefix_bytes` ≤ 4096, `total_file_reference_refreshes` unchanged.
Any `LimitInvalidError` in the logs means the plan regressed. To re-probe the rules live (metrics/behavior only —
no payload logging), fetch one chunk per candidate pair:

```bash
docker compose exec telegram-stream python - <<'EOF'
import asyncio
from app.telegram.engine import _iter_location, clients, resolver
async def main(provider, channel, msg):
    c = await clients.get_client(provider)
    loc = await resolver.resolve(c, provider, channel, msg)
    f, dc = _iter_location(loc)
    for offset, limit in [(1048576, 12288), (1048576, 65536), (999424, 8192), (999424, 65536)]:
        s = c.raw.iter_download(f, offset=offset, request_size=limit, chunk_size=limit, dc_id=dc)
        try: print("OK  ", offset, limit, len(await s.__anext__()))
        except Exception as e: print("FAIL", offset, limit, type(e).__name__)
        finally: await s.close()
asyncio.run(main("<provider>", "<channel>", <message>))
EOF
```

---

## 6. Concurrency (2 and 4 readers, disjoint ranges)

```bash
S=$(date +%s%3N)
curl -s -o /dev/null -w "c2_a $W" -H "$A" -r 50000000-66777215 "$API/files/$LARGE/download" &
curl -s -o /dev/null -w "c2_b $W" -H "$A" -r 70000000-86777215 "$API/files/$LARGE/download" &
wait
E=$(date +%s%3N); echo "wall_ms=$((E-S))"     # 32 MiB total; audit: ~13.6 s ⇒ 2.35 MiB/s aggregate
```

Repeat with 4 background curls (offsets 20M/60M/100M/140M, 32 MiB each). Audit: ~15.7 s for 64 MiB ⇒ 4.09 MiB/s.

---

## 7. Cancellation and stall check

```bash
curl -s -o /dev/null -w "cancel $W" --max-time 1.5 -H "$A" -r 200000000-267108863 "$API/files/$LARGE/download" || true
sleep 3
docker compose exec -T telegram-stream python -c \
  "import urllib.request,json;print(json.dumps(json.load(urllib.request.urlopen('http://localhost:8081/ready'))))"
```

Expected: `active_streams` returns to 0; `total_cancellations` +1; `stream_end` line for that request has
`"cancelled": true`.

---

## 8. Metric extraction (`stream_end` lines)

```bash
docker compose logs telegram-stream --since 30m --no-log-prefix 2>&1 \
  | grep '"event": "stream_end"' > /tmp/stream-end.jsonl
node -e '
const fs=require("fs");
const rows=fs.readFileSync("/tmp/stream-end.jsonl","utf8").trim().split(/\r?\n/).map(l=>JSON.parse(l))
  .map((o,i)=>({i:i+1,bytes:o.bytes,chunks:o.chunks,dur_ms:o.duration_ms,ttfb_ms:o.ttfb_ms,avg_mbps:o.avg_mbps,cancel:o.cancelled,err:o.error,st:o.status}));
console.table(rows);
const t=rows.map(r=>r.ttfb_ms).filter(Boolean).sort((a,b)=>a-b);
console.log("ttfb n="+t.length,"min="+t[0],"p50="+t[Math.floor(0.5*t.length)],"p90="+t[Math.floor(0.9*t.length)],"max="+t[t.length-1]);'
```

Expected fields per line: `bytes, chunks, duration_ms, ttfb_ms, avg_mbps, cancelled, error, status, range,
resolve_ms, dc_id, iterator, prefetch_depth` (P0 fields), `prefix_bytes` (P3).
Sanity rule: `bytes` must equal the requested range length; for already-grid-aligned starts
`chunks == ceil((prefix + length) / 512 KiB)`, while unaligned starts get a power-of-two head (P3) so `chunks` can
be higher while every chunk is ≤ 512 KiB and `prefix_bytes` ≤ 4096.
Error lines to watch: `stream_truncated`, `stream_failed`, `stream_resolve_failed` (`error_code` field).

Also compare ingress timings against curl: `curl ttfb − service ttfb_ms` ≈ backend hop (audit: 8–17 ms).

---

## 9. Telegram DC RTT probe (in-container, no code changes)

Write the following to `/tmp/dc-probe.py` on the host, then run it with the account ID and one channel/message pair
(IDs are used as arguments only; do not record them in reports). Reuses the service's own credential path.

```python
import asyncio, json, sys, time
from app.telegram.credentials import fetch_credentials
from telethon import TelegramClient, functions
from telethon.sessions import StringSession

async def main(provider_id, channel_id, message_id):
    cred = await fetch_credentials(provider_id)
    client = TelegramClient(StringSession(cred.session), cred.api_id, cred.api_hash)
    t0 = time.perf_counter(); await client.connect(); t1 = time.perf_counter()
    info = {"connect_ms": round((t1-t0)*1000,1), "home_dc_id": client.session.dc_id,
            "authorized": await client.is_user_authorized()}
    rtts = []
    for _ in range(6):
        s = time.perf_counter(); await client(functions.help.GetConfigRequest())
        rtts.append(round((time.perf_counter()-s)*1000,1))
    info["home_dc_rpc_rtt_ms"] = rtts
    try:
        e = await client.get_input_entity(int(channel_id))
        msgs = await client.get_messages(e, ids=[int(message_id)])
        doc = msgs[0].document if msgs else None
        info["doc_dc_id"] = getattr(doc, "dc_id", None)
    except Exception as exc:  # noqa: BLE001
        info["doc_error"] = type(exc).__name__
    await client.disconnect()
    print(json.dumps(info))

asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
```

```bash
docker compose exec -T telegram-stream python - "<PROVIDER_ID>" "<CHANNEL_ID>" "<MESSAGE_ID>" < /tmp/dc-probe.py
```

Expected output fields: `connect_ms`, `home_dc_id`, `authorized`, `home_dc_rpc_rtt_ms` (audit: median 67 ms on DC5),
`doc_dc_id`. If the document DC differs from the home DC, a media-DC RTT is a follow-up probe (exported sender).

---

## 10. Resource sampling

```bash
# during a long read:
docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}" 9drive-telegram-stream-1 9drive-backend-1
# repeated 1/s while a 64 MiB range downloads
```

Audit reference: telegram-stream 104–107 MiB RSS flat (limit 512 MiB); CPU bursts ≤ ~15%; backend ≤ ~14%.

---

## 11. Offline test suite (regression net)

```bash
docker run --rm -v "$PWD/services/telegram-stream:/app" -w /app python:3.11-slim sh -c \
  "pip install -q -r requirements.txt pytest==8.3.4 pytest-asyncio==0.25.0 httpx==0.28.1 && python -m pytest -q"
```

Expected: `63 passed` (55 after the audit; +2 P0, +6 P1 tests). On Windows git-bash prefix with `MSYS_NO_PATHCONV=1`
if the `-w /app` path is mangled.

---

## 12. P2 prefetch A/B protocol and go/no-go

1. Record `TELEGRAM_STREAM_PREFETCH_DEPTH` current value (`docker compose exec -T telegram-stream printenv | grep PREFETCH`).
2. Depth 0 baseline: 3 runs of the 33.55 MiB range + 3 runs of a 64 MiB range; capture `avg_mbps`, `ttfb_ms` from §8.
3. Set depth 2 (`docker compose up -d telegram-stream` after editing env), repeat the block; 60 s pause.
4. Check `/ready`: `total_flood_waits` must remain 0 and all lengths exact before continuing.
5. If depth 2 passed the gate, test depth 3 the same way; otherwise stop.
6. Restore the flag to 0 if any run shows FloodWait, byte mismatch, or p95 TTFB regression >20%.

Gate (from the roadmap): median `avg_mbps` improvement ≥30% on both workloads, p95 TTFB ≤ +20% vs baseline, 0 FloodWait,
100% byte-exactness.

---

## 13. Expected output fields cheat-sheet

| Source | Fields |
|---|---|
| `curl -w` | `code`, `bytes` (`size_download`), `ttfb` (`time_starttransfer`), `total`, `speed_Bps`, header probes (`%header{content-range}`) |
| `stream_end` (JSON log) | `request_id`, `bytes`, `chunks`, `duration_ms`, `ttfb_ms`, `avg_mbps`, `cancelled`, `error`, `status`, `range`, `resolve_ms`, `dc_id`, `iterator`, `prefetch_depth`, `prefix_bytes` |
| `/ready` | `status`, `active_streams`, `total_streams`, `total_cancellations`, `total_file_reference_refreshes`, `total_flood_waits`, `total_cdn_redirects`, `prefetch_depth_configured` |
| DC probe | `connect_ms`, `home_dc_id`, `doc_dc_id`, `home_dc_rpc_rtt_ms[]` |
| `docker stats` | `MemUsage`, `CPUPerc` |

---

## 14. Troubleshooting

| Symptom | Meaning | Action |
|---|---|---|
| 503 `TELEGRAM_REAUTH_REQUIRED` | Session revoked; account flagged | Re-auth the account in the UI; verify §1 account status |
| 502 `TELEGRAM_LAYER_MISMATCH` | Telethon/backend layer mismatch (`error_code` in logs) | Align dependency pins; do not retry-loop |
| 416 on a valid range | Range parsed wrong or size mismatch | Check `knownSize` vs actual size; capture the request `range` and `Content-Range` |
| 429 `TELEGRAM_FLOOD_WAIT` | Upstream rate limit; `Retry-After` in the message | Stop the session; wait the indicated time; do not parallelize deeper |
| `active_streams` stuck > 0 | Orphaned stream | Capture `stream_end`/`stream_failed` lines; restart telegram-stream if persistent |
| `stream_truncated` / `SHORT_READ` | Telegram returned fewer bytes than recorded | Investigate size drift between DB and Telegram; keep the strict failure (do not silence) |
| `LimitInvalidError` on a seek | Request plan violates the power-of-two limit or 1 MiB window rules (§5) | Re-run the §5 probe; check `engine.py` plan changes against `tests/test_engine.py`'s `AlignedDownload` |
| TTFB ≈ 3 s+ outlier | Upstream stall/latency spike (not the iterator class) | Re-run once; if recurring, record time-of-day and DC; consider P2 prefetch |
