// Entry point for the dedicated Remote Import worker process
// (`npm run worker:remote-import`). Runs `startRemoteImportWorker()` which
// registers SIGINT/SIGTERM handling; the process stays alive processing jobs.
import { startRemoteImportWorker } from './worker.js'
import { startReconcileSweep } from './queue-reconcile.js'

const worker = startRemoteImportWorker()
// The sweep is owned by the worker process: it reconciles queued rows whose
// queue job was lost, and processing rows whose worker died (§35/§37). The
// API also does a cheap reconcile-on-read for stale `queued` rows.
startReconcileSweep()
console.log('[remote-import] worker started (concurrency ' + worker.concurrency + ')')