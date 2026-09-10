# Feature: Sharing and Preview

## Public Share

- An authenticated user creates/revokes shares through `/files/:id/share`.
- Public consumers use `/public/files/:token`, `/download`, or `/preview`.
- Frontend routes: `/public/files/:token` and `/public/files/:token/embed`.

## Preview Token
`POST /files/:id/preview-token` creates a short-lived token for provider-neutral streaming through `GET /files/preview/:token`.

## Google Public Permission
`POST /files/:id/public-permission` is a Google-specific bridge for provider public links.

## Data Models

- `FileShare`
- `FilePreviewToken`
- `WorkspaceInvite` for file/folder viewer/editor invitations.

## Security
Do not store or log share/preview tokens as plaintext after creation when the model uses a hash. Public endpoints must resolve only active, non-expired records.
