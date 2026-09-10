# Frontend Route Reference

Source: `frontend/src/App.tsx`.

## Public

| Route | Page |
|---|---|
| `/login` | `LoginPage` |
| `/register` | `RegisterPage` |
| `/google-auth` | `GoogleAuthPage` |
| `/google-connected` | `GoogleConnectedPage` |
| `/public/files/:token` | `PublicFilePage` |
| `/public/files/:token/embed` | `PublicFilePage embed` |

## Protected under `DriveLayout`

| Route | Page |
|---|---|
| `/all-files` | `AllFilesPage` |
| `/quota` | `QuotaTrackerPage` |
| `/shared` | `SharedPage` |
| `/recent` | `RecentPage` |
| `/starred` | `StarredPage` |
| `/archived` | `ArchivedPage` |
| `/trash` | `TrashPage` |
| `/activity` | `ActivityLogPage` |
| `/settings` | `SettingsPage` |
| `/api` | `ApiManagementPage` |
| `/smb` | `SmbPage` |
| `/storage/webdav` | `WebDavPage` |
| `/remote-imports` | `RemoteImportsPage` |
| `/workers` | `WorkersPage` |

The index and unknown routes redirect to `/all-files`. The entire application is wrapped in `UploadProvider`.
