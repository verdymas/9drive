# Domain: Remote Import

## Purpose
Import an HTTP(S) resource or HLS/M3U8 stream without requiring the browser to upload the source bytes directly to the backend.

## Entity
`RemoteImport` stores the encrypted source, safe display URL, canonical filename, optional request context, destination, optional network worker, HLS selection, progress, queue metadata, retry metadata, and error state.

## Lifecycle

Primary implementation statuses:

```text
queued → processing → completed
                   ↘ failed
                   ↘ cancelled
```

`stage` provides finer-grained progress. Retry logic recognizes stages such as `downloading`, `segments`, `remuxing`, `uploading`, `registering`, and final `finished`.

## Security Rules

- The original URL is stored encrypted; APIs and logs use a display-safe form.
- Direct mode performs SSRF validation, including DNS resolution.
- Relay mode still validates URL syntax and policy, but the backend does not need to resolve a hostname it will not contact directly.
- Cookie/Referer/Origin/User-Agent request context is encrypted and constrained by size and scope.
- Never log full source URLs, cookies, bearer tokens, or raw request context.

## Filename Rule
Explicit user filename > probe-detected filename > URL fallback. The selected filename is always sanitized again when the import is created. For HLS, the final extension must match the output container.

## Related Files

- `backend/src/modules/remote-imports/remote-import.service.ts`
- `backend/src/modules/remote-imports/processor.ts`
- `backend/src/modules/remote-imports/ssrf.ts`
- `backend/src/modules/remote-imports/request-context.ts`
- `backend/prisma/schema.prisma`
