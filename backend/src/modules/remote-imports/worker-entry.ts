// Entry point for the dedicated Remote Import worker process
// (`npm run worker:remote-import`). Runs `startRemoteImportWorker()` which
// registers SIGINT/SIGTERM handling; the process stays alive processing jobs.
import { startRemoteImportWorker } from './worker.js'

const worker = startRemoteImportWorker()
console.log('[remote-import] worker started (concurrency ' + worker.concurrency + ')')
