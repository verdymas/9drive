FROM node:20-alpine AS base

WORKDIR /app

# Build context is the repo root (see docker-compose.yml) — prefix backend/.
COPY backend/package*.json ./
COPY backend/prisma ./prisma

RUN npm ci

# FFmpeg + ffprobe for HLS remote imports (§15). The API process itself never
# spawns FFmpeg (only the worker does), but both services share this image and
# `verifyFfmpegAvailable` bails with FFMPEG_NOT_AVAILABLE if the binaries are
# missing — installing them here keeps the worker image self-contained.
RUN apk add --no-cache ffmpeg

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
# Browser Capture extension source — served as a zip at /browser-capture/extension.zip.
COPY extensions ./extensions

RUN npm run build && npx prisma generate

EXPOSE 4000

CMD ["sh", "-c", "npm run db:migrate:deploy && npm run seed:google-config:docker && node dist/server.js"]
