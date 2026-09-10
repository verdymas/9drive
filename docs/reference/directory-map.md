# Directory Map

```text
backend/
  prisma/schema.prisma             Database model
  src/app.ts                       Express mount points
  src/server.ts                    Process startup/shutdown
  src/config/                      env + Prisma
  src/middleware/                  JWT/API-key/error middleware
  src/modules/
    auth/                          Authentication
    connected-accounts/            Provider connections
    google/                        Google Drive service
    s3/                            S3 service
    telegram/                      Telegram storage + synchronization
    storage/                       Generic storage summary/routing/folder abstraction
    uploads/                       Direct/resumable upload
    files/, folders/               Virtual filesystem REST
    sync/                          Provider→virtual reconciliation
    remote-imports/                URL/HLS background import
    remote-fetch-workers/          Remote network relay registry/drivers
    browser-capture/               Extension pairing/resources/import bridge
    webdav/                        Read-only WebDAV virtual FS
    smb/                           Samba management
    api-keys/, public-api/         External upload API
    public/, invites/              Sharing
    audit-logs/, system/           Admin/ops surfaces

frontend/
  src/App.tsx                      React routes
  src/pages/                       Route-level pages
  src/components/drive/            File/folder/upload UI
  src/components/settings/         Settings feature components
  src/context/UploadContext.tsx     Global upload state/progress
  src/lib/                         REST clients/helpers

extensions/browser-capture/        Browser extension

docs/                              Existing project notes + this agent KB
implementations/                    Historical implementation plans/prompts
```
