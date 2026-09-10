# Domain: Upload Routing

## Routing Modes

`UploadRoutingPolicy.mode` supports:

- `most_available` — choose the eligible account with the most available bytes; an existing physical folder location acts as a tie-break preference.
- `round_robin` — cycle through eligible accounts using a per-user cursor.
- `priority` — follow `priorityAccountIds` order.

## Eligibility

An account must:

- belong to the user;
- use a supported placement provider (`google_drive`, `s3`, `telegram`);
- not be `reauth_required`;
- be eligible through `autoAllocationEnabled`, unless an explicit pin is valid for the current flow;
- have sufficient capacity when capacity is known;
- for Telegram, have a configured channel and satisfy `fileSize <= TELEGRAM_MAX_FILE_BYTES`.

## Pin Semantics

- User-selected `targetAccountId`: soft preference; routing may fall back if the account lacks capacity.
- Folder ownership/provider constraint: may use a strict pin (`allowFallback=false`) so an upload is not routed to an account that cannot resolve the provider folder.

## Batch Preflight

`planBatchUploads()` builds an in-memory reservation map so multiple large files in one request are not all allocated against the same capacity snapshot. Reservations are not persisted; upload initialization validates placement again.

## Known Concurrency Limit
Cross-request quota overcommit remains possible when concurrent requests route against the same quota snapshot.

## Related Files

- `backend/src/modules/uploads/storage-routing.service.ts`
- `backend/src/modules/uploads/upload.routes.ts`
- `backend/src/modules/storage/folder-materialization.service.ts`
