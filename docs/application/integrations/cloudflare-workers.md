# Integration: Cloudflare Worker Relay

## Purpose
Managed Remote Fetch Worker driver used to access remote sources through the Cloudflare edge network.

## Boundary
A Cloudflare Worker only fetches/relays resources according to the relay protocol. Download orchestration, HLS/FFmpeg processing, temporary storage, and destination uploads remain in the 9Drive Remote Import worker.

## Core Files

- `backend/src/modules/remote-fetch-workers/drivers/cloudflare.ts`
- `drivers/cloudflare-relay.ts`
- `transports/cloudflare-transport.ts`
- `relay-protocol.ts`

## Config

- `CLOUDFLARE_API_BASE`
- `CLOUDFLARE_DEPLOY_TIMEOUT_SECONDS`
- per-worker credentials/configuration are stored encrypted in the database.

## Cookie forwarding

Cookie-bearing imports use `9drive-relay-v2-cookie`. The Worker returns upstream redirects without following them; the backend validates every hop and recomputes Cookie against the original import source origin. HLS child requests use the same origin anchor. Requests without Cookie retain the v1 protocol.

Existing deployed relays must be redeployed before Cookie-bearing imports can use them. Older relays reject the new protocol; they continue to serve imports without Cookie.
