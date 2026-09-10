# Integration: Redis + BullMQ

## Uses

1. `remote-import` queue — producer in the backend API; consumer in a dedicated Remote Import worker process/container.
2. `telegram-sync` queue — worker and scheduler run inside the backend API process.

## Config
`REDIS_URL`.

## Reliability Rules

- Graceful shutdown must close producer and worker connections.
- Reconcile database state with queue state; never use the queue as the sole source of truth.
- Remote Import heartbeat state is used to detect worker crashes/stalls.

## Core Files

- `backend/src/modules/remote-imports/queue.ts`
- `backend/src/modules/remote-imports/worker.ts`
- `backend/src/modules/telegram/telegram-sync.queue.ts`
- `backend/src/modules/telegram/telegram-sync.worker.ts`
- `backend/src/server.ts`
