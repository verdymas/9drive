# ADR 0005: Remote Fetch Worker Is Transport Only

## Status
Accepted

## Decision
A Remote Fetch Worker is a network relay/transport used to retrieve remote resources from another region or network. It is **not** responsible for Remote Import orchestration.

The 9Drive backend/Remote Import worker remains responsible for:

- HLS parsing and selection;
- FFmpeg/remux processing;
- temporary files;
- storage routing;
- uploads to Google/S3/Telegram;
- progress and job state.

The remote worker is selected independently from the destination storage account and is stored in `RemoteImport.workerId` so retries use the same network route.

## Related Files

- `backend/src/modules/remote-fetch-workers/*`
- `backend/src/modules/remote-imports/transport.ts`
- `backend/src/modules/remote-imports/remote-import.service.ts`
- `backend/prisma/schema.prisma`
