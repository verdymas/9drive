# Runbook: Local Development

## Requirements

- Node.js 20+
- npm
- MySQL 8+
- Redis when testing Remote Import or Telegram queues
- FFmpeg/ffprobe when testing HLS

## Setup

Automated setup is available at the repository root:

```bash
bash ./setup.sh
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

## Backend

```bash
cd backend
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Default application port: 4000.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Ensure `VITE_API_URL` points to the backend and backend `FRONTEND_URL` matches the Vite origin so CORS succeeds.

## Remote Import Worker
When testing Remote Import without Docker, run the worker as a separate process:

```bash
cd backend
npm run worker:remote-import
```

Redis must be reachable through `REDIS_URL`.
