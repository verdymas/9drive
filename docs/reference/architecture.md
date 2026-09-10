# Architecture Reference

## Components

```mermaid
flowchart TB
  Browser[React/Vite Frontend] -->|JWT REST| API[Express API :4000]
  Extension[Browser Capture Extension] -->|Device token REST| API
  Client[WebDAV Client] -->|WebDAV auth| API
  API --> DB[(MySQL / Prisma)]
  API --> Redis[(Redis)]
  API --> GD[Google Drive]
  API --> S3[S3-compatible]
  API --> TG[Telegram]
  API --> Samba[Samba daemon/config]
  API --> CF[Cloudflare API / Relay]
  Redis --> RI[Remote Import Worker]
  RI --> GD
  RI --> S3
  RI --> TG
  RI --> CF
  RI --> FFMPEG[FFmpeg / ffprobe]
  RI --> TMP[(remote import temp volume)]
```

## Main Processes

### Backend API
`backend/src/server.ts` → `app.ts`. Serves REST/WebDAV, starts the Telegram Sync worker and scheduler, and acts as the producer for the Remote Import queue.

### Remote Import Worker
Entry point: `backend/src/modules/remote-imports/worker-entry.ts`. This dedicated process/container consumes the queue, downloads/remuxes content, and uploads it to the destination storage provider.

### Frontend
React Router application defined in `frontend/src/App.tsx`, served by the Vite dev server or the production nginx image.

### Browser Extension
The manifest extension in `extensions/browser-capture/` captures media/resources and communicates with the Browser Capture API.

## Persistence

- MySQL: logical state, provider/account metadata, encrypted credentials, jobs, and audit data.
- Redis: queue/runtime coordination; it is not canonical business state.
- Remote Import temp volume: ephemeral/resumable staging.
- Storage providers: physical file bytes.
