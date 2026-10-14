FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
# Zero runtime dependencies — no npm install needed. Kept as a no-op layer
# for panels that always run npm install; harmless when skipped.
# RUN npm install --omit=dev || true

COPY server.js ./

# Non-root runtime user (node user ships in the official image).
USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

CMD ["node", "server.js"]
