/**
 * Remote Fetch Worker module entry — registers installed drivers into the
 * registry. Importing this module is what pulls the driver implementations
 * into the running process, so app.ts must import it before mounting routes.
 */
import { registerDriver } from './driver-registry.js'
import { cloudflareWorkerDriver } from './drivers/cloudflare.js'
import { denoWorkerDriver } from './drivers/deno.js'
import { vpsWorkerDriver } from './drivers/vps.js'

registerDriver(cloudflareWorkerDriver)
registerDriver(denoWorkerDriver)
registerDriver(vpsWorkerDriver)

export { remoteFetchWorkerRouter } from './workers.routes.js'
export { listDriverMetadata } from './workers.driver-metadata.js'