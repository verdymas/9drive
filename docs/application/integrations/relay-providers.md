# Integration: Relay Providers (free-tier)

## Purpose
Verified $0 relay options for Remote Import when the local network cannot reach a source. Same `9drive-relay-v1` wire for every provider (streaming, Range, HMAC, status/error semantics, cancellation). No automatic failover between providers or to Direct.

## Selectable providers

### Cloudflare Workers Free (existing, managed)
- 100,000 requests/day; 10 ms CPU/invocation (network wait excluded); 128 MB; 50 subrequests/invocation; no enforced response-body cap.
- Hard stop: Error 1027 until midnight UTC reset.
- 9Drive safety default: ~2.4M requests/month equivalent (~80% of daily cap × 30).
- Source: https://developers.cloudflare.com/workers/platform/limits/

### Deno Deploy Free (manual endpoint, this phase)
- 1M requests/month; 20 GiB egress/month — **egress is binding for media**.
- Deploy `backend/src/modules/remote-fetch-workers/drivers/deno-relay/worker.ts` as a Deno app, set `RELAY_SECRET`, register the app URL + secret (Service: Deno Relay, HMAC).
- Managed auto-provisioning deferred; manual only.
- Hard stop: deployment pause at quota until reset/upgrade.
- 9Drive safety defaults: 800k requests/month, 16 GiB egress/month.
- Wall-clock duration has no fixed documented cap on the current platform — large/long transfers require the manual smoke test below before being trusted.
- Sources: https://deno.com/deploy/pricing, https://docs.deno.com/deploy/

## Evaluated but not selectable

### Vercel Hobby (evaluate-only, no driver ships)
- Personal, non-commercial use only; 120 s proxied-request timeout; Fluid Hobby max duration 300 s; hard pause at limits.
- Not dependable for long-running/large-file transfers without proof. No code ships in this task.
- Sources: https://vercel.com/docs/plans/hobby, https://vercel.com/docs/limits

### Netlify Free (excluded)
- 60 s synchronous execution; 20 MB streamed-response cap. Incompatible with general large-media relay.
- Source: https://docs.netlify.com/build/functions/configuration/

## Safety budgets
- Stored per worker (`reqBudgetMonthly`, `egressBudgetBytesMonthly`; blank = driver default above) and accounted monthly in `remote_fetch_worker_usage`.
- Enforced before the first relay request and while streaming (abort with `WORKER_BUDGET_EXHAUSTED`). Retries and failures count toward the request budget. Approaching (≥80%) is logged and shown in the UI.
- 9Drive budgets cannot account for unrelated traffic in the same external account — keep a margin. Providers can change plans; never assume permanent free availability.

## Manual smoke test (per provider, before trusting large transfers)
1. Deploy the relay template; set the secret; register in Workers.
2. `POST /workers/:id/test` → healthy + `9drive-relay-v1` capabilities.
3. Remote Import probe of a small public file via the worker → 200.
4. Ranged GET (`bytes=0-0`) → 206 with intact `content-range`.
5. Missing object → upstream 404 surfaced as import failure on the worker route (no Direct line with the same `traceId`).
6. Redirect URL → final host reported, query shape preserved.
7. Multi-GB or hour-long transfer (Deno): verify no platform timeout and egress accounting in `GET /workers/:id/usage`.
8. Budget: lower the worker budget to 1 request / 1 byte, confirm the next import fails with `WORKER_BUDGET_EXHAUSTED` and usage stops.
