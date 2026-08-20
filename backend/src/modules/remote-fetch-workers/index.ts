/**
 * Remote Fetch Worker module entry — registers installed drivers into the
 * registry. Importing this module is what pulls the driver implementations
 * into the running process, so app.ts must import it before mounting routes.
 */
import { registerDriver } from './driver-registry.js'
import { cloudflareWorkerDriver } from './drivers/cloudflare.js'

registerDriver(cloudflareWorkerDriver)

export { remoteFetchWorkerRouter } from './workers.routes.js'
export { listDriverMetadata } from './workers.driver-metadata.js'