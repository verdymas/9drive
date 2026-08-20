FROM node:20-alpine AS base

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

# FFmpeg + ffprobe for HLS remote imports (§15). The API process itself never
# spawns FFmpeg (only the worker does), but both services share this image and
# `verifyFfmpegAvailable` bails with FFMPEG_NOT_AVAILABLE if the binaries are
# missing — installing them here keeps the worker image self-contained.
RUN apk add --no-cache ffmpeg

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build && npx prisma generate

EXPOSE 4000

CMD ["sh", "-c", "npm run db:migrate:deploy && npm run seed:google-config:docker && node dist/server.js"]
